/**
 * Sub-Agent Manager
 *
 * In-memory state machine for sub-agent task groups.
 * Manages the lifecycle: spawn → run → finalize/cancel.
 *
 * Key design decisions:
 *   - FINALIZED groups are removed from memory (not kept — saves RAM)
 *   - finalizeResultCache holds results for 5min after group deletion (for late queries)
 *   - rehydrateGroup() can reconstruct from main JSONL for read-only queries
 *   - recoverOrphanedTasks() scans ./data/branches/ at startup
 *   - Frozen parent gate: while a group is active, the parent conversation
 *     cannot accept new user messages (they're queued as queued_user_turn)
 *
 * Race condition guards:
 *   - startingTasks: prevents double-start of same task (C1)
 *   - finalizingGroups: prevents spawn into finalizing group (C2)
 *   - finalizedAt + finalizingGroups: prevents double finalize (C3)
 *   - finalizeResultCache: results survive group deletion (C3)
 *   - try/finally in finalizeTaskGroup: prevents stuck groups (C5)
 *   - Auto-finalize on all_terminal: deadlock safety net (C6)
 */

import { v4 as uuidv4 } from 'uuid';
import type { Database } from '../database/index.js';
import type { BranchEventStore } from '../database/branch-event-store.js';
import type { Event } from '../database/persistence.js';
import { LLMClientAdapter } from './llm-client-adapter.js';
import { SubAgentContextBuilder } from './context-builder.js';
import { InferenceRunner } from './inference-runner.js';
import type { NotificationBus } from './notification-bus.js';
import {
  LEASE_MS,
  FINALIZE_GRACE_MS,
  TERMINAL_STATUSES,
} from './types.js';
import type {
  SubAgentTask,
  SubAgentState,
  TaskGroup,
  TaskGroupConfig,
  TaskMetrics,
  SubAgentResult,
  FinalizeResult,
  SpawnSubtaskParams,
  SpawnSubtasksParams,
  QueuedUserMessage,
} from './types.js';

// =============================================================================
// Cache entry for finalized groups (survives group deletion)
// =============================================================================

interface FinalizeResultCacheEntry {
  results: SubAgentResult[];
  expiresAt: number;
}

/** TTL for finalize result cache (5 minutes). */
const FINALIZE_CACHE_TTL_MS = 5 * 60 * 1000;

// =============================================================================
// Manager
// =============================================================================

export class SubAgentManager {
  private groups: Map<string, TaskGroup> = new Map();
  private runners: Map<string, InferenceRunner> = new Map();

  // C1: Prevent double-start of same task
  private startingTasks: Set<string> = new Set();

  // C2: Prevent spawn into finalizing group
  private finalizingGroups: Set<string> = new Set();

  // H1: Track lease timers for cleanup on cancel
  private leaseTimers: Map<string, NodeJS.Timeout> = new Map();

  // C3: Cache results after group deletion (for late get_subtask_results/poll calls)
  private finalizeResultCache: Map<string, FinalizeResultCacheEntry> = new Map();
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  // Round 5: Queued user messages (depth=1 per conversation, in-memory)
  private queuedMessages: Map<string, QueuedUserMessage> = new Map();

  constructor(
    private llmClient: LLMClientAdapter,
    private contextBuilder: SubAgentContextBuilder,
    private branchStore: BranchEventStore,
    private notificationBus: NotificationBus,
    private db: Database,
  ) {
    // Prune expired cache entries every 60 seconds
    this.cacheCleanupTimer = setInterval(() => this.pruneExpiredCache(), 60_000);
  }

  // --------------------------------------------------------------------------
  // Spawn
  // --------------------------------------------------------------------------

  /**
   * Spawn a single sub-agent task.
   * Creates or joins a task group for the conversation.
   */
  async spawnSubtask(params: SpawnSubtaskParams): Promise<SubAgentTask> {
    const {
      conversationId,
      userId,
      instruction,
      maxConcurrent = 3,
      leaseMs = LEASE_MS,
    } = params;

    // C2: Block spawn into a group that is being finalized
    if (params.groupId && this.finalizingGroups.has(params.groupId)) {
      throw new Error(`Cannot spawn into group ${params.groupId}: group is being finalized`);
    }

    // C2: Block spawn into a group that doesn't exist (if groupId provided)
    if (params.groupId && !this.groups.has(params.groupId)) {
      throw new Error(`Cannot spawn into group ${params.groupId}: group not found`);
    }

    // Get or create group
    let groupId = params.groupId;
    let group: TaskGroup;

    if (groupId && this.groups.has(groupId)) {
      group = this.groups.get(groupId)!;

      // M3: Warn on config mismatch when joining existing group
      if (maxConcurrent !== group.config.maxConcurrent) {
        console.warn(
          `[SubAgentManager] maxConcurrent mismatch for group ${groupId}: ` +
          `requested ${maxConcurrent}, group has ${group.config.maxConcurrent}`,
        );
      }
      if (leaseMs !== group.config.leaseMs) {
        console.warn(
          `[SubAgentManager] leaseMs mismatch for group ${groupId}: ` +
          `requested ${leaseMs}, group has ${group.config.leaseMs}`,
        );
      }
    } else {
      groupId = groupId || uuidv4();
      group = {
        groupId,
        conversationId,
        userId,
        tasks: new Map(),
        config: { maxConcurrent, leaseMs },
        createdAt: Date.now(),
        finalizedAt: null,
      };
      this.groups.set(groupId, group);

      // Log lifecycle event to main JSONL
      await this.db.appendSubAgentEvent(conversationId, 'subtask_group_created', {
        groupId,
        conversationId,
        userId,
        config: group.config,
        timestamp: Date.now(),
      }, userId);
    }

    // C4: forkPoint = messages.length (snapshot saved in task)
    const messages = await this.db.getConversationMessages(conversationId, userId);
    const forkPoint = messages.length;

    // Create task
    const taskId = uuidv4();
    const task: SubAgentTask = {
      taskId,
      groupId,
      conversationId,
      userId,
      instruction,
      state: 'QUEUED',
      forkPoint,
      result: null,
      error: null,
      metrics: { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 },
      createdAt: Date.now(),
      completedAt: null,
    };

    group.tasks.set(taskId, task);

    // Log lifecycle event
    await this.db.appendSubAgentEvent(conversationId, 'subtask_spawned', {
      groupId,
      taskId,
      conversationId,
      userId,
      instruction,
      forkPoint,
      timestamp: Date.now(),
    }, userId);

    // Start running if under concurrency limit
    this.maybeStartTasks(group);

    return task;
  }

  /**
   * Spawn multiple sub-agent tasks as a batch.
   */
  async spawnSubtasks(params: SpawnSubtasksParams): Promise<SubAgentTask[]> {
    const groupId = uuidv4();
    const tasks: SubAgentTask[] = [];

    for (const instruction of params.instructions) {
      const task = await this.spawnSubtask({
        conversationId: params.conversationId,
        userId: params.userId,
        instruction,
        groupId,
        maxConcurrent: params.maxConcurrent,
        leaseMs: params.leaseMs,
      });
      tasks.push(task);
    }

    return tasks;
  }

  // --------------------------------------------------------------------------
  // Poll & Results
  // --------------------------------------------------------------------------

  /**
   * Poll task group status (non-blocking).
   * Falls back to finalizeResultCache if group has been deleted.
   */
  pollSubtasks(groupId: string): { tasks: SubAgentResult[]; allTerminal: boolean } {
    const group = this.groups.get(groupId);
    if (!group) {
      // C3: Check cache for recently finalized groups
      const cached = this.finalizeResultCache.get(groupId);
      if (cached && cached.expiresAt > Date.now()) {
        return { tasks: cached.results, allTerminal: true };
      }
      return { tasks: [], allTerminal: true };
    }

    const tasks: SubAgentResult[] = [];
    let allTerminal = true;

    for (const task of group.tasks.values()) {
      tasks.push({
        taskId: task.taskId,
        instruction: task.instruction,
        state: task.state,
        result: task.result,
        error: task.error,
        metrics: task.metrics,
      });

      if (!TERMINAL_STATUSES.includes(task.state)) {
        allTerminal = false;
      }
    }

    return { tasks, allTerminal };
  }

  /**
   * Get results for a task group (only returns results for completed tasks).
   * Falls back to finalizeResultCache if group has been deleted.
   */
  getSubtaskResults(groupId: string): { results: SubAgentResult[] } {
    const group = this.groups.get(groupId);
    if (!group) {
      // C3: Check cache for recently finalized groups
      const cached = this.finalizeResultCache.get(groupId);
      if (cached && cached.expiresAt > Date.now()) {
        return { results: cached.results };
      }
      return { results: [] };
    }

    const results: SubAgentResult[] = [];
    for (const task of group.tasks.values()) {
      if (TERMINAL_STATUSES.includes(task.state)) {
        results.push({
          taskId: task.taskId,
          instruction: task.instruction,
          state: task.state,
          result: task.result,
          error: task.error,
          metrics: task.metrics,
        });
      }
    }

    return { results };
  }

  // --------------------------------------------------------------------------
  // Cancel & Finalize
  // --------------------------------------------------------------------------

  /**
   * Cancel all running tasks in a group.
   */
  async cancelSubtasks(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;

    for (const task of group.tasks.values()) {
      if (!TERMINAL_STATUSES.includes(task.state)) {
        await this.cancelTask(task);
      }
    }
  }

  /**
   * Finalize a task group: abort remaining → grace wait → FINALIZED → remove from memory.
   *
   * C3: Returns {status:'already_finalized'} if group was already finalized (e.g. by auto-finalize).
   * C5: Uses try/finally to guarantee group is always cleaned up.
   */
  async finalizeTaskGroup(groupId: string): Promise<FinalizeResult> {
    // C3: Already finalized — return cached results
    const cached = this.finalizeResultCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        status: 'already_finalized',
        groupId,
        results: cached.results,
        queuedUserTurn: null,
      };
    }

    // C3: Currently being finalized by another call (C2 race)
    if (this.finalizingGroups.has(groupId)) {
      return {
        status: 'already_finalized',
        groupId,
        results: cached?.results ?? [],
        queuedUserTurn: null,
      };
    }

    const group = this.groups.get(groupId);
    if (!group) {
      return {
        status: 'already_finalized',
        groupId,
        results: [],
        queuedUserTurn: null,
      };
    }

    // C2: Mark as finalizing to block new spawns
    this.finalizingGroups.add(groupId);

    try {
      // C3: Double-finalize guard via finalizedAt
      if (group.finalizedAt !== null) {
        return {
          status: 'already_finalized',
          groupId,
          results: cached?.results ?? [],
          queuedUserTurn: null,
        };
      }

      // Transition non-terminal tasks to FINALIZING
      for (const task of group.tasks.values()) {
        if (!TERMINAL_STATUSES.includes(task.state)) {
          this.transitionTask(task, 'FINALIZING');
          const runner = this.runners.get(task.taskId);
          runner?.cancel();
        }
      }

      // Grace period for in-flight tasks
      await new Promise(resolve => setTimeout(resolve, FINALIZE_GRACE_MS));

      // Force-cancel anything still running
      for (const task of group.tasks.values()) {
        if (!TERMINAL_STATUSES.includes(task.state)) {
          await this.cancelTask(task);
        }
      }

      // Collect results
      const results: SubAgentResult[] = [];
      for (const task of group.tasks.values()) {
        results.push({
          taskId: task.taskId,
          instruction: task.instruction,
          state: task.state,
          result: task.result,
          error: task.error,
          metrics: task.metrics,
        });
      }

      // Log finalization event
      group.finalizedAt = Date.now();
      await this.db.appendSubAgentEvent(group.conversationId, 'subtask_group_finalized', {
        groupId,
        conversationId: group.conversationId,
        userId: group.userId,
        results: results.map(r => ({ taskId: r.taskId, state: r.state, result: r.result?.slice(0, 500) })),
        timestamp: Date.now(),
      }, group.userId);

      // C3: Cache results before deleting group
      this.finalizeResultCache.set(groupId, {
        results,
        expiresAt: Date.now() + FINALIZE_CACHE_TTL_MS,
      });

      // Notify bus
      this.notificationBus.unfreezeParent(group.conversationId, groupId);

      return {
        status: 'ok',
        groupId,
        results,
        queuedUserTurn: this.queuedMessages.has(group.conversationId)
          ? this.queuedMessages.get(group.conversationId)!.text
          : null,
      };
    } finally {
      // C5: Always clean up — prevents stuck groups on throw
      this.groups.delete(groupId);
      this.finalizingGroups.delete(groupId);
    }
  }

  // --------------------------------------------------------------------------
  // Frozen Parent Gate
  // --------------------------------------------------------------------------

  /**
   * Check if a conversation has an active (non-finalized) task group.
   * Returns the groupId if frozen, null otherwise.
   */
  getBlockingGroupId(conversationId: string): string | null {
    for (const group of this.groups.values()) {
      if (group.conversationId === conversationId && group.finalizedAt === null) {
        return group.groupId;
      }
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Queued User Messages (frozen parent gate)
  // --------------------------------------------------------------------------

  /**
   * Queue a user message while the parent conversation is frozen.
   * Depth=1: only one queued message per conversation.
   */
  queueUserMessage(msg: QueuedUserMessage): void {
    if (this.queuedMessages.has(msg.conversationId)) {
      throw new Error(
        `A message is already queued for conversation ${msg.conversationId}. ` +
        'Only one message can be queued while sub-agents are active.',
      );
    }
    this.queuedMessages.set(msg.conversationId, msg);
  }

  /**
   * Get the queued user message for a conversation (if any).
   */
  getQueuedMessage(conversationId: string): QueuedUserMessage | null {
    return this.queuedMessages.get(conversationId) ?? null;
  }

  /**
   * Release (send) the queued user message after finalize.
   */
  releaseQueuedMessage(conversationId: string): QueuedUserMessage | null {
    const msg = this.queuedMessages.get(conversationId);
    if (msg) {
      this.queuedMessages.delete(conversationId);
    }
    return msg ?? null;
  }

  /**
   * Cancel (discard) the queued user message.
   */
  cancelQueuedMessage(conversationId: string): void {
    this.queuedMessages.delete(conversationId);
  }

  // --------------------------------------------------------------------------
  // Recovery
  // --------------------------------------------------------------------------

  /**
   * Recover orphaned tasks on startup.
   * Scans ./data/branches/ for task files without matching in-memory state.
   * Marks them as ERROR ("interrupted by restart").
   */
  async recoverOrphanedTasks(): Promise<void> {
    try {
      const taskIds = await this.branchStore.listAllTaskIds();
      let recovered = 0;

      for (const taskId of taskIds) {
        // Check if this task is already managed
        let found = false;
        for (const group of this.groups.values()) {
          if (group.tasks.has(taskId)) {
            found = true;
            break;
          }
        }

        if (!found) {
          // Orphaned task — we can't know the original group, just log it
          console.warn(`[SubAgentManager] Orphaned branch file found: ${taskId}`);
          recovered++;
        }
      }

      if (recovered > 0) {
        console.log(`[SubAgentManager] Found ${recovered} orphaned branch files (not re-launched)`);
      }
    } catch (error) {
      console.warn('[SubAgentManager] Failed to scan for orphaned tasks:', error);
    }
  }

  /**
   * Rehydrate a finalized group from main JSONL (read-only snapshot).
   * Used for historical queries on finalized groups.
   */
  async rehydrateGroup(conversationId: string, groupId: string): Promise<TaskGroup | null> {
    // Check in-memory first
    const existing = this.groups.get(groupId);
    if (existing) return existing;

    // TODO: Scan conversation JSONL for subtask_group_created + subtask_spawned events
    // and reconstruct static TaskGroup. For now, return null.
    return null;
  }

  // --------------------------------------------------------------------------
  // Replay (Round 5: restore runtime state from JSONL on startup)
  // --------------------------------------------------------------------------

  /**
   * Replay a queued_user_turn event from JSONL to restore runtime state.
   */
  replayQueuedUserTurn(event: Event): void {
    const data = event.data;
    this.queuedMessages.set(data._conversationId, {
      messageId: data.messageId,
      conversationId: data._conversationId,
      userId: data.userId,
      text: data.text,
      createdAt: data.createdAt,
      groupId: data.groupId,
    });
  }

  /**
   * Replay a sub-agent lifecycle event from JSONL to restore runtime state.
   */
  replayLifecycleEvent(event: Event): void {
    switch (event.type) {
      case 'subtask_group_created':
        this.replayGroupCreated(event.data);
        break;
      case 'subtask_spawned':
        this.replayTaskSpawned(event.data);
        break;
      case 'subtask_completed':
      case 'subtask_cancelled':
      case 'subtask_failed':
        this.replayTaskTerminal(event.data, event.type);
        break;
      case 'subtask_group_finalized':
      case 'subtask_group_auto_finalized':
        this.replayGroupFinalized(event.data);
        break;
      case 'queued_user_turn_released':
      case 'queued_user_turn_cancelled':
        this.queuedMessages.delete(event.data._conversationId ?? event.data.conversationId);
        break;
      default:
        // Ignore unknown subtask_ event types
        break;
    }
  }

  private replayGroupCreated(data: any): void {
    const groupId = data.groupId;
    if (this.groups.has(groupId)) return; // already replayed
    this.groups.set(groupId, {
      groupId,
      conversationId: data.conversationId,
      userId: data.userId,
      tasks: new Map(),
      config: data.config ?? { maxConcurrent: 3, leaseMs: LEASE_MS },
      createdAt: data.timestamp ?? Date.now(),
      finalizedAt: null,
    });
  }

  private replayTaskSpawned(data: any): void {
    const group = this.groups.get(data.groupId);
    if (!group) return; // group event must come first
    if (group.tasks.has(data.taskId)) return; // already replayed
    group.tasks.set(data.taskId, {
      taskId: data.taskId,
      groupId: data.groupId,
      conversationId: data.conversationId,
      userId: data.userId,
      instruction: data.instruction,
      state: 'QUEUED', // will be updated by terminal events
      forkPoint: data.forkPoint ?? 0,
      result: null,
      error: null,
      metrics: { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 },
      createdAt: data.timestamp ?? Date.now(),
      completedAt: null,
    });
  }

  private replayTaskTerminal(data: any, eventType: string): void {
    const group = this.groups.get(data.groupId);
    if (!group) return;
    const task = group.tasks.get(data.taskId);
    if (!task) return;
    switch (eventType) {
      case 'subtask_completed':
        task.state = 'FINALIZED';
        task.result = data.result ?? null;
        task.metrics = data.metrics ?? task.metrics;
        break;
      case 'subtask_cancelled':
        task.state = 'CANCELLED';
        break;
      case 'subtask_failed':
        task.state = 'ERROR';
        task.error = data.error ?? null;
        break;
    }
    task.completedAt = data.timestamp ?? Date.now();
  }

  private replayGroupFinalized(data: any): void {
    const groupId = data.groupId;
    // Group is finalized — remove from memory (won't be re-launched)
    this.groups.delete(groupId);
    this.finalizingGroups.delete(groupId);
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------

  /**
   * Clean up timers on shutdown.
   */
  shutdown(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
    }
    // Clear all lease timers
    for (const timer of this.leaseTimers.values()) {
      clearTimeout(timer);
    }
    this.leaseTimers.clear();
  }

  // --------------------------------------------------------------------------
  // Internal: Task Execution
  // --------------------------------------------------------------------------

  /**
   * Start queued tasks if under concurrency limit.
   * C1: Uses startingTasks guard + state re-check to prevent double-start.
   * M1: No OPEN state in running count.
   */
  private maybeStartTasks(group: TaskGroup): void {
    const runningCount = [...group.tasks.values()].filter(
      t => t.state === 'RUNNING',
    ).length;

    const available = group.config.maxConcurrent - runningCount;
    if (available <= 0) return;

    const queued = [...group.tasks.values()].filter(t => t.state === 'QUEUED');

    let started = 0;
    for (const task of queued) {
      if (started >= available) break;

      // C1: Guard 1 — skip if already being started by another callback
      if (this.startingTasks.has(task.taskId)) continue;

      // C1: Guard 2 — re-check state (may have changed between filter and loop)
      if (task.state !== 'QUEUED') continue;

      this.startTask(task, group);
      started++;
    }
  }

  /**
   * Start a single task (fire-and-forget async).
   * H1: Stores lease timer for cleanup.
   * H2: Checks transitionTask return before side-effects.
   */
  private startTask(task: SubAgentTask, group: TaskGroup): void {
    // C1: Mark as starting
    this.startingTasks.add(task.taskId);

    // H2: Transition with check
    const transitioned = this.transitionTask(task, 'RUNNING');
    if (!transitioned) {
      this.startingTasks.delete(task.taskId);
      return;
    }

    // C1: Clear starting guard now that we've committed to RUNNING
    this.startingTasks.delete(task.taskId);

    // Log lifecycle event (fire-and-forget)
    this.db.appendSubAgentEvent(task.conversationId, 'subtask_started', {
      groupId: task.groupId,
      taskId: task.taskId,
      conversationId: task.conversationId,
      timestamp: Date.now(),
    }, task.userId).catch(err =>
      console.error(`[SubAgentManager] Failed to log subtask_started: ${err.message}`)
    );

    const runner = new InferenceRunner(
      task,
      this.llmClient,
      this.contextBuilder,
      this.branchStore,
      this.db,
    );
    this.runners.set(task.taskId, runner);

    // H1: Set lease timeout and store for cleanup
    const leaseTimer = setTimeout(() => {
      if (!TERMINAL_STATUSES.includes(task.state)) {
        console.warn(`[SubAgentManager] Task ${task.taskId} exceeded lease, cancelling`);
        this.cancelTask(task).catch(err =>
          console.error(`[SubAgentManager] Cancel error: ${err.message}`)
        );
      }
    }, group.config.leaseMs);
    this.leaseTimers.set(task.taskId, leaseTimer);

    // Run asynchronously
    runner.run()
      .then(async (result) => {
        // H1: Clear lease timer
        this.clearLeaseTimer(task.taskId);

        // H2: Check transition before side-effects
        const ok = this.transitionTask(task, 'FINALIZED');
        if (!ok) return;

        task.result = result.summary;
        task.metrics = result.metrics;
        task.completedAt = Date.now();
        this.runners.delete(task.taskId);

        // Log completion
        await this.db.appendSubAgentEvent(task.conversationId, 'subtask_completed', {
          groupId: task.groupId,
          taskId: task.taskId,
          conversationId: task.conversationId,
          result: result.summary?.slice(0, 1000) ?? null,
          metrics: result.metrics,
          timestamp: Date.now(),
        }, task.userId);

        // Notify
        this.notificationBus.notifyParent(
          task.conversationId,
          task.groupId,
          task.taskId,
          'FINALIZED',
        );

        // Start next queued task
        this.maybeStartTasks(group);

        // C6: Auto-finalize safety net — check if ALL tasks in group are terminal
        this.maybeAutoFinalize(group);
      })
      .catch(async (error) => {
        // H1: Clear lease timer
        this.clearLeaseTimer(task.taskId);

        // H2: Check transition before side-effects
        const ok = this.transitionTask(task, 'ERROR');
        if (!ok) return;

        task.error = error.message;
        task.completedAt = Date.now();
        this.runners.delete(task.taskId);

        // M4: Log DB errors (not silently swallow)
        await this.db.appendSubAgentEvent(task.conversationId, 'subtask_failed', {
          groupId: task.groupId,
          taskId: task.taskId,
          conversationId: task.conversationId,
          error: error.message,
          timestamp: Date.now(),
        }, task.userId).catch(err =>
          console.error(`[SubAgentManager] Failed to log subtask_failed: ${err.message}`)
        );

        // Notify
        this.notificationBus.notifyParent(
          task.conversationId,
          task.groupId,
          task.taskId,
          'ERROR',
        );

        // Start next queued task
        this.maybeStartTasks(group);

        // C6: Auto-finalize safety net — check if ALL tasks in group are terminal
        this.maybeAutoFinalize(group);
      });
  }

  /**
   * C6: Auto-finalize when all tasks reach terminal state.
   * Safety net for when the AI's inference chain is interrupted (timeout/error)
   * and nobody calls finalize_task_group explicitly.
   */
  private maybeAutoFinalize(group: TaskGroup): void {
    // Don't auto-finalize if already finalizing or finalized
    if (group.finalizedAt !== null) return;
    if (this.finalizingGroups.has(group.groupId)) return;

    const allTerminal = [...group.tasks.values()].every(
      t => TERMINAL_STATUSES.includes(t.state),
    );

    if (allTerminal) {
      console.log(`[SubAgentManager] All tasks terminal in group ${group.groupId}, auto-finalizing`);

      // Broadcast auto-finalize notification to UI
      this.notificationBus.notifyParent(
        group.conversationId,
        group.groupId,
        '',  // no specific taskId
        'FINALIZED',
      );

      this.finalizeTaskGroup(group.groupId).catch(err =>
        console.error(`[SubAgentManager] Auto-finalize failed for group ${group.groupId}: ${err.message}`)
      );
    }
  }

  /**
   * Cancel a single task.
   * H1: Clears lease timer on cancel.
   * M4: Logs DB errors instead of swallowing.
   */
  private async cancelTask(task: SubAgentTask): Promise<void> {
    const runner = this.runners.get(task.taskId);
    runner?.cancel();
    this.runners.delete(task.taskId);

    // H1: Clear lease timer
    this.clearLeaseTimer(task.taskId);

    task.completedAt = Date.now();
    this.transitionTask(task, 'CANCELLED');

    // M4: Log DB errors
    await this.db.appendSubAgentEvent(task.conversationId, 'subtask_cancelled', {
      groupId: task.groupId,
      taskId: task.taskId,
      conversationId: task.conversationId,
      timestamp: Date.now(),
    }, task.userId).catch(err =>
      console.error(`[SubAgentManager] Failed to log subtask_cancelled: ${err.message}`)
    );
  }

  /**
   * H1: Clear and remove a lease timer.
   */
  private clearLeaseTimer(taskId: string): void {
    const timer = this.leaseTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.leaseTimers.delete(taskId);
    }
  }

  /**
   * Transition task state with validation.
   * H2: Returns boolean indicating success (true) or failure (false).
   * M1: OPEN state removed from state machine.
   */
  private transitionTask(task: SubAgentTask, newState: SubAgentState): boolean {
    const validTransitions: Record<SubAgentState, SubAgentState[]> = {
      QUEUED: ['RUNNING', 'CANCELLED', 'ERROR'],
      RUNNING: ['FINALIZING', 'FINALIZED', 'CANCELLED', 'ERROR'],
      FINALIZING: ['FINALIZED', 'CANCELLED', 'ERROR'],
      FINALIZED: [],
      CANCELLED: [],
      ERROR: [],
    };

    const allowed = validTransitions[task.state];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(
        `[SubAgentManager] Invalid transition ${task.state} → ${newState} for task ${task.taskId}`,
      );
      return false;
    }

    task.state = newState;
    return true;
  }

  /**
   * Prune expired entries from finalizeResultCache.
   */
  private pruneExpiredCache(): void {
    const now = Date.now();
    for (const [groupId, entry] of this.finalizeResultCache) {
      if (entry.expiresAt <= now) {
        this.finalizeResultCache.delete(groupId);
      }
    }
  }
}
