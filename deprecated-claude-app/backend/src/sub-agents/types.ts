/**
 * Sub-Agent System Types
 *
 * Core type definitions for the sub-agent orchestration system.
 * Sub-agents are parallel inference tasks spawned by a parent conversation.
 */

// =============================================================================
// Constants
// =============================================================================

/** How many mutations between auto-checkpoints in branch state. */
export const CHECKPOINT_INTERVAL = 10;

/** Default lease time for a sub-agent task (ms). */
export const LEASE_MS = 5 * 60 * 1000; // 5 minutes

/** Grace period after FINALIZING before force-cancel (ms). */
export const FINALIZE_GRACE_MS = 10_000; // 10 seconds

/** Max inference loop iterations per sub-agent (prevents runaway). */
export const MAX_ITERATIONS = 25;

/** Terminal states — tasks in these states will never change again. */
export const TERMINAL_STATUSES: readonly SubAgentState[] = ['FINALIZED', 'CANCELLED', 'ERROR'] as const;

// =============================================================================
// State Machine
// =============================================================================

export type SubAgentState =
  | 'QUEUED'       // Created but not yet running (concurrency limit)
  | 'RUNNING'      // Actively performing inference
  | 'FINALIZING'   // Abort requested, waiting for grace period
  | 'FINALIZED'    // Completed successfully
  | 'CANCELLED'    // Cancelled by user or parent
  | 'ERROR';       // Failed with error

// =============================================================================
// Task & Group
// =============================================================================

export interface SubAgentTask {
  taskId: string;
  groupId: string;
  conversationId: string;
  userId: string;
  instruction: string;
  state: SubAgentState;
  forkPoint: number;           // messages.length in parent conversation at fork time
  forkBranchId: string | null; // activeBranchId of the last message at fork time (for branch-aware history)
  result: string | null;       // Final summary from sub-agent
  error: string | null;        // Error message if state === 'ERROR'
  metrics: TaskMetrics;
  createdAt: number;           // epoch ms
  completedAt: number | null;  // epoch ms
}

export interface TaskMetrics {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface TaskGroupConfig {
  maxConcurrent: number;       // Max parallel sub-agents in this group
  leaseMs: number;             // Per-task timeout
}

export interface TaskGroup {
  groupId: string;
  conversationId: string;
  userId: string;
  tasks: Map<string, SubAgentTask>;
  config: TaskGroupConfig;
  createdAt: number;
  finalizedAt: number | null;
}

// =============================================================================
// Results
// =============================================================================

export interface SubAgentResult {
  taskId: string;
  instruction: string;
  state: SubAgentState;
  result: string | null;
  error: string | null;
  metrics: TaskMetrics;
}

export interface FinalizeResult {
  status: 'ok' | 'already_finalized';
  groupId: string;
  results: SubAgentResult[];
  queuedUserTurn: string | null; // If a user message was queued during freeze
}

// =============================================================================
// Lifecycle Events (written to main conversation JSONL)
// =============================================================================

export type SubAgentEventType =
  | 'subtask_group_created'
  | 'subtask_spawned'
  | 'subtask_started'
  | 'subtask_completed'
  | 'subtask_failed'
  | 'subtask_cancelled'
  | 'subtask_group_finalized'
  | 'subtask_group_auto_finalized'
  | 'queued_user_turn'
  | 'queued_user_turn_released'
  | 'queued_user_turn_cancelled';

export interface SubAgentLifecycleEvent {
  type: SubAgentEventType;
  groupId: string;
  taskId?: string;
  conversationId: string;
  userId: string;
  instruction?: string;
  forkPoint?: number;
  forkBranchId?: string | null;
  state?: SubAgentState;
  result?: string;
  error?: string;
  metrics?: TaskMetrics;
  config?: TaskGroupConfig;
  queuedMessage?: string;
  timestamp: number;
}

// =============================================================================
// Spawn Parameters
// =============================================================================

export interface SpawnSubtaskParams {
  conversationId: string;
  userId: string;
  instruction: string;
  groupId?: string;            // Omit to auto-create group
  maxConcurrent?: number;      // Default: 3
  leaseMs?: number;            // Default: LEASE_MS
}

export interface SpawnSubtasksParams {
  conversationId: string;
  userId: string;
  instructions: string[];
  maxConcurrent?: number;
  leaseMs?: number;
}

// =============================================================================
// State Snapshot (for UI panel)
// =============================================================================

export interface SubAgentStateSnapshot {
  active: boolean;
  groupId: string | null;
  tasks: Array<{ taskId: string; instructionPreview: string; status: string }>;
  finalized: boolean;
  hasResults?: boolean;
  queuedText: string | null;
}

// =============================================================================
// Queued User Message (frozen parent gate)
// =============================================================================

export interface QueuedUserMessage {
  messageId: string;
  conversationId: string;
  userId: string;
  text: string;
  createdAt: number;
  groupId: string;
}
