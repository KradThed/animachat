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
  MAX_RETRIES_CAP,
  RETRY_BASE_DELAY_MS,
  MAX_RESUME_COUNT,
} from './types.js';
import type {
  SubAgentTask,
  SubAgentState,
  SubAgentContext,
  TaskGroup,
  TaskGroupConfig,
  TaskMetrics,
  SubAgentResult,
  FinalizeResult,
  SpawnSubtaskParams,
  SpawnSubtaskInstruction,
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

/** BUG#9: Maximum tasks allowed per group. */
const MAX_TASKS_PER_GROUP = 20;

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
      context,
      maxConcurrent = 3,
      leaseMs = LEASE_MS,
      dependsOn,
      maxRetries,
      tokenBudget,
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

    // BUG#6: Prevent multiple active groups per conversation
    if (!groupId) {
      const existingGroupId = this.getBlockingGroupId(conversationId);
      if (existingGroupId) {
        throw new Error(
          `Conversation ${conversationId} already has an active group ${existingGroupId}. ` +
          `Finalize it before spawning a new group, or pass groupId to add tasks to the existing group.`
        );
      }
    }

    if (groupId && this.groups.has(groupId)) {
      group = this.groups.get(groupId)!;

      // BUG#9: Limit tasks per group
      if (group.tasks.size >= MAX_TASKS_PER_GROUP) {
        throw new Error(`Group ${groupId} already has ${group.tasks.size} tasks (max: ${MAX_TASKS_PER_GROUP})`);
      }

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

    // Feature C: Validate dependsOn references (single-task: no cycle possible since task doesn't exist yet)
    if (dependsOn?.length) {
      this.validateDependsOn(dependsOn, group);
    }

    // Create task
    const taskId = uuidv4();
    const cappedMaxRetries = maxRetries ? Math.min(maxRetries, MAX_RETRIES_CAP) : undefined;
    const task: SubAgentTask = {
      taskId,
      groupId,
      conversationId,
      userId,
      instruction,
      ...(context ? { context } : {}),
      ...(dependsOn?.length ? { dependsOn } : {}),
      state: 'QUEUED',
      forkPoint,
      forkBranchId,
      result: null,
      error: null,
      metrics: { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 },
      // BUG#14: Store per-task leaseMs (only if different from group default)
      ...(leaseMs !== group.config.leaseMs ? { leaseMs } : {}),
      ...(cappedMaxRetries ? { maxRetries: cappedMaxRetries } : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
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
      ...(context ? { context } : {}),
      ...(dependsOn?.length ? { dependsOn } : {}),
      ...(cappedMaxRetries ? { maxRetries: cappedMaxRetries } : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
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
      context,
      maxConcurrent = 3,
      leaseMs = LEASE_MS,
      maxRetries,
      tokenBudget,
    } = params;

    // Step 1: Input validation BEFORE creating any state
    if (!params.instructions?.length) {
      throw new Error('instructions must be a non-empty array');
    }

    // Feature C: Normalize instructions to structured format
    const normalizedInstructions: SpawnSubtaskInstruction[] = params.instructions.map(inst => {
      if (typeof inst === 'string') {
        if (inst.trim() === '') throw new Error('each instruction must be a non-empty string');
        return { instruction: inst };
      }
      if (typeof inst === 'object' && inst !== null && typeof inst.instruction === 'string') {
        if (inst.instruction.trim() === '') throw new Error('each instruction must be a non-empty string');
        return inst;
      }
      throw new Error('each instruction must be a non-empty string or {instruction, dependsOn?, context?}');
    });

    // BUG#6: Prevent multiple active groups per conversation
    const existingGroupId = this.getBlockingGroupId(conversationId);
    if (existingGroupId) {
      throw new Error(
        `Conversation ${conversationId} already has an active group ${existingGroupId}. ` +
        `Finalize it before spawning a new group.`
      );
    }

    // BUG#9: Limit tasks per group
    if (normalizedInstructions.length > MAX_TASKS_PER_GROUP) {
      throw new Error(`Cannot spawn more than ${MAX_TASKS_PER_GROUP} tasks per group`);
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

    // Step 3a: Generate all taskIds upfront (needed for dependency validation)
    const groupId = uuidv4();
    const taskIdMap = new Map<number, string>();
    for (let i = 0; i < normalizedInstructions.length; i++) {
      taskIdMap.set(i, uuidv4());
    }
    const newTaskIds = new Set(taskIdMap.values());

    // Step 3b: Feature C — Validate dependencies and detect cycles
    const taskDepsForCycle = new Map<string, string[]>();
    for (let i = 0; i < normalizedInstructions.length; i++) {
      const inst = normalizedInstructions[i];
      const taskId = taskIdMap.get(i)!;
      const deps = inst.dependsOn ?? [];
      if (deps.length > 0) {
        // Deps can reference sibling tasks in this batch OR existing group tasks (none for new group)
        for (const depId of deps) {
          if (!newTaskIds.has(depId)) {
            throw new Error(
              `dependsOn references unknown task ${depId}. ` +
              `Dependencies must be tasks in the same group.`
            );
          }
        }
      }
      taskDepsForCycle.set(taskId, deps);
    }
    if (this.hasCycle(taskDepsForCycle)) {
      throw new Error('Circular dependency detected in dependsOn');
    }

    // Step 3c: Create group + ALL tasks in-memory — NO awaits between task creation
    const group: TaskGroup = {
      groupId,
      conversationId,
      userId,
      tasks: new Map(),
      config: { maxConcurrent, leaseMs },
      createdAt: Date.now(),
      finalizedAt: null,
    };

    const cappedMaxRetries = maxRetries ? Math.min(maxRetries, MAX_RETRIES_CAP) : undefined;
    const tasks: SubAgentTask[] = [];
    for (let i = 0; i < normalizedInstructions.length; i++) {
      const inst = normalizedInstructions[i];
      const taskId = taskIdMap.get(i)!;
      // Per-task context merges with group context (per-task overrides)
      const mergedContext: SubAgentContext | undefined =
        inst.context && context ? { ...context, ...inst.context } :
        inst.context ? inst.context :
        context ? context : undefined;
      const task: SubAgentTask = {
        taskId,
        groupId,
        conversationId,
        userId,
        instruction: inst.instruction,
        ...(mergedContext ? { context: mergedContext } : {}),
        ...(inst.dependsOn?.length ? { dependsOn: inst.dependsOn } : {}),
        state: 'QUEUED',
        forkPoint,
        forkBranchId,
        result: null,
        error: null,
        metrics: { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 },
        ...(cappedMaxRetries ? { maxRetries: cappedMaxRetries } : {}),
        ...(tokenBudget ? { tokenBudget } : {}),
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
          ...(task.context ? { context: task.context } : {}),
          ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}),
          ...(task.maxRetries ? { maxRetries: task.maxRetries } : {}),
          ...(task.tokenBudget ? { tokenBudget: task.tokenBudget } : {}),
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
  // Task-Level Operations
  // --------------------------------------------------------------------------

  /**
   * Look up a single task by taskId across all active groups.
   * Returns the task and its group, or null if not found.
   */
  getTask(taskId: string, conversationId?: string): { task: SubAgentTask; group: TaskGroup } | null {
    for (const group of this.groups.values()) {
      const task = group.tasks.get(taskId);
      if (task) {
        // BUG 11: Ownership validation
        if (conversationId && group.conversationId !== conversationId) {
          throw new Error('Task does not belong to this conversation');
        }
        return { task, group };
      }
    }
    return null;
  }

  /**
   * Update the instruction for a QUEUED task.
   * Only works if the task has not started running yet.
   */
  async updateTaskInstruction(
    taskId: string,
    newInstruction: string,
    conversationId: string,
    userId: string,
  ): Promise<SubAgentTask> {
    const found = this.getTask(taskId, conversationId);
    if (!found) {
      throw new Error(`Task ${taskId} not found`);
    }

    const { task } = found;

    if (task.state !== 'QUEUED') {
      throw new Error(`Cannot update instruction: task ${taskId} is ${task.state} (must be QUEUED)`);
    }

    const previousInstruction = task.instruction;
    task.instruction = newInstruction;

    // Persist lifecycle event
    await this.db.appendSubAgentEvent(conversationId, 'subtask_instruction_updated', {
      groupId: task.groupId,
      taskId,
      conversationId,
      userId,
      instruction: newInstruction,
      previousInstruction,
      timestamp: Date.now(),
    }, userId);

    return task;
  }

  /**
   * Get intermediate progress of a running task.
   * Reads events from BranchEventStore to extract tool call info.
   */
  async getTaskProgress(
    taskId: string,
    conversationId: string,
    maxEvents: number = 20,
  ): Promise<{
    taskId: string;
    state: SubAgentState;
    instruction: string;
    toolsCalled: string[];
    eventCount: number;
    lastActivityAt: number | null;
    metrics: TaskMetrics;
  }> {
    const found = this.getTask(taskId, conversationId);
    if (!found) {
      throw new Error(`Task ${taskId} not found`);
    }

    const { task } = found;

    // Load branch events for this task
    const events = await this.branchStore.loadEvents(taskId);

    // Extract tool names from events
    const toolsCalled: string[] = [];
    let lastActivityAt: number | null = null;

    for (const event of events) {
      if (event.timestamp) {
        const ts = event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp);
        if (lastActivityAt === null || ts > lastActivityAt) {
          lastActivityAt = ts;
        }
      }

      // Tool calls are embedded in assistant_message contentBlocks
      if (event.type === 'assistant_message' && event.data?.contentBlocks) {
        for (const block of event.data.contentBlocks) {
          if (block.type === 'tool_use' && block.name) {
            toolsCalled.push(block.name);
          }
        }
      }
    }

    return {
      taskId,
      state: task.state,
      instruction: task.instruction,
      toolsCalled: toolsCalled.slice(-maxEvents),
      eventCount: events.length,
      lastActivityAt,
      metrics: task.metrics,
    };
  }

  /**
   * Dynamically update maxConcurrent for a group.
   * If increased, immediately attempts to start queued tasks.
   */
  setGroupConcurrency(
    groupId: string,
    maxConcurrent: number,
    conversationId: string,
  ): TaskGroupConfig {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // BUG 11: Ownership validation
    if (group.conversationId !== conversationId) {
      throw new Error('Group does not belong to this conversation');
    }

    // Validate bounds
    if (maxConcurrent < 1 || maxConcurrent > this.MAX_GLOBAL_CONCURRENT) {
      throw new Error(`maxConcurrent must be between 1 and ${this.MAX_GLOBAL_CONCURRENT}`);
    }

    const oldConcurrency = group.config.maxConcurrent;
    group.config.maxConcurrent = maxConcurrent;

    // If concurrency increased, try to start queued tasks
    if (maxConcurrent > oldConcurrency) {
      this.maybeStartTasks(group);
    }

    return { ...group.config };
  }

  /**
   * Get aggregated metrics across all tasks in a group.
   * Works from in-memory groups or finalizeResultCache.
   */
  getGroupMetrics(
    groupId: string,
    conversationId: string,
  ): {
    groupId: string;
    taskCount: number;
    completedCount: number;
    errorCount: number;
    cancelledCount: number;
    runningCount: number;
    queuedCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    totalDurationMs: number;
  } {
    // Try active group first
    const group = this.groups.get(groupId);
    if (group) {
      if (group.conversationId !== conversationId) {
        throw new Error('Group does not belong to this conversation');
      }
      return this.aggregateGroupMetrics(groupId, [...group.tasks.values()]);
    }

    // Fallback to cache
    const cached = this.finalizeResultCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.conversationId !== conversationId) {
        throw new Error('Group does not belong to this conversation');
      }
      return this.aggregateGroupMetrics(groupId, cached.results.map(r => ({
        state: r.state,
        metrics: r.metrics,
      })));
    }

    throw new Error(`Group ${groupId} not found`);
  }

  private aggregateGroupMetrics(
    groupId: string,
    tasks: Array<{ state: SubAgentState | string; metrics: TaskMetrics }>,
  ): {
    groupId: string;
    taskCount: number;
    completedCount: number;
    errorCount: number;
    cancelledCount: number;
    runningCount: number;
    queuedCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    totalDurationMs: number;
  } {
    let completedCount = 0, errorCount = 0, cancelledCount = 0;
    let runningCount = 0, queuedCount = 0;
    let totalInputTokens = 0, totalOutputTokens = 0;
    let totalToolCalls = 0, totalDurationMs = 0;

    for (const t of tasks) {
      switch (t.state) {
        case 'FINALIZED': completedCount++; break;
        case 'ERROR': errorCount++; break;
        case 'CANCELLED': cancelledCount++; break;
        case 'RUNNING': case 'FINALIZING': runningCount++; break;
        case 'QUEUED': queuedCount++; break;
      }
      totalInputTokens += t.metrics.inputTokens;
      totalOutputTokens += t.metrics.outputTokens;
      totalToolCalls += t.metrics.toolCalls;
      totalDurationMs += t.metrics.durationMs;
    }

    return {
      groupId,
      taskCount: tasks.length,
      completedCount, errorCount, cancelledCount, runningCount, queuedCount,
      totalInputTokens, totalOutputTokens, totalToolCalls, totalDurationMs,
    };
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
      let hasNonTerminal = false;
      for (const task of group.tasks.values()) {
        if (!TERMINAL_STATUSES.includes(task.state)) {
          hasNonTerminal = true;
          this.transitionTask(task, 'FINALIZING');
          const runner = this.runners.get(task.taskId);
          runner?.cancel();
        }
      }

      // BUG#2: Only wait grace period if there are actually non-terminal tasks.
      // Poll every 500ms instead of blind 10s sleep — exit early when all terminal.
      if (hasNonTerminal) {
        const deadline = Date.now() + FINALIZE_GRACE_MS;
        while (Date.now() < deadline) {
          const stillRunning = [...group.tasks.values()].some(
            t => !TERMINAL_STATUSES.includes(t.state),
          );
          if (!stillRunning) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Force-cancel anything still running after grace period
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
   * BUG#7: Filter by finalizedAt === null to skip finalized groups still in memory.
   */
  private findGroupForConversation(conversationId: string): TaskGroup | null {
    for (const group of this.groups.values()) {
      if (group.conversationId === conversationId && group.finalizedAt === null) {
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
      // BUG#3: Restore attachments from JSONL
      ...(data.attachments?.length ? { attachments: data.attachments } : {}),
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
      // BUG#8: Handle subtask_started (QUEUED → RUNNING transition)
      case 'subtask_started':
        this.replayTaskStarted(event.data);
        break;
      case 'subtask_completed':
      case 'subtask_cancelled':
      case 'subtask_failed':
      case 'subtask_error':
        this.replayTaskTerminal(event.data, event.type);
        break;
      // Feature C: Dependency failure (task already transitioned to ERROR by cascade)
      case 'subtask_dep_failed':
        this.replayTaskTerminal(event.data, event.type);
        break;
      // Feature F: Task retrying — transition back to QUEUED
      case 'subtask_retrying':
        this.replayTaskRetrying(event.data);
        break;
      // Feature D: Task resumed — transition terminal → QUEUED
      case 'subtask_resumed':
        this.replayTaskResumed(event.data);
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
      ...(data.context ? { context: data.context } : {}),
      ...(data.dependsOn?.length ? { dependsOn: data.dependsOn } : {}),
      state: 'QUEUED', // will be updated by terminal events
      forkPoint: data.forkPoint ?? 0,
      forkBranchId: data.forkBranchId ?? null,
      result: null,
      error: null,
      metrics: { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 },
      ...(data.maxRetries ? { maxRetries: data.maxRetries } : {}),
      ...(data.retryCount ? { retryCount: data.retryCount } : {}),
      ...(data.tokenBudget ? { tokenBudget: data.tokenBudget } : {}),
      createdAt: data.timestamp ?? Date.now(),
      completedAt: null,
    });
  }

  /** BUG#8: Replay subtask_started — transition QUEUED → RUNNING. */
  private replayTaskStarted(data: any): void {
    const group = this.groups.get(data.groupId);
    if (!group) return;
    const task = group.tasks.get(data.taskId);
    if (!task) return;
    if (task.state === 'QUEUED') {
      task.state = 'RUNNING';
    }
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

  /** Feature F: Replay subtask_retrying — transition back to QUEUED with retry info. */
  private replayTaskRetrying(data: any): void {
    const group = this.groups.get(data.groupId);
    if (!group) return;
    const task = group.tasks.get(data.taskId);
    if (!task) return;
    task.state = 'QUEUED';
    task.retryCount = data.retryCount ?? (task.retryCount ?? 0) + 1;
    // nextRetryAt from past = eligible immediately on recovery
    task.nextRetryAt = undefined;
  }

  /** Feature D: Replay subtask_resumed — transition terminal → QUEUED. */
  private replayTaskResumed(data: any): void {
    const group = this.groups.get(data.groupId);
    if (!group) return;
    const task = group.tasks.get(data.taskId);
    if (!task) return;
    task.state = 'QUEUED';
    task.resumeCount = data.resumeCount ?? (task.resumeCount ?? 0) + 1;
    task.retryCount = 0; // Fresh retry budget on resume
    task.error = null;
    task.result = null;
    task.completedAt = null;
    if (data.instruction) {
      task.instruction = data.instruction;
    }
  }

  // --------------------------------------------------------------------------
  // Feature C: Dependency Management
  // --------------------------------------------------------------------------

  /**
   * Detect cycles in dependency graph using Kahn's algorithm (topological sort).
   * @param taskDeps Map of taskId → dependsOn array (all tasks in the graph)
   * @returns true if cycle detected (DAG is invalid)
   */
  private hasCycle(taskDeps: Map<string, string[]>): boolean {
    // Build in-degree map
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const [taskId, deps] of taskDeps) {
      if (!inDegree.has(taskId)) inDegree.set(taskId, 0);
      for (const dep of deps) {
        if (!adj.has(dep)) adj.set(dep, []);
        adj.get(dep)!.push(taskId);
        inDegree.set(taskId, (inDegree.get(taskId) ?? 0) + 1);
        // Ensure dep node is in graph
        if (!inDegree.has(dep)) inDegree.set(dep, 0);
      }
    }

    // BFS from zero-in-degree nodes
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      processed++;
      for (const dependent of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) queue.push(dependent);
      }
    }

    // If we couldn't process all nodes, there's a cycle
    return processed < inDegree.size;
  }

  /**
   * Validate that all dependsOn references exist in the group or in newTaskIds (sibling batch tasks).
   */
  private validateDependsOn(dependsOn: string[], group: TaskGroup, newTaskIds?: Set<string>): void {
    for (const depId of dependsOn) {
      const inGroup = group.tasks.has(depId);
      const inNew = newTaskIds?.has(depId) ?? false;
      if (!inGroup && !inNew) {
        throw new Error(
          `dependsOn references unknown task ${depId}. ` +
          `Dependencies must be tasks in the same group.`
        );
      }
    }
  }

  /**
   * Check if all dependencies of a task are satisfied.
   * @returns 'ready' (all FINALIZED), 'waiting' (some non-terminal), 'failed' (any ERROR/CANCELLED)
   */
  private checkDependencies(task: SubAgentTask, group: TaskGroup): 'ready' | 'waiting' | 'failed' {
    if (!task.dependsOn?.length) return 'ready';

    for (const depId of task.dependsOn) {
      const dep = group.tasks.get(depId);
      if (!dep) return 'failed'; // dep missing (should not happen after validation)
      if (dep.state === 'ERROR' || dep.state === 'CANCELLED') return 'failed';
      if (dep.state !== 'FINALIZED') return 'waiting';
    }
    return 'ready';
  }

  /**
   * Auto-inject dependency results into task.context.previousResults.
   * Truncates each result to MAX_RESULT_DISPLAY (4000 chars) to match existing truncation pattern.
   */
  private injectDependencyResults(task: SubAgentTask, group: TaskGroup): void {
    if (!task.dependsOn?.length) return;

    const MAX_DEP_RESULT = 4000; // Same as MAX_RESULT_FULL in sub-agent-tools.ts
    const depResults: string[] = [];
    for (const depId of task.dependsOn) {
      const dep = group.tasks.get(depId);
      if (dep?.result) {
        const truncated = dep.result.length > MAX_DEP_RESULT
          ? dep.result.slice(0, MAX_DEP_RESULT) + `...(truncated, ${dep.result.length} total chars)`
          : dep.result;
        depResults.push(`[${dep.taskId}]: ${truncated}`);
      }
    }

    if (depResults.length > 0) {
      if (!task.context) task.context = {};
      const existing = task.context.previousResults ?? [];
      task.context.previousResults = [...existing, ...depResults];
    }
  }

  /**
   * Cascade dependency failure: transition task to ERROR with descriptive message.
   * Multi-level cascades resolve via eventual consistency across maybeStartTasks calls.
   */
  private async cascadeDepFailure(task: SubAgentTask, group: TaskGroup): Promise<void> {
    const failedDeps = (task.dependsOn ?? []).filter(depId => {
      const dep = group.tasks.get(depId);
      return dep && (dep.state === 'ERROR' || dep.state === 'CANCELLED');
    });

    const ok = this.transitionTask(task, 'ERROR');
    if (!ok) return;

    task.error = `Dependency failed: ${failedDeps.join(', ')}`;
    task.completedAt = Date.now();

    await this.db.appendSubAgentEvent(task.conversationId, 'subtask_dep_failed', {
      groupId: task.groupId,
      taskId: task.taskId,
      conversationId: task.conversationId,
      failedDependencies: failedDeps,
      error: task.error,
      timestamp: Date.now(),
    }, task.userId).catch(err =>
      console.error(`[SubAgentManager] Failed to log subtask_dep_failed: ${err.message}`)
    );

    this.notificationBus.notifyParent(
      task.conversationId,
      task.groupId,
      task.taskId,
      'ERROR',
      truncateInstruction(task.instruction),
    );

    // Check if more cascades needed or group should auto-finalize
    this.maybeAutoFinalize(group);
  }

  // --------------------------------------------------------------------------
  // Feature F: Retry Error Classification
  // --------------------------------------------------------------------------

  /** Transient error patterns that warrant automatic retry. */
  private static readonly RETRYABLE_PATTERNS = [
    /429/,                     // Rate limit
    /500/,                     // Internal server error
    /502/,                     // Bad gateway
    /503/,                     // Service unavailable
    /network.*timeout/i,       // Network timeout
    /ECONNRESET/,              // Connection reset
    /ECONNREFUSED/,            // Connection refused
    /ETIMEDOUT/,               // Connection timed out
  ];

  /** Errors that should NOT be retried (takes precedence over retryable patterns). */
  private static readonly NON_RETRYABLE_PATTERNS = [
    /context.*too.*long/i,                // Context window exceeded
    /invalid.*response/i,                 // Invalid LLM response
    /cancelled/i,                         // User cancellation
    /Task cancelled/i,                    // Our own cancellation
    /MCPL beforeInference aborted/i,      // Hook abort
    /Dependency failed/i,                 // Feature C: cascade errors
  ];

  private isRetryableError(error: Error): boolean {
    const msg = error.message;
    // Non-retryable takes precedence
    for (const pattern of SubAgentManager.NON_RETRYABLE_PATTERNS) {
      if (pattern.test(msg)) return false;
    }
    // Check retryable patterns
    for (const pattern of SubAgentManager.RETRYABLE_PATTERNS) {
      if (pattern.test(msg)) return true;
    }
    return false; // Default: not retryable
  }

  // --------------------------------------------------------------------------
  // Feature D: Agent Resumption
  // --------------------------------------------------------------------------

  /**
   * Resume a terminal task: re-queue it with preserved branch events.
   * The sub-agent will restart with its previous tool-loop context.
   */
  async resumeTask(
    taskId: string,
    conversationId: string,
    userId: string,
    newInstruction?: string,
  ): Promise<SubAgentTask> {
    const found = this.getTask(taskId, conversationId);
    if (!found) {
      throw new Error(`Task ${taskId} not found`);
    }

    const { task, group } = found;

    // Must be terminal
    if (!TERMINAL_STATUSES.includes(task.state)) {
      throw new Error(`Cannot resume task ${taskId}: state is ${task.state} (must be terminal)`);
    }

    // Safety cap
    const resumeCount = (task.resumeCount ?? 0) + 1;
    if (resumeCount > MAX_RESUME_COUNT) {
      throw new Error(
        `Cannot resume task ${taskId}: max resumes (${MAX_RESUME_COUNT}) reached`
      );
    }

    // Group must not be finalized
    if (group.finalizedAt !== null) {
      throw new Error(`Cannot resume task in finalized group ${group.groupId}`);
    }

    // C2: Group must not be in finalization
    if (this.finalizingGroups.has(group.groupId)) {
      throw new Error(`Cannot resume task: group ${group.groupId} is being finalized`);
    }

    const previousState = task.state;

    // Transition terminal → QUEUED (with isResume flag)
    const ok = this.transitionTask(task, 'QUEUED', true);
    if (!ok) {
      throw new Error(`Failed to transition task ${taskId} from ${task.state} to QUEUED`);
    }

    // Update task fields
    task.resumeCount = resumeCount;
    task.retryCount = 0; // Fresh retry budget on resume
    task.error = null;
    task.result = null;
    task.completedAt = null;
    task.metrics = { iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 };

    if (newInstruction) {
      task.instruction = newInstruction;
    }

    // Branch events are NOT deleted — context-builder loads them on next run
    // (BranchEventStore keys by taskId, same taskId = same events)

    // Persist lifecycle event
    await this.db.appendSubAgentEvent(conversationId, 'subtask_resumed', {
      groupId: task.groupId,
      taskId: task.taskId,
      conversationId,
      userId,
      resumeCount,
      ...(newInstruction ? { instruction: newInstruction } : {}),
      previousState,
      timestamp: Date.now(),
    }, userId);

    // Try to start immediately
    this.maybeStartTasks(group);

    return task;
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------

  /**
   * Clean up timers and cancel all running tasks on shutdown.
   * BUG#1: Must cancel InferenceRunners so in-flight LLM calls are aborted.
   */
  async shutdown(): Promise<void> {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
    }

    // Cancel all active runners (abort in-flight LLM calls)
    for (const [taskId, runner] of this.runners) {
      runner.cancel();
      this.runners.delete(taskId);
    }

    // Clear all lease timers
    for (const timer of this.leaseTimers.values()) {
      clearTimeout(timer);
    }
    this.leaseTimers.clear();

    // Mark all non-terminal tasks as CANCELLED
    for (const group of this.groups.values()) {
      for (const task of group.tasks.values()) {
        if (!TERMINAL_STATUSES.includes(task.state)) {
          this.transitionTask(task, 'CANCELLED');
          task.error = 'Server shutdown';
          task.completedAt = Date.now();
        }
      }
    }
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
    const now = Date.now();

    let started = 0;
    for (const task of queued) {
      if (started >= available) break;

      // C1: Guard 1 — skip if already being started by another callback
      if (this.startingTasks.has(task.taskId)) continue;

      // C1: Guard 2 — re-check state (may have changed between filter and loop)
      if (task.state !== 'QUEUED') continue;

      // Feature F: Skip tasks in backoff period (retry delay)
      if (task.nextRetryAt && task.nextRetryAt > now) continue;

      // Feature C: Check dependencies before starting
      if (task.dependsOn?.length) {
        const depCheck = this.checkDependencies(task, group);
        if (depCheck === 'waiting') continue;
        if (depCheck === 'failed') {
          // Cascade error — async, fire-and-forget
          this.cascadeDepFailure(task, group).catch(err =>
            console.error(`[SubAgentManager] cascadeDepFailure error: ${err.message}`)
          );
          continue;
        }
        // depCheck === 'ready' — inject dependency results and proceed
        this.injectDependencyResults(task, group);
      }

      this.startTask(task, group);
      started++;
    }
  }

  /**
   * Start a single task (async kick-off).
   * H1: Stores lease timer for cleanup.
   * H2: Checks transitionTask return before side-effects.
   * BUG#5: DB writes are awaited for crash-consistent state.
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
    // BUG#14: Use per-task leaseMs if available, fall back to group config
    const taskLeaseMs = task.leaseMs ?? group.config.leaseMs;
    const leaseTimer = setTimeout(() => {
      if (!TERMINAL_STATUSES.includes(task.state)) {
        console.warn(`[SubAgentManager] Task ${task.taskId} exceeded lease, cancelling`);
        this.cancelTask(task).catch(err =>
          console.error(`[SubAgentManager] Cancel error: ${err.message}`)
        );
      }
    }, taskLeaseMs);
    this.leaseTimers.set(task.taskId, leaseTimer);

    // BUG 3: Track global concurrency
    this.globalRunning++;

    // Run asynchronously — BUG#5: await DB persist before inference
    (async () => {
      // Persist subtask_started event before running inference
      await this.db.appendSubAgentEvent(task.conversationId, 'subtask_started', {
        groupId: task.groupId,
        taskId: task.taskId,
        conversationId: task.conversationId,
        timestamp: Date.now(),
      }, task.userId).catch(err =>
        console.error(`[SubAgentManager] Failed to log subtask_started: ${err.message}`)
      );
      return runner.run();
    })()
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

        // Feature F: Check if error is retryable and retries remain
        const taskMaxRetries = task.maxRetries ?? 0;
        const taskRetryCount = task.retryCount ?? 0;
        const errorObj = error instanceof Error ? error : new Error(String(error));

        if (taskMaxRetries > 0 && taskRetryCount < taskMaxRetries && this.isRetryableError(errorObj)) {
          // Retry: transition RUNNING → QUEUED with backoff
          const newRetryCount = taskRetryCount + 1;
          const backoffMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, taskRetryCount), 30_000);

          console.log(
            `[SubAgentManager] Task ${task.taskId} retry ${newRetryCount}/${taskMaxRetries} ` +
            `(backoff ${backoffMs}ms): ${errorObj.message}`
          );

          const retryOk = this.transitionTask(task, 'QUEUED');
          if (!retryOk) {
            // Fallback: can't re-queue, go to ERROR
            this.transitionTask(task, 'ERROR');
            task.error = errorObj.message;
            task.completedAt = Date.now();
            this.runners.delete(task.taskId);
            this.maybeAutoFinalize(group);
            return;
          }

          task.retryCount = newRetryCount;
          task.nextRetryAt = Date.now() + backoffMs;
          this.runners.delete(task.taskId);

          // Persist retry event
          await this.db.appendSubAgentEvent(task.conversationId, 'subtask_retrying', {
            groupId: task.groupId,
            taskId: task.taskId,
            conversationId: task.conversationId,
            retryCount: newRetryCount,
            maxRetries: taskMaxRetries,
            nextRetryAt: task.nextRetryAt,
            error: errorObj.message,
            timestamp: Date.now(),
          }, task.userId).catch(err =>
            console.error(`[SubAgentManager] Failed to log subtask_retrying: ${err.message}`)
          );

          // Schedule delayed retry — clear nextRetryAt and re-check
          setTimeout(() => {
            task.nextRetryAt = undefined;
            const grp = this.groups.get(group.groupId);
            if (grp && !grp.finalizedAt) {
              this.maybeStartTasks(grp);
            }
          }, backoffMs);

          return; // Skip ERROR transition — .finally will decrement globalRunning
        }

        // Non-retryable or retries exhausted: original error handling
        // H2: Check transition before side-effects
        const ok = this.transitionTask(task, 'ERROR');
        if (!ok) return;

        task.error = errorObj.message;
        task.completedAt = Date.now();
        this.runners.delete(task.taskId);

        // M4: Log DB errors (not silently swallow)
        await this.db.appendSubAgentEvent(task.conversationId, 'subtask_failed', {
          groupId: task.groupId,
          taskId: task.taskId,
          conversationId: task.conversationId,
          error: errorObj.message,
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
        // BUG#13: Clamp to 0 to prevent negative drift from edge cases
        this.globalRunning = Math.max(0, this.globalRunning - 1);
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
  /**
   * Feature D: isResume flag allows terminal→QUEUED for manual resume.
   * Feature F: RUNNING→QUEUED allowed for auto-retry.
   */
  private transitionTask(task: SubAgentTask, newState: SubAgentState, isResume?: boolean): boolean {
    const validTransitions: Record<SubAgentState, SubAgentState[]> = {
      QUEUED: ['RUNNING', 'CANCELLED', 'ERROR'],
      RUNNING: ['FINALIZING', 'FINALIZED', 'CANCELLED', 'ERROR', 'QUEUED'],  // QUEUED for retry
      FINALIZING: ['FINALIZED', 'CANCELLED', 'ERROR'],
      FINALIZED: isResume ? ['QUEUED'] : [],      // QUEUED only via explicit resume
      CANCELLED: isResume ? ['QUEUED'] : [],       // QUEUED only via explicit resume
      ERROR: isResume ? ['QUEUED'] : [],           // QUEUED only via explicit resume
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
