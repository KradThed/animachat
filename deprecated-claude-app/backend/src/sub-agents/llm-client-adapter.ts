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

    // Build tool options with tracking callbacks
    const fullToolOptions = toolOptions
      ? {
          tools: toolOptions.tools,
          onToolCall: (call: ToolCall) => { toolCalls.push(call); },
          onToolResult: (result: ToolResult) => { toolResults.push(result); },
          executeToolCall: toolOptions.executeToolCall,
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
      );
    } catch (error) {
      throw new Error(`LLM inference failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { content, contentBlocks, toolCalls, toolResults, usage };
  }
}
