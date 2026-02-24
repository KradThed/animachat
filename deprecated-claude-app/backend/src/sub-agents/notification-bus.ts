/**
 * Notification Bus
 *
 * Two output channels for sub-agent lifecycle events:
 *   1. UI broadcast — sends real-time updates to connected WebSocket clients
 *   2. Inference trigger — placeholder for future server-initiated inference
 *
 * DR-WAKE-001: System turns only fire on group-level transitions
 * (not_all_terminal → all_terminal, or group_finalized).
 *
 * MVP: Auto-finalize (C6) handles the deadlock safety net in SubAgentManager.
 * SystemTurnTrigger is kept as placeholder — not wired for auto-wake.
 */

import { EventEmitter } from 'events';
import type { SubAgentState } from './types.js';

// =============================================================================
// Types
// =============================================================================

interface RoomManagerLike {
  broadcastToRoom(conversationId: string, message: any, exclude?: any): void;
  hasActiveAiRequest(conversationId: string): boolean;
}

// =============================================================================
// Bus
// =============================================================================

export class NotificationBus extends EventEmitter {
  private roomManager: RoomManagerLike | null = null;

  /**
   * Wire UI broadcast channel to room manager.
   */
  bridgeToWebSocket(roomManager: RoomManagerLike): void {
    this.roomManager = roomManager;
  }

  /**
   * Placeholder: Wire inference trigger channel.
   * MVP: Not wired. AI polls manually. Auto-finalize handles edge case.
   */
  bridgeToInferenceTrigger(_trigger: any): void {
    // No-op placeholder — kept for API compatibility with index.ts wiring.
    // Future: wire SystemTurnTrigger here when runInference() is extracted.
  }

  /**
   * Notify about a single task status change.
   * Broadcasts to UI with instructionPreview for panel display.
   */
  notifyParent(
    conversationId: string,
    groupId: string,
    taskId: string,
    status: SubAgentState,
    instructionPreview?: string,
  ): void {
    // 1. UI broadcast
    this.roomManager?.broadcastToRoom(conversationId, {
      type: 'subtask_status_changed',
      groupId,
      taskId,
      status,
      ...(instructionPreview ? { instructionPreview } : {}),
    });

    this.emit('taskStatusChanged', { conversationId, groupId, taskId, status });
  }

  /**
   * Signal that a task group has been finalized and the parent is unfrozen.
   * Broadcasts to UI only — no auto-wake (MVP).
   */
  unfreezeParent(conversationId: string, groupId: string, autoFinalized: boolean = false): void {
    // UI broadcast — use distinct event type so frontend can show CTA for auto-finalized groups
    this.roomManager?.broadcastToRoom(conversationId, {
      type: autoFinalized ? 'subtask_group_auto_finalized' : 'subtask_group_finalized',
      groupId,
    });

    // MVP: No systemTurnTrigger.triggerSystemTurn() call.
    // Auto-finalize in SubAgentManager handles the deadlock edge case.
    // The AI stays in its tool loop (poll → get_results → finalize) in normal flow.

    this.emit('groupFinalized', { conversationId, groupId });
  }
}
