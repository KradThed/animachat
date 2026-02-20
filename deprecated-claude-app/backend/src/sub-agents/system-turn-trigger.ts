/**
 * System Turn Trigger
 *
 * Server-initiated inference for sub-agent wake-up.
 * The animachat codebase is purely request-driven — this is the first
 * piece that can inject a turn without a WebSocket message from a client.
 *
 * MVP: Not wired. AI polls manually via the tool loop
 * (spawn → poll → poll → get_results → finalize).
 * Auto-finalize in SubAgentManager handles the edge case where
 * the inference chain is interrupted.
 *
 * Future: When runInference() is extracted from handler.ts into a
 * standalone function, this class will be wired to create synthetic
 * system messages and trigger inference on a conversation.
 */

import type { Database } from '../database/index.js';
import type { LLMClientAdapter } from './llm-client-adapter.js';

// =============================================================================
// Types
// =============================================================================

interface RoomManagerLike {
  broadcastToRoom(conversationId: string, message: any, exclude?: any): void;
  hasActiveAiRequest(conversationId: string): boolean;
}

// =============================================================================
// Trigger
// =============================================================================

export class SystemTurnTrigger {
  constructor(
    private db: Database,
    private llmClient: LLMClientAdapter,
    private roomManager: RoomManagerLike,
  ) {}

  /**
   * Trigger a server-initiated inference turn on a conversation.
   *
   * MVP: Only broadcasts a notification — does not run inference.
   * The actual inference wiring requires handler.ts refactoring
   * (extracting runInference() as a standalone function).
   *
   * Guard: skips if there's already an active AI request for this conversation.
   */
  async triggerSystemTurn(conversationId: string, systemMessage: string): Promise<void> {
    // Guard: don't stack inference requests
    if (this.roomManager.hasActiveAiRequest(conversationId)) {
      console.log(`[SystemTurnTrigger] Skipping — active AI request for ${conversationId}`);
      return;
    }

    console.log(`[SystemTurnTrigger] Triggering system turn for ${conversationId}`);

    // Broadcast that a system turn is starting
    this.roomManager.broadcastToRoom(conversationId, {
      type: 'system_turn_started',
      conversationId,
      message: systemMessage,
    });

    // MVP: No inference execution here.
    // Auto-finalize in SubAgentManager handles the deadlock safety net.
    // Future: wire runInference() when it's extracted from handler.ts.
    console.log(`[SystemTurnTrigger] System turn notification sent for ${conversationId}`);
  }
}
