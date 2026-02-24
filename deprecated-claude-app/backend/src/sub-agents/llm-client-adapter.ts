/**
 * LLM Client Adapter
 *
 * WS-decoupled wrapper around EnhancedInferenceService.streamCompletion().
 * Sub-agents call run() instead of using the WebSocket-entangled handler.ts flow.
 *
 * Accumulates streaming chunks and returns a final result with content blocks.
 */

import type { Message, Conversation, Model, ModelSettings, Participant } from '@deprecated-claude/shared';
import type { EnhancedInferenceService } from '../services/enhanced-inference.js';
import type { ToolDefinition, ToolCall, ToolResult } from '../tools/tool-registry.js';

// =============================================================================
// Types
// =============================================================================

export interface LLMRunOptions {
  modelConfig: Model;
  messages: Message[];
  systemPrompt: string;
  settings: ModelSettings;
  userId: string;
  conversation: Conversation;
  participants: Participant[];
  toolOptions?: {
    tools?: ToolDefinition[];
    executeToolCall?: (call: ToolCall) => Promise<ToolResult>;
  };
  abortSignal?: AbortSignal;
  maxToolDepth?: number;
  maxToolCalls?: number;
}

export interface LLMRunResult {
  content: string;
  contentBlocks: any[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage?: { inputTokens: number; outputTokens: number };
}

// =============================================================================
// Adapter
// =============================================================================

export class LLMClientAdapter {
  constructor(private inferenceService: EnhancedInferenceService) {}

  /**
   * Run a single inference call and return the complete result.
   * Accumulates streaming chunks internally — no WebSocket needed.
   */
  async run(options: LLMRunOptions): Promise<LLMRunResult> {
    const {
      modelConfig,
      messages,
      systemPrompt,
      settings,
      userId,
      conversation,
      participants,
      toolOptions,
      abortSignal,
    } = options;

    let content = '';
    let contentBlocks: any[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    // Stream callback — accumulates chunks
    const streamCallback = async (
      chunk: string,
      isComplete: boolean,
      blocks?: any[],
    ): Promise<void> => {
      content += chunk;
      if (blocks) {
        contentBlocks = blocks;
      }
    };

    // Metrics callback — captures token usage
    const onMetrics = async (metrics: any): Promise<void> => {
      if (metrics) {
        usage = {
          inputTokens: metrics.inputTokens ?? 0,
          outputTokens: metrics.outputTokens ?? 0,
        };
      }
    };

    // maxToolCalls soft-stop: single counter in executeToolCall (no off-by-one)
    let toolCallCount = 0;
    let toolsDisabled = false;
    const maxToolCalls = options.maxToolCalls ?? 50;

    // Build tool options with tracking callbacks + maxToolCalls safety cap
    const fullToolOptions = toolOptions
      ? {
          tools: toolOptions.tools,
          onToolCall: (call: ToolCall) => {
            toolCalls.push(call);
          },
          onToolResult: (result: ToolResult) => { toolResults.push(result); },
          executeToolCall: async (call: ToolCall): Promise<ToolResult> => {
            toolCallCount++;
            if (toolsDisabled) {
              return {
                toolUseId: call.id,
                content: 'Tools disabled. Return your final answer.',
                isError: true,
              };
            }
            // > not >=: allow exactly maxToolCalls executions, disable on (maxToolCalls+1)th
            if (toolCallCount > maxToolCalls) {
              toolsDisabled = true;
              console.warn(`[LLMClientAdapter] maxToolCalls (${maxToolCalls}) exceeded, disabling tools`);
              return {
                toolUseId: call.id,
                content: `Tool call limit reached (${maxToolCalls}). Return your final answer now.`,
                isError: true,
              };
            }
            return toolOptions.executeToolCall!(call);
          },
        }
      : undefined;

    // Find first assistant participant for the responder param
    const responder = participants.find(p => p.type === 'assistant');

    // H8: Wrap in try-catch to provide clear error messages
    try {
      await this.inferenceService.streamCompletion(
        modelConfig,
        messages,
        systemPrompt,
        settings,
        userId,
        streamCallback,
        conversation,
        responder,
        onMetrics,
        participants,
        abortSignal,
        fullToolOptions,
        options.maxToolDepth,  // Passed to Membrane StreamOptions.maxToolDepth
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // "Generation aborted" = normal cancellation (abortSignal fired).
      // Return partial content — InferenceRunner.run() checks this.cancelled
      // and returns summary: null for cancelled tasks.
      if (msg === 'Generation aborted' || abortSignal?.aborted) {
        return { content: content || '', contentBlocks, toolCalls, toolResults, usage };
      }
      throw new Error(`LLM inference failed: ${msg}`);
    }

    return { content, contentBlocks, toolCalls, toolResults, usage };
  }
}
