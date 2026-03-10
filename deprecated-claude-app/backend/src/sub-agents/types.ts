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

/** Maximum allowed auto-retries per task (safety cap). */
export const MAX_RETRIES_CAP = 3;

/** Base backoff delay for retries (ms). Exponential: delay * 2^retryCount. */
export const RETRY_BASE_DELAY_MS = 2_000; // 2 seconds

/** Maximum times a task can be manually resumed. */
export const MAX_RESUME_COUNT = 3;

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
  context?: SubAgentContext;      // Optional structured context for the task
  /** Feature C: Task IDs this task depends on. Stays QUEUED until all deps FINALIZED. */
  dependsOn?: string[];
  state: SubAgentState;
  forkPoint: number;           // messages.length in parent conversation at fork time
  forkBranchId: string | null; // activeBranchId of the last message at fork time (for branch-aware history)
  result: string | null;       // Final summary from sub-agent
  error: string | null;        // Error message if state === 'ERROR'
  metrics: TaskMetrics;
  /** BUG#14: Per-task lease timeout (ms). Falls back to group config if unset. */
  leaseMs?: number;
  /** Feature F: Maximum auto-retries for transient errors. 0 = no retry (default). */
  maxRetries?: number;
  /** Feature F: Current retry count. */
  retryCount?: number;
  /** Feature F: Timestamp when this task is eligible for retry (backoff). */
  nextRetryAt?: number;
  /** Feature D: Number of times this task has been manually resumed. */
  resumeCount?: number;
  /** Feature E: Max total tokens (input + output). Tracked post-hoc. */
  tokenBudget?: number;
  createdAt: number;           // epoch ms
  completedAt: number | null;  // epoch ms
}

export interface TaskMetrics {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  /** Feature E: True if total tokens exceeded the configured tokenBudget. */
  budgetExceeded?: boolean;
  /** Feature E: The configured token budget (for reference in results). */
  tokenBudget?: number;
}

export interface SubAgentContext {
  /** File paths or URIs relevant to the task. */
  files?: string[];
  /** Arbitrary key-value data pairs. */
  data?: Record<string, string>;
  /** Results from previously completed sub-agent tasks. */
  previousResults?: string[];
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
  | 'subtask_instruction_updated'
  | 'subtask_dep_failed'              // Feature C: task auto-errored due to dependency failure
  | 'subtask_retrying'                // Feature F: task re-queued for retry with backoff
  | 'subtask_resumed'                 // Feature D: terminal task manually resumed
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
  context?: SubAgentContext;
  forkPoint?: number;
  forkBranchId?: string | null;
  dependsOn?: string[];             // Feature C: dependency taskIds
  state?: SubAgentState;
  result?: string;
  error?: string;
  metrics?: TaskMetrics;
  config?: TaskGroupConfig;
  queuedMessage?: string;
  failedDependencies?: string[];    // Feature C: which deps caused cascade failure
  retryCount?: number;              // Feature F: retry attempt number
  maxRetries?: number;              // Feature F: configured max retries
  nextRetryAt?: number;             // Feature F: next retry eligible timestamp
  resumeCount?: number;             // Feature D: resume count
  previousState?: SubAgentState;    // Feature D: state before resume
  tokenBudget?: number;             // Feature E: configured token budget
  timestamp: number;
}

// =============================================================================
// Spawn Parameters
// =============================================================================

export interface SpawnSubtaskParams {
  conversationId: string;
  userId: string;
  instruction: string;
  context?: SubAgentContext;    // Optional structured context
  groupId?: string;            // Omit to auto-create group
  maxConcurrent?: number;      // Default: 3
  leaseMs?: number;            // Default: LEASE_MS
  dependsOn?: string[];        // Feature C: taskIds this task depends on
  maxRetries?: number;         // Feature F: auto-retry on transient errors (default: 0)
  tokenBudget?: number;        // Feature E: max total tokens (input + output)
}

/** Feature C: Per-instruction config for batch spawn with dependencies. */
export interface SpawnSubtaskInstruction {
  instruction: string;
  dependsOn?: string[];        // TaskIds this task depends on (can reference sibling tasks in same batch)
  context?: SubAgentContext;   // Per-task context override (merged with group context)
}

export interface SpawnSubtasksParams {
  conversationId: string;
  userId: string;
  instructions: string[] | SpawnSubtaskInstruction[];
  context?: SubAgentContext;    // Shared context for all tasks in the batch
  maxConcurrent?: number;
  leaseMs?: number;
  maxRetries?: number;         // Feature F: default for all tasks in batch
  tokenBudget?: number;        // Feature E: default for all tasks in batch
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
  /** BUG#3: Preserve attachments (images, files) from queued messages. */
  attachments?: Array<{ type: string; data: unknown }>;
  createdAt: number;
  groupId: string;
}
