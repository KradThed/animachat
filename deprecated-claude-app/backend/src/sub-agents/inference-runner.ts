/**
 * Inference Runner
 *
 * Executes a single sub-agent task lifecycle:
 *   1. Build context from parent conversation + branch events
 *   2. Call LLM (with tool loop handled by Membrane internally)
 *   3. Append result to branch event store
 *   4. Return summary and metrics
 *
 * Sub-agents CANNOT spawn their own sub-agents (depth=1 limit).
 * The tool loop (tool_use → execute → tool_result → re-infer) is handled
 * inside Membrane's generate() call, so run() calls LLM once per iteration.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Database } from '../database/index.js';
import type { BranchEventStore } from '../database/branch-event-store.js';
import type { Event } from '../database/persistence.js';
import { LLMClientAdapter } from './llm-client-adapter.js';
import { SubAgentContextBuilder } from './context-builder.js';
import { buildToolOptions } from '../websocket/handler.js';
import type { ResourceCoordinator } from '../services/resource-coordinator.js';
import { createGuardedExecuteTool } from '../services/write-tool-guard.js';
import type { McplHookManager, InferenceHookContext } from '../services/mcpl-hook-manager.js';
import type { SubAgentTask, TaskMetrics } from './types.js';
import { MAX_ITERATIONS } from './types.js';
import { SUB_AGENT_TOOL_NAMES, MCPL_MANAGEMENT_TOOL_NAMES } from './sub-agent-tools.js';
import { normalizeInjectionContent } from '@deprecated-claude/shared';
import { applyUserInjections } from '../utils/message-helpers.js';

// =============================================================================
// Types
// =============================================================================

export interface RunnerResult {
  summary: string | null;
  metrics: TaskMetrics;
}

// =============================================================================
// Runner
// =============================================================================

export class InferenceRunner {
  private abortController = new AbortController();
  private cancelled = false;

  constructor(
    private task: SubAgentTask,
    private llmClient: LLMClientAdapter,
    private contextBuilder: SubAgentContextBuilder,
    private branchStore: BranchEventStore,
    private db: Database,
    private resourceCoordinator?: ResourceCoordinator,
    private hookManager?: McplHookManager,
  ) {}

  /**
   * Run the sub-agent inference loop.
   * Returns when the LLM produces a final text response (no more tool calls).
   */
  async run(): Promise<RunnerResult> {
    const startTime = Date.now();
    const metrics: TaskMetrics = {
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      durationMs: 0,
    };

    try {
      // Build initial context (BUG 5: forkPoint/forkBranchId stored in task, not passed to builder)
      const context = await this.contextBuilder.buildContext({
        conversationId: this.task.conversationId,
        userId: this.task.userId,
        taskId: this.task.taskId,
        taskInstruction: this.task.instruction,
        taskContext: this.task.context,
      });

      // Build tool options — exclude sub-agent tools (depth=1 limit)
      const toolOpts = buildToolOptions(
        this.task.userId,
        context.conversation,
        context.participants.find(p => p.type === 'assistant'),
        this.db,
      );

      // BUG T-5: Import SUB_AGENT_TOOL_NAMES + MCPL_MANAGEMENT_TOOL_NAMES from sub-agent-tools.ts
      // Filter out sub-agent tools (depth=1 limit) AND MCPL management tools (privilege escalation)
      // Wrap executeToolCall with write lock guard (ResourceCoordinator)
      const filteredToolOptions = toolOpts
        ? {
            tools: toolOpts.tools.filter((t: any) =>
              !SUB_AGENT_TOOL_NAMES.has(t.name) && !MCPL_MANAGEMENT_TOOL_NAMES.has(t.name)
            ),
            executeToolCall: this.resourceCoordinator
              ? createGuardedExecuteTool(
                  this.task.userId,
                  this.resourceCoordinator,
                  toolOpts.executeToolCall,
                )
              : toolOpts.executeToolCall,
          }
        : undefined;

      // Get model config from first assistant participant
      const assistantParticipant = context.participants.find(p => p.type === 'assistant');
      if (!assistantParticipant?.model) {
        throw new Error('No assistant participant with model found');
      }

      // Resolve model config
      const { ModelLoader } = await import('../config/model-loader.js');
      const modelLoader = ModelLoader.getInstance();
      const modelConfig = await modelLoader.getModelById(assistantParticipant.model, this.task.userId);
      if (!modelConfig) {
        throw new Error(`Model ${assistantParticipant.model} not found`);
      }

      const settings = assistantParticipant.settings || {
        temperature: 1,
        maxTokens: 4096,
      };

      // Single inference call — Membrane handles the tool loop internally
      metrics.iterations = 1;

      // Feature E: Token budget → derive maxToolCalls heuristic
      // ~1500 tokens/tool-call is a rough average. Tools returning large file contents
      // may use far more. The post-hoc budgetExceeded flag is the real signal;
      // this heuristic provides best-effort indirect capping.
      let effectiveMaxToolCalls = 30; // Default hard safety cap
      if (this.task.tokenBudget) {
        effectiveMaxToolCalls = Math.min(30, Math.max(1, Math.floor(this.task.tokenBudget / 1500)));
        console.log(`[InferenceRunner] Task ${this.task.taskId}: tokenBudget=${this.task.tokenBudget}, effectiveMaxToolCalls=${effectiveMaxToolCalls}`);
      }

      // Debug: verify tools are being passed to the LLM
      console.log(`[InferenceRunner] Task ${this.task.taskId}: tools=${filteredToolOptions?.tools?.length ?? 0}, hasExecute=${!!filteredToolOptions?.executeToolCall}`);
      if (filteredToolOptions?.tools) {
        console.log(`[InferenceRunner] Tool names: ${filteredToolOptions.tools.map((t: any) => t.name).join(', ')}`);
      }

      // BUG 4: MCPL beforeInference hooks for sub-agents
      let { systemPrompt } = context;
      let messages = context.messages;

      const hookContext: InferenceHookContext = {
        conversationId: this.task.conversationId,
        userId: this.task.userId,
        isSubAgent: true,
      };

      if (this.hookManager) {
        const hookResult = await this.hookManager.beforeInference(
          this.task.userId,
          this.task.conversationId,
          undefined,
          1,           // hookDepth=1 — sub-agent level
          hookContext,
        );
        if (hookResult.abort) {
          throw new Error(`MCPL beforeInference aborted: ${hookResult.abortReason ?? 'no reason'}`);
        }
        const injections = hookResult.contextInjections;
        if (injections.length > 0) {
          // system injections → systemPrompt
          // F4 fix: normalizeInjectionContent handles McplContentBlock[] (avoids "[object Object]")
          const systemInj = injections.filter(i => i.position === 'system').map(i => normalizeInjectionContent(i.content));
          if (systemInj.length > 0) {
            systemPrompt = systemPrompt
              ? `${systemPrompt}\n\n${systemInj.join('\n')}`
              : systemInj.join('\n');
          }
          // beforeUser/afterUser → immutable message update (don't mutate shared reference)
          // F4 fix: normalizeInjectionContent handles McplContentBlock[]
          const beforeUser = injections.filter(i => i.position === 'beforeUser').map(i => normalizeInjectionContent(i.content));
          const afterUser = injections.filter(i => i.position === 'afterUser').map(i => normalizeInjectionContent(i.content));
          if (beforeUser.length > 0 || afterUser.length > 0) {
            const result = applyUserInjections(messages, beforeUser, afterUser);
            messages = result.messages;
            if (result.systemAppend) {
              systemPrompt = systemPrompt
                ? `${systemPrompt}\n\n${result.systemAppend}` : result.systemAppend;
            }
          }
        }
      }

      if (this.cancelled) {
        throw new Error('Task cancelled before inference');
      }

      const result = await this.llmClient.run({
        modelConfig,
        messages,
        systemPrompt,
        settings,
        userId: this.task.userId,
        conversation: context.conversation,
        participants: context.participants,
        toolOptions: filteredToolOptions,
        abortSignal: this.abortController.signal,
        maxToolDepth: 6,   // Sub-agents have narrow tasks: search→read→search→read→write→verify
        maxToolCalls: effectiveMaxToolCalls,  // Feature E: derived from tokenBudget or default 30
      });

      // Track metrics
      metrics.toolCalls = result.toolCalls.length;
      if (result.usage) {
        metrics.inputTokens = result.usage.inputTokens;
        metrics.outputTokens = result.usage.outputTokens;
      }

      // Feature E: Post-hoc token budget check
      if (this.task.tokenBudget) {
        const totalTokens = metrics.inputTokens + metrics.outputTokens;
        metrics.tokenBudget = this.task.tokenBudget;
        if (totalTokens > this.task.tokenBudget) {
          metrics.budgetExceeded = true;
          console.warn(
            `[InferenceRunner] Task ${this.task.taskId}: token budget exceeded ` +
            `(${totalTokens} used vs ${this.task.tokenBudget} budget)`
          );
        }
      }

      // Append assistant response to branch
      const assistantEvent: Event = {
        timestamp: new Date(),
        type: 'assistant_message',
        data: {
          messageId: uuidv4(),
          branchId: uuidv4(),
          conversationId: this.task.conversationId,
          content: result.content,
          contentBlocks: result.contentBlocks,
          model: assistantParticipant.model,
          participantId: assistantParticipant.id,
        },
      };
      await this.branchStore.appendEvent(this.task.taskId, assistantEvent);

      // BUG 4: MCPL afterInference hooks — fire-and-forget
      if (this.hookManager) {
        this.hookManager.afterInference(
          this.task.userId,
          this.task.conversationId,
          result.content?.slice(0, 200),
          hookContext,
        ).catch(err => console.error('[InferenceRunner] afterInference error:', err));
      }

      metrics.durationMs = Date.now() - startTime;

      return {
        summary: result.content,
        metrics,
      };
    } catch (error) {
      metrics.durationMs = Date.now() - startTime;

      // M2: Return null for cancelled tasks (not empty string)
      if (this.cancelled) {
        return {
          summary: null,
          metrics,
        };
      }

      throw error;
    }
  }

  /**
   * Cancel the running inference.
   */
  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
  }
}
