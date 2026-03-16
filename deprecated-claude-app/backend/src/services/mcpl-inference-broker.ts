/**
 * MCPL Inference Broker
 *
 * Allows MCP servers (via delegates) to request inference from the host.
 * Global tools budget (not per-server).
 *
 * Flow:
 *   MCP server → delegate → mcpl/inference_request → broker → inference → response
 *
 * Budget: max inferences per hour, global across all servers.
 * Budget exhausted → reject with error, notify user.
 */

import { randomUUID } from 'crypto';
import type { McplTransport } from '../delegate/mcpl-transport.js';
import { Database } from '../database/index.js';
import { MembraneInferenceService } from './membrane-inference.js';
import { EnhancedInferenceService } from './enhanced-inference.js';
import { ContextManager } from './context-manager.js';
import { ModelLoader } from '../config/model-loader.js';
import { roomManager } from '../websocket/room-manager.js';
import { inferenceRouter } from '../config/inference-routing.js';
import { inferenceChainTracker } from '../mcpl/inference-chain.js';

// =============================================================================
// Types
// =============================================================================

export interface McplInferenceBrokerConfig {
  /** Max inference requests per hour (global across all servers) */
  maxInferencesPerHour: number;
  /** Default max tokens for inference responses */
  defaultMaxTokens: number;
}

interface PendingInferenceRequest {
  requestId: string;
  featureSet: string;
  conversationId: string;
  delegateId: string;
  userId: string;
  transport: McplTransport;
  timestamp: number;
}

/** Structured result from executeInference for Gap 2 compliance */
interface InferenceResult {
  content: string;
  model: string;
  finishReason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  usage: { inputTokens: number; outputTokens: number };
}

// =============================================================================
// McplInferenceBroker
// =============================================================================

export class McplInferenceBroker {
  private config: McplInferenceBrokerConfig;
  private db: Database | null = null;

  /** Rate limiting: timestamps of completed inferences, per user */
  private completedTimestamps: Map<string, number[]> = new Map();

  /** Active requests for tracking */
  private activeRequests: Map<string, PendingInferenceRequest> = new Map();

  constructor(config?: Partial<McplInferenceBrokerConfig>) {
    this.config = {
      maxInferencesPerHour: 30,
      defaultMaxTokens: 4096,
      ...config,
    };
  }

  /**
   * Set the database reference (called during server startup).
   */
  setDatabase(db: Database): void {
    this.db = db;
  }

  // --------------------------------------------------------------------------
  // Handle Inference Request
  // --------------------------------------------------------------------------

  /**
   * Handle an inference request from an MCP server (via delegate).
   */
  async handleInferenceRequest(params: {
    requestId: string;
    featureSet: string;
    conversationId: string;
    systemMessage?: string;
    userMessage?: string;      // F17: legacy (use messages[] instead)
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;  // F17: multi-turn
    maxTokens?: number;
    stream?: boolean;
    delegateId: string;
    userId: string;
    transport: McplTransport;
    parentChainId?: string;   // Fix #5: chain tracking
    parentFrameId?: string;   // Fix #5: frame tracking
  }): Promise<void> {
    const { requestId, featureSet, conversationId, delegateId, userId, transport } = params;

    // 0. Fix #5: Recursion protection — create or continue inference chain
    let chainId: string | undefined;
    let frameId: string | undefined;

    if (params.parentChainId && params.parentFrameId) {
      // Continue existing chain
      const chainResult = inferenceChainTracker.continueChain(
        params.parentChainId,
        params.parentFrameId,
        featureSet,
      );
      if (!chainResult.allowed) {
        console.warn(`[McplInferenceBroker] Chain rejected: ${chainResult.reason} (featureSet: ${featureSet}, request: ${requestId})`);
        this.sendResponse(transport, {
          type: 'mcpl/error',
          requestId,
          code: -32603,
          message: `Inference chain rejected: ${chainResult.reason}`,
        });
        return;
      }
      chainId = chainResult.chainId;
      frameId = chainResult.frameId;
    } else {
      // New chain (no parent — first inference or parentChainId bypassed)
      const chainResult = inferenceChainTracker.createChain(conversationId, featureSet);
      if (!chainResult.allowed) {
        console.warn(`[McplInferenceBroker] Chain creation rejected: ${chainResult.reason} (featureSet: ${featureSet}, request: ${requestId})`);
        this.sendResponse(transport, {
          type: 'mcpl/error',
          requestId,
          code: -32603,
          message: `Inference request rejected: ${chainResult.reason}`,
        });
        return;
      }
      chainId = chainResult.chainId;
      frameId = chainResult.frameId;
    }

    // 1. Check rate limit (per-user)
    this.pruneOldTimestamps(userId);
    const userTimestamps = this.completedTimestamps.get(userId) || [];
    if (userTimestamps.length >= this.config.maxInferencesPerHour) {
      console.warn(`[McplInferenceBroker] Rate limited: ${featureSet} (${userTimestamps.length}/${this.config.maxInferencesPerHour} per hour for user ${userId})`);
      this.sendResponse(transport, {
        type: 'mcpl/error',
        requestId,
        code: -32603,
        message: `Rate limit exceeded (${this.config.maxInferencesPerHour}/hour). Try again later.`,
      });
      // Notify user
      roomManager.broadcastToRoom(conversationId, {
        type: 'mcpl/inference_rate_limited',
        featureSet,
        delegateId,
        requestId,
      });
      return;
    }

    // 2. Validate database
    if (!this.db) {
      this.sendResponse(transport, {
        type: 'mcpl/error',
        requestId,
        code: -32603,
        message: 'Server not ready',
      });
      return;
    }

    // 3. Track the request
    this.activeRequests.set(requestId, {
      requestId,
      featureSet,
      conversationId,
      delegateId,
      userId,
      transport,
      timestamp: Date.now(),
    });

    console.log(`[McplInferenceBroker] Processing inference request ${requestId} from ${featureSet} (delegate: ${delegateId})`);

    try {
      // Streaming: send chunks as they arrive, then final inference_response
      let chunkIdx = 0;
      const onChunk = params.stream
        ? (delta: string) => {
            this.sendResponse(transport, {
              type: 'mcpl/inference_chunk',
              requestId,
              index: chunkIdx++,             // spec: index (was: chunkIndex)
              delta,
            });
          }
        : undefined;

      const result = await this.executeInference({
        ...params,
        featureSet: params.featureSet,
        delegateId: params.delegateId,
        onChunk,
      });
      const completedTs = this.completedTimestamps.get(userId) || [];
      completedTs.push(Date.now());
      this.completedTimestamps.set(userId, completedTs);

      // Persist budget event (audit + replay on restart)
      if (this.db) {
        // H9: Include model and usage in audit event per spec §11.5
        this.db.appendMcplUserEvent(userId, 'inference_request_completed', {
          _userId: userId,  // replayEvent doesn't receive partition key
          requestId, featureSet, timestamp: new Date().toISOString(),
          model: result.model,
          usage: result.usage,
        }).catch(err => console.warn('[McplInferenceBroker] Failed to persist:', err));
      }

      // Gap 2: inference_response with model, finishReason, usage per MCPL spec
      this.sendResponse(transport, {
        type: 'mcpl/inference_response',
        requestId,
        content: result.content,
        model: result.model,
        finishReason: result.finishReason,
        usage: result.usage,
      });

      console.log(`[McplInferenceBroker] Completed inference ${requestId} (${result.content.length} chars${params.stream ? `, ${chunkIdx} chunks` : ''}, model: ${result.model})`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[McplInferenceBroker] Inference failed ${requestId}:`, errorMsg);

      // Error mid-stream or otherwise → JSON-RPC error per spec
      this.sendResponse(transport, {
        type: 'mcpl/error',
        requestId,
        code: -32603,
        message: errorMsg,
      });
    } finally {
      this.activeRequests.delete(requestId);
      // Fix #5: always complete the frame, regardless of success/failure
      if (chainId && frameId) {
        inferenceChainTracker.completeFrame(chainId, frameId);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Execute Inference
  // --------------------------------------------------------------------------

  private async executeInference(params: {
    conversationId: string;
    systemMessage?: string;
    userMessage?: string;       // F17: legacy
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;  // F17: multi-turn
    maxTokens?: number;
    userId: string;
    featureSet?: string;
    delegateId?: string;
    onChunk?: (delta: string) => void;
  }): Promise<InferenceResult> {
    if (!this.db) throw new Error('Database not set');

    const { conversationId, systemMessage, maxTokens, userId } = params;

    // F17: Resolve messages — prefer messages[], fall back to userMessage
    const inferenceMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
      params.messages && params.messages.length > 0
        ? params.messages
        : params.userMessage
          ? [{ role: 'user' as const, content: params.userMessage }]
          : [];

    // Get conversation
    const conversation = await this.db.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Resolve model via routing config (featureSet is primary match key)
    const route = inferenceRouter.resolve({
      featureSet: params.featureSet,
      delegateId: params.delegateId || '',
    });

    // Get model — use routed model, fall back to conversation model
    const modelLoader = ModelLoader.getInstance();
    const modelId = route?.model ?? conversation.model ?? 'claude-sonnet-4-20250514';
    const model = await modelLoader.getModelById(modelId, userId);
    if (!model) {
      throw new Error(`Model ${modelId} not found`);
    }

    // Create inference service
    const baseInferenceService = new MembraneInferenceService(this.db);
    const contextManager = ContextManager.getInstance();
    const inferenceService = new EnhancedInferenceService(baseInferenceService, contextManager);

    // F17: Append incoming messages to DB conversation, then load full context
    if (inferenceMessages.length > 0) {
      for (const im of inferenceMessages) {
        await this.db.createMessage(
          conversationId,
          userId,
          im.content,
          im.role,
          im.role === 'assistant' ? modelId : undefined,
          undefined,    // parent branch (auto-determined)
          undefined,    // participantId
          undefined,    // attachments
          undefined,    // sentByUserId
          false,        // hiddenFromAi
          'mcpl_inference',  // creationSource
        );
      }
    }

    // Get conversation messages for context (includes any F17-appended messages)
    const messages = await this.db.getConversationMessages(conversationId, userId);

    // Build a simple system prompt
    const system = systemMessage || '';

    // Run inference (collect streamed response)
    let fullResponse = '';
    const settings = {
      ...conversation.settings,
      maxTokens: maxTokens || this.config.defaultMaxTokens,
    };

    // Gap 2: Capture metrics from onMetrics callback for inference_response
    // NOTE: `as` type assertion needed because TS control flow can't track
    // mutations via async callbacks (assigned inside onMetrics closure).
    let capturedMetrics = null as { inputTokens: number; outputTokens: number; model: string; stopReason?: string } | null;

    // Get participants
    const participants = await this.db.getConversationParticipants(conversationId, userId);
    const responder = participants.find(p => p.type === 'assistant');

    await inferenceService.streamCompletion(
      model,
      messages,
      system,
      settings,
      userId,
      async (chunk: string, isComplete: boolean) => {
        fullResponse += chunk;
        // Pipe streaming chunks to delegate (if streaming enabled)
        if (chunk && params.onChunk) {
          params.onChunk(chunk);
        }
      },
      conversation,
      responder,
      async (metrics: any) => {
        // Gap 2: Capture usage metrics + stopReason for inference_response
        capturedMetrics = {
          inputTokens: metrics.inputTokens ?? 0,
          outputTokens: metrics.outputTokens ?? 0,
          model: metrics.model ?? modelId,
          stopReason: metrics.stopReason,
        };
      },
      participants
    );

    return {
      content: fullResponse,
      model: capturedMetrics?.model ?? modelId,
      finishReason: this.mapStopReason(capturedMetrics?.stopReason),
      usage: {
        inputTokens: capturedMetrics?.inputTokens ?? 0,
        outputTokens: capturedMetrics?.outputTokens ?? 0,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Map provider stopReason to MCPL finishReason.
   * Anthropic: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
   */
  private mapStopReason(stopReason?: string): 'end_turn' | 'max_tokens' | 'stop_sequence' {
    if (stopReason === 'max_tokens') return 'max_tokens';
    if (stopReason === 'stop_sequence') return 'stop_sequence';
    // end_turn, tool_use, unknown, or missing → end_turn
    return 'end_turn';
  }

  private sendResponse(transport: McplTransport, message: Record<string, unknown>): void {
    if (transport.isOpen) {
      try {
        transport.send(message);
      } catch (err) {
        console.error('[McplInferenceBroker] Failed to send response:', err);
      }
    }
  }

  private pruneOldTimestamps(userId: string): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const timestamps = this.completedTimestamps.get(userId);
    if (timestamps) {
      const pruned = timestamps.filter(t => t > oneHourAgo);
      if (pruned.length > 0) {
        this.completedTimestamps.set(userId, pruned);
      } else {
        this.completedTimestamps.delete(userId);
      }
    }
  }

  /**
   * Add a completed timestamp for a user (used during event replay to rebuild budget).
   */
  addCompletedTimestamp(userId: string, ts: number): void {
    const arr = this.completedTimestamps.get(userId) || [];
    arr.push(ts);
    this.completedTimestamps.set(userId, arr);
  }

  /**
   * Update config at runtime.
   */
  updateConfig(config: Partial<McplInferenceBrokerConfig>): void {
    this.config = { ...this.config, ...config };
    console.log(`[McplInferenceBroker] Config updated:`, this.config);
  }

  getStats(): {
    activeRequests: number;
    completedThisHour: number;
    maxPerHour: number;
  } {
    return {
      activeRequests: this.activeRequests.size,
      completedThisHour: [...this.completedTimestamps.values()].reduce((sum, ts) => sum + ts.length, 0),
      maxPerHour: this.config.maxInferencesPerHour,
    };
  }
}

export const mcplInferenceBroker = new McplInferenceBroker();
