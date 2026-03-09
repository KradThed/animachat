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
import type { ResourceCoordinator } from '../services/resource-coordinator.js';
import type { McplHookManager } from '../services/mcpl-hook-manager.js';
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
  SubAgentStateSnapshot,
} from './types.js';

// =============================================================================
// Cache entry for finalized groups (survives group deletion)
// =============================================================================

interface FinalizeResultCacheEntry {
  conversationId: string;
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

  // Queued user messages (depth=1 per user per conversation, in-memory)
  // Key: `${conversationId}:${userId}` — per-user queue prevents privacy leaks in shared conversations
  private queuedMessages: Map<string, QueuedUserMessage> = new Map();

  // Global concurrency cap across all groups
  private globalRunning = 0;
  private readonly MAX_GLOBAL_CONCURRENT = 10;

  constructor(
    private llmClient: LLMClientAdapter,
    private contextBuilder: SubAgentContextBuilder,
    private branchStore: BranchEventStore,
    private notificationBus: NotificationBus,
    private db: Database,
    private resourceCoordinator?: ResourceCoordinator,
    private hookManager?: McplHookManager,
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

    // C4: forkPoint = snapshot of how many messages to include from parent.
    // Also save forkBranchId — the activeBranchId of the last INCLUDED message,
    // so context-builder can walk the correct branch path.
    const messages = await this.db.getConversationMessages(conversationId, userId);
    let forkPoint = messages.length;
    const last = messages[messages.length - 1];
    const lastBranch = last?.branches.find(b => b.id === last.activeBranchId);

    // If last turn = assistant (we're inside the tool-loop), the in-progress message
    // has tool_use blocks without matching tool_result — API rejects this.
    // Sub-agent needs context BEFORE the in-progress assistant message.
    if (lastBranch?.role === 'assistant') forkPoint = Math.max(0, forkPoint - 1);

    // forkBranchId: branch of last INCLUDED message (safe for forkPoint=0).
    // Validate activeBranchId actually exists in branches (corrupted state protection).
    let forkBranchId: string | null = null;
    if (forkPoint > 0) {
      const m = messages[forkPoint - 1];
      const active = m?.activeBranchId ?? null;
      const exists = active && m?.branches?.some(b => b.id === active);
      forkBranchId = exists ? active : (m?.branches?.[0]?.id ?? null);
    }

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
      forkBranchId,
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
      forkBranchId,
      timestamp: Date.now(),
    }, userId);

    // Start running if under concurrency limit
    this.maybeStartTasks(group);

    return task;
  }

  /**
   * Spawn multiple sub-agent tasks as a batch.
   *
   * Critical ordering:
   *   1. Validate input (before creating any state)
   *   2. Compute forkPoint ONCE
   *   3. Create group + ALL tasks in-memory (NO awaits between)
   *   4. Persist events (can await here — all tasks already in group.tasks Map)
   *   5. Start tasks (maybeStartTasks)
   *
   * This prevents the race where task 1 errors → auto-finalize → task 2 "group not found".
   */
  async spawnSubtasks(params: SpawnSubtasksParams): Promise<SubAgentTask[]> {
    const {
      conversationId,
      userId,
      maxConcurrent = 3,
      leaseMs = LEASE_MS,
    } = params;

    // Step 1: Input validation BEFORE creating any state
    if (!params.instructions?.length) {
      throw new Error('instructions must be a non-empty array');
    }
    for (const inst of params.instructions) {
      if (typeof inst !== 'string' || inst.trim() === '') {
        throw new Error('each instruction must be a non-empty string');
      }
    }

    // Step 2: Compute forkPoint ONCE (same logic as spawnSubtask)
    const messages = await this.db.getConversationMessages(conversationId, userId);
    let forkPoint = messages.length;
    const last = messages[messages.length - 1];
    const lastBranch = last?.branches.find(b => b.id === last.activeBranchId);
    if (lastBranch?.role === 'assistant') forkPoint = Math.max(0, forkPoint - 1);

    let forkBranchId: string | null = null;
    if (forkPoint > 0) {
      const m = messages[forkPoint - 1];
      const active = m?.activeBranchId ?? null;
      const exists = active && m?.branches?.some(b => b.id === active);
      forkBranchId = exists ? active : (m?.branches?.[0]?.id ?? null);
    }

    // Step 3: Create group + ALL tasks in-memory — NO awaits between task creation
    const groupId = uuidv4();
    const group: TaskGroup = {
      groupId,
      conversationId,
      userId,
      tasks: new Map(),
      config: { maxConcurrent, leaseMs },
      createdAt: Date.now(),
      finalizedAt: null,
    };

    const tasks: SubAgentTask[] = [];
    for (const instruction of params.instructions) {
      const taskId = uuidv4();
      const task: SubAgentTask = {
        taskId,
        groupId,
        conversationId,
        userId,
        instruction,
        state: 'QUEUED',
        forkPoint,
        forkBranchId,
        result: null,
        error: null,
        metrics: { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 },
        createdAt: Date.now(),
        completedAt: null,
      };
      group.tasks.set(taskId, task);
      tasks.push(task);
    }

    // Add group to memory AFTER all tasks are in the Map
    this.groups.set(groupId, group);

    // Step 4: Persist events (can await — all tasks already in group.tasks)
    try {
      await this.db.appendSubAgentEvent(conversationId, 'subtask_group_created', {
        groupId,
        conversationId,
        userId,
        config: group.config,
        timestamp: Date.now(),
      }, userId);

      for (const task of tasks) {
        await this.db.appendSubAgentEvent(conversationId, 'subtask_spawned', {
          groupId,
          taskId: task.taskId,
          conversationId,
          userId,
          instruction: task.instruction,
          forkPoint,
          forkBranchId,
          timestamp: Date.now(),
        }, userId);
      }
    } catch (err) {
      // Clean ALL state for this group — prevent zombie group in memory
      this.groups.delete(groupId);
      this.finalizingGroups.delete(groupId);
      for (const task of tasks) {
        this.startingTasks.delete(task.taskId);
        const timer = this.leaseTimers.get(task.taskId);
        if (timer) { clearTimeout(timer); this.leaseTimers.delete(task.taskId); }
      }
      throw new Error(`Failed to persist sub-agent group: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 5: Start tasks
    this.maybeStartTasks(group);

    return tasks;
  }

  // --------------------------------------------------------------------------
  // Poll & Results
  // --------------------------------------------------------------------------

  /**
   * Poll task group status (non-blocking).
   * Falls back to finalizeResultCache if group has been deleted.
   */
  pollSubtasks(groupId: string, conversationId?: string): { tasks: SubAgentResult[]; allTerminal: boolean } {
    const group = this.groups.get(groupId);
    if (!group) {
      // C3: Check cache for recently finalized groups
      const cached = this.finalizeResultCache.get(groupId);
      if (cached && cached.expiresAt > Date.now()) {
        return { tasks: cached.results, allTerminal: true };
      }
      return { tasks: [], allTerminal: true };
    }

    // BUG 11: Ownership validation
    if (conversationId && group.conversationId !== conversationId) {
      throw new Error('Group does not belong to this conversation');
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
  getSubtaskResults(groupId: string, conversationId?: string): { results: SubAgentResult[] } {
    const group = this.groups.get(groupId);
    if (!group) {
      // C3: Check cache for recently finalized groups
      const cached = this.finalizeResultCache.get(groupId);
      if (cached && cached.expiresAt > Date.now()) {
        return { results: cached.results };
      }
      return { results: [] };
    }

    // BUG 11: Ownership validation
    if (conversationId && group.conversationId !== conversationId) {
      throw new Error('Group does not belong to this conversation');
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

  /**
   * Like getSubtaskResults but also returns conversationId for access control
   * and a `found` flag to distinguish "group exists but empty results" from "group not found".
   */
  getSubtaskResultsWithMeta(groupId: string): {
    found: boolean;
    results: SubAgentResult[];
    conversationId: string | null;
  } {
    const group = this.groups.get(groupId);
    if (group) {
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
      return { found: true, results, conversationId: group.conversationId };
    }

    // Check cache for recently finalized groups
    const cached = this.finalizeResultCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
      return { found: true, results: cached.results, conversationId: cached.conversationId };
    }

    return { found: false, results: [], conversationId: null };
  }

  // --------------------------------------------------------------------------
  // Cancel & Finalize
  // --------------------------------------------------------------------------

  /**
   * Cancel all running tasks in a group.
   */
  async cancelSubtasks(groupId: string, conversationId?: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;

    // BUG 11: Ownership validation
    if (conversationId && group.conversationId !== conversationId) {
      throw new Error('Group does not belong to this conversation');
    }

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
  async finalizeTaskGroup(groupId: string, autoFinalized: boolean = false, conversationId?: string): Promise<FinalizeResult> {
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

    // SA-3: Ownership validation (matches pollSubtasks/cancelSubtasks pattern)
    if (conversationId && group.conversationId !== conversationId) {
      throw new Error('Group does not belong to this conversation');
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
        conversationId: group.conversationId,
        results,
        expiresAt: Date.now() + FINALIZE_CACHE_TTL_MS,
      });

      // Notify bus
      this.notificationBus.unfreezeParent(group.conversationId, groupId, autoFinalized);

      // Check if the group owner has a queued message
      const ownerQueued = this.getQueuedMessage(group.conversationId, group.userId);
      return {
        status: 'ok',
        groupId,
        results,
        queuedUserTurn: ownerQueued?.text ?? null,
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
   * Depth=1 per user per conversation — each user gets their own queue slot.
   */
  queueUserMessage(msg: QueuedUserMessage): void {
    const key = `${msg.conversationId}:${msg.userId}`;
    if (this.queuedMessages.has(key)) {
      // Idempotent: already queued for this user — caller should resend subtask_queue_blocked
      return;
    }
    this.queuedMessages.set(key, msg);
  }

  /**
   * Get the queued user message for a specific user in a conversation (if any).
   */
  getQueuedMessage(conversationId: string, userId: string): QueuedUserMessage | null {
    return this.queuedMessages.get(`${conversationId}:${userId}`) ?? null;
  }

  /**
   * Release (send) the queued user message after finalize.
   */
  releaseQueuedMessage(conversationId: string, userId: string): QueuedUserMessage | null {
    const key = `${conversationId}:${userId}`;
    const msg = this.queuedMessages.get(key);
    if (msg) {
      this.queuedMessages.delete(key);
    }
    return msg ?? null;
  }

  /**
   * Cancel (discard) the queued user message.
   */
  cancelQueuedMessage(conversationId: string, userId: string): void {
    this.queuedMessages.delete(`${conversationId}:${userId}`);
  }

  // --------------------------------------------------------------------------
  // State Snapshot (for UI panel)
  // --------------------------------------------------------------------------

  /**
   * Get current sub-agent state for a conversation + user.
   * Used by subtask_get_state WS handler to hydrate SubAgentPanel on page refresh.
   *
   * Checks:
   *   1. Active in-memory group (live sub-agents)
   *   2. FinalizeResultCache (post-finalize, group already deleted)
   *   3. Returns empty state if no sub-agent activity
   */
  getStateSnapshot(conversationId: string, userId: string): SubAgentStateSnapshot {
    // 1. Check active group
    const group = this.findGroupForConversation(conversationId);
    if (group) {
      const tasks = [...group.tasks.values()].map(t => ({
        taskId: t.taskId,
        instructionPreview: truncateInstruction(t.instruction),
        status: t.state,
      }));
      const queuedMsg = this.getQueuedMessage(conversationId, userId);
      return {
        active: group.finalizedAt === null,
        groupId: group.groupId,
        tasks,
        finalized: group.finalizedAt !== null,
        hasResults: group.finalizedAt !== null,
        queuedText: queuedMsg?.text ?? null,
      };
    }

    // 2. Check finalizeResultCache (post-finalize refresh)
    for (const [groupId, entry] of this.finalizeResultCache) {
      if (entry.conversationId === conversationId && entry.expiresAt > Date.now()) {
        const tasks = entry.results.map(r => ({
          taskId: r.taskId,
          instructionPreview: truncateInstruction(r.instruction),
          status: r.state,
        }));
        const queuedMsg = this.getQueuedMessage(conversationId, userId);
        return {
          active: false,
          groupId,
          tasks,
          finalized: true,
          hasResults: true,
          queuedText: queuedMsg?.text ?? null,
        };
      }
    }

    // 3. No sub-agent activity
    return { active: false, groupId: null, tasks: [], finalized: false, hasResults: false, queuedText: null };
  }

  /**
   * Find the active (non-finalized) group for a conversation.
   */
  private findGroupForConversation(conversationId: string): TaskGroup | null {
    for (const group of this.groups.values()) {
      if (group.conversationId === conversationId) {
        return group;
      }
    }
    return null;
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
          // SA-4: Delete orphaned branch file (task is no longer tracked in any group)
          console.warn(`[SubAgentManager] Deleting orphaned branch file: ${taskId}`);
          try {
            await this.branchStore.deleteTask(taskId);
          } catch (err) {
            console.error(`[SubAgentManager] Failed to delete orphaned branch ${taskId}:`, err);
          }
          recovered++;
        }
      }

      if (recovered > 0) {
        console.log(`[SubAgentManager] Cleaned up ${recovered} orphaned branch files`);
      }
    } catch (error) {
      console.warn('[SubAgentManager] Failed to scan for orphaned tasks:', error);
    }
  }

  /**
   * BUG 1: Recover stale groups after restart.
   * After replay, groups with non-terminal tasks are stuck forever.
   * Transition them to ERROR (with lifecycle events) then finalize.
   */
  /**
   * Recover stale groups globally (called at startup for any pre-loaded groups).
   */
  async recoverStaleGroups(): Promise<void> {
    for (const [groupId, group] of this.groups) {
      await this.recoverStaleGroup(groupId, group);
    }
  }

  /**
   * Recover stale groups for a specific conversation (called after loadConversation replay).
   * Groups with non-terminal tasks are marked ERROR and auto-finalized.
   */
  async recoverStaleGroupsForConversation(conversationId: string): Promise<void> {
    for (const [groupId, group] of this.groups) {
      if (group.conversationId !== conversationId) continue;
      await this.recoverStaleGroup(groupId, group);
    }
  }

  private async recoverStaleGroup(groupId: string, group: TaskGroup): Promise<void> {
    if (group.finalizedAt !== null) return;
    const nonTerminal = [...group.tasks.values()].filter(
      t => !TERMINAL_STATUSES.includes(t.state),
    );
    if (nonTerminal.length === 0) return;

    console.log(`[Recovery] Group ${groupId}: ${nonTerminal.length} non-terminal tasks, marking ERROR`);

    for (const task of nonTerminal) {
      this.transitionTask(task, 'ERROR');
      task.error = 'Interrupted by server restart';
      task.completedAt = Date.now();
      // Persist lifecycle event (transitionTask only changes state in memory)
      await this.db.appendSubAgentEvent(task.conversationId, 'subtask_error', {
        groupId: task.groupId,
        taskId: task.taskId,
        conversationId: task.conversationId,
        error: task.error,
        timestamp: Date.now(),
      }, task.userId).catch(err =>
        console.error(`[Recovery] Failed to log subtask_error: ${err.message}`)
      );
    }

    // SA#8: await finalization — caller must handle the result before proceeding
    // finalizeTaskGroup sees all tasks terminal → skips cancel → writes group_finalized event
    await this.finalizeTaskGroup(groupId, true).catch(err =>
      console.error(`[Recovery] Failed to finalize stale group ${groupId}:`, err)
    );
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
    const conversationId = data.conversationId;
    const userId = data.userId;
    const key = `${conversationId}:${userId}`;
    this.queuedMessages.set(key, {
      messageId: data.messageId,
      conversationId,
      userId,
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
      case 'subtask_error':
        this.replayTaskTerminal(event.data, event.type);
        break;
      case 'subtask_group_finalized':
      case 'subtask_group_auto_finalized':
        this.replayGroupFinalized(event.data);
        break;
      case 'queued_user_turn_released':
      case 'queued_user_turn_cancelled': {
        const convId = event.data._conversationId ?? event.data.conversationId;
        const uid = event.data.userId;
        if (convId && uid) {
          this.queuedMessages.delete(`${convId}:${uid}`);
        }
        break;
      }
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
      forkBranchId: data.forkBranchId ?? null,
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
      case 'subtask_error':
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
    // BUG 3: Global concurrency cap
    if (this.globalRunning >= this.MAX_GLOBAL_CONCURRENT) return;

    const runningCount = [...group.tasks.values()].filter(
      t => t.state === 'RUNNING',
    ).length;

    const available = Math.min(
      group.config.maxConcurrent - runningCount,
      this.MAX_GLOBAL_CONCURRENT - this.globalRunning,
    );
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
      this.resourceCoordinator,
      this.hookManager,
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

    // BUG 3: Track global concurrency
    this.globalRunning++;

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
          truncateInstruction(task.instruction),
        );

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
          truncateInstruction(task.instruction),
        );

        // C6: Auto-finalize safety net — check if ALL tasks in group are terminal
        this.maybeAutoFinalize(group);
      })
      .finally(() => {
        // BUG 3: Guaranteed decrement + unblock tasks from ALL groups waiting for global slot
        this.globalRunning--;
        // SA#3: Guard against stale group reference — group may have been deleted
        if (this.groups.has(group.groupId)) {
          this.maybeStartTasks(group);
        }
        for (const g of this.groups.values()) {
          if (g.groupId !== group.groupId && g.finalizedAt === null) {
            this.maybeStartTasks(g);
          }
        }
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
    const hasQueued = [...group.tasks.values()].some(
      t => t.state === 'QUEUED',
    );

    if (allTerminal && !hasQueued) {
      console.log(`[SubAgentManager] All tasks terminal in group ${group.groupId}, auto-finalizing`);

      // Broadcast auto-finalize notification to UI
      this.notificationBus.notifyParent(
        group.conversationId,
        group.groupId,
        '',  // no specific taskId
        'FINALIZED',
      );

      this.finalizeTaskGroup(group.groupId, true).catch(err =>
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

// =============================================================================
// Module-level Helpers
// =============================================================================

/** Max chars for instructionPreview in WS broadcasts (reduces traffic). */
const INSTRUCTION_PREVIEW_MAX = 80;

/**
 * Truncate instruction for WS broadcasts. Full text stays in task memory/branch log.
 */
function truncateInstruction(instruction: string): string {
  if (instruction.length <= INSTRUCTION_PREVIEW_MAX) return instruction;
  return instruction.slice(0, INSTRUCTION_PREVIEW_MAX) + '...';
}
