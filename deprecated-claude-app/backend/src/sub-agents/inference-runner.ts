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
import type { SubAgentTask, TaskMetrics } from './types.js';
import { MAX_ITERATIONS } from './types.js';

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
      // Build initial context
      const context = await this.contextBuilder.buildContext({
        conversationId: this.task.conversationId,
        userId: this.task.userId,
        taskId: this.task.taskId,
        taskInstruction: this.task.instruction,
        forkPoint: this.task.forkPoint,
      });

      // Build tool options — exclude sub-agent tools (depth=1 limit)
      const toolOpts = buildToolOptions(
        this.task.userId,
        context.conversation,
        context.participants.find(p => p.type === 'assistant'),
        this.db,
      );

      // Filter out sub-agent tools to prevent recursive spawning
      const filteredToolOptions = toolOpts
        ? {
            tools: toolOpts.tools.filter((t: any) =>
              !t.name.startsWith('spawn_subtask') &&
              !t.name.startsWith('poll_subtasks') &&
              !t.name.startsWith('get_subtask_results') &&
              !t.name.startsWith('cancel_subtasks') &&
              !t.name.startsWith('finalize_task_group')
            ),
            executeToolCall: toolOpts.executeToolCall,
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

      if (this.cancelled) {
        throw new Error('Task cancelled before inference');
      }

      const result = await this.llmClient.run({
        modelConfig,
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        settings,
        userId: this.task.userId,
        conversation: context.conversation,
        participants: context.participants,
        toolOptions: filteredToolOptions,
        abortSignal: this.abortController.signal,
      });

      // Track metrics
      metrics.toolCalls = result.toolCalls.length;
      if (result.usage) {
        metrics.inputTokens = result.usage.inputTokens;
        metrics.outputTokens = result.usage.outputTokens;
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
