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
  serverId: string;
  conversationId: string;
  delegateId: string;
  userId: string;
  transport: McplTransport;
  timestamp: number;
}

// =============================================================================
// McplInferenceBroker
// =============================================================================

export class McplInferenceBroker {
  private config: McplInferenceBrokerConfig;
  private db: Database | null = null;

  /** Rate limiting: timestamps of completed inferences */
  private completedTimestamps: number[] = [];

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
    serverId: string;
    conversationId: string;
    systemMessage?: string;
    userMessage: string;
    maxTokens?: number;
    stream?: boolean;
    delegateId: string;
    userId: string;
    transport: McplTransport;
  }): Promise<void> {
    const { requestId, serverId, conversationId, delegateId, userId, transport } = params;

    // 1. Check rate limit
    this.pruneOldTimestamps();
    if (this.completedTimestamps.length >= this.config.maxInferencesPerHour) {
      console.warn(`[McplInferenceBroker] Rate limited: ${serverId} (${this.completedTimestamps.length}/${this.config.maxInferencesPerHour} per hour)`);
      this.sendResponse(transport, {
        type: 'mcpl/inference_response',
        requestId,
        success: false,
        error: `Rate limit exceeded (${this.config.maxInferencesPerHour}/hour). Try again later.`,
      });
      // Notify user
      roomManager.broadcastToRoom(conversationId, {
        type: 'mcpl/inference_rate_limited',
        serverId,
        delegateId,
        requestId,
      });
      return;
    }

    // 2. Validate database
    if (!this.db) {
      this.sendResponse(transport, {
        type: 'mcpl/inference_response',
        requestId,
        success: false,
        error: 'Server not ready',
      });
      return;
    }

    // 3. Track the request
    this.activeRequests.set(requestId, {
      requestId,
      serverId,
      conversationId,
      delegateId,
      userId,
      transport,
      timestamp: Date.now(),
    });

    console.log(`[McplInferenceBroker] Processing inference request ${requestId} from ${serverId} (delegate: ${delegateId})`);

    try {
      // Streaming: send chunks as they arrive, then final inference_response
      let chunkIndex = 0;
      const onChunk = params.stream
        ? (delta: string) => {
            this.sendResponse(transport, {
              type: 'mcpl/inference_chunk',
              requestId,
              chunkIndex: chunkIndex++,
              delta,
            });
          }
        : undefined;

      const response = await this.executeInference({
        ...params,
        serverId: params.serverId,
        delegateId: params.delegateId,
        onChunk,
      });
      this.completedTimestamps.push(Date.now());

      // Persist budget event (audit + replay on restart)
      if (this.db) {
        this.db.appendMcplUserEvent(userId, 'inference_request_completed', {
          requestId, serverId, timestamp: new Date().toISOString(),
        }).catch(err => console.warn('[McplInferenceBroker] Failed to persist:', err));
      }

      // inference_response serves as completion signal for both streaming and non-streaming
      this.sendResponse(transport, {
        type: 'mcpl/inference_response',
        requestId,
        success: true,
        content: response,
      });

      console.log(`[McplInferenceBroker] Completed inference ${requestId} (${response.length} chars${params.stream ? `, ${chunkIndex} chunks` : ''})`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[McplInferenceBroker] Inference failed ${requestId}:`, errorMsg);

      // Error mid-stream or otherwise → inference_response { success: false, error }
      this.sendResponse(transport, {
        type: 'mcpl/inference_response',
        requestId,
        success: false,
        error: errorMsg,
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  // --------------------------------------------------------------------------
  // Execute Inference
  // --------------------------------------------------------------------------

  private async executeInference(params: {
    conversationId: string;
    systemMessage?: string;
    userMessage: string;
    maxTokens?: number;
    userId: string;
    serverId?: string;
    delegateId?: string;
    featureSet?: string;
    onChunk?: (delta: string) => void;
  }): Promise<string> {
    if (!this.db) throw new Error('Database not set');

    const { conversationId, systemMessage, userMessage, maxTokens, userId } = params;

    // Get conversation
    const conversation = await this.db.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Resolve model via routing config (featureSet is primary match key)
    const route = inferenceRouter.resolve({
      featureSet: params.featureSet,
      delegateId: params.delegateId || '',
      serverId: params.serverId || '',
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
    const contextManager = new ContextManager();
    const inferenceService = new EnhancedInferenceService(baseInferenceService, contextManager);

    // Get conversation messages for context
    const messages = await this.db.getConversationMessages(conversationId, userId);

    // Build a simple system prompt
    const system = systemMessage || '';

    // Run inference (collect streamed response)
    let fullResponse = '';
    const settings = {
      ...conversation.settings,
      maxTokens: maxTokens || this.config.defaultMaxTokens,
    };

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
      undefined,  // onMetrics
      participants
    );

    return fullResponse;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private sendResponse(transport: McplTransport, message: Record<string, unknown>): void {
    if (transport.isOpen) {
      try {
        transport.send(message);
      } catch (err) {
        console.error('[McplInferenceBroker] Failed to send response:', err);
      }
    }
  }

  private pruneOldTimestamps(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.completedTimestamps = this.completedTimestamps.filter(t => t > oneHourAgo);
  }

  /**
   * Add a completed timestamp (used during event replay to rebuild budget).
   */
  addCompletedTimestamp(ts: number): void {
    this.completedTimestamps.push(ts);
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
    this.pruneOldTimestamps();
    return {
      activeRequests: this.activeRequests.size,
      completedThisHour: this.completedTimestamps.length,
      maxPerHour: this.config.maxInferencesPerHour,
    };
  }
}

export const mcplInferenceBroker = new McplInferenceBroker();
