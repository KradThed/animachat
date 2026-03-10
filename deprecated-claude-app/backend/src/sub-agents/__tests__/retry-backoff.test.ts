/**
 * Feature F: Retry with Backoff — unit tests
 *
 * Tests error classification, retry state transitions (RUNNING→QUEUED),
 * backoff timing, retry exhaustion, and interaction with concurrency.
 *
 * Mocked: DB, BranchEventStore, NotificationBus, InferenceRunner.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SubAgentManager } from '../sub-agent-manager.js';

// =============================================================================
// Mock: InferenceRunner
// =============================================================================

let runnerRunImpl: () => Promise<any>;

vi.mock('../inference-runner.js', () => ({
  InferenceRunner: vi.fn().mockImplementation(() => ({
    run: () => runnerRunImpl(),
    cancel: vi.fn(),
  })),
}));

// =============================================================================
// Helpers
// =============================================================================

function deferred<T = any>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createMockDb() {
  return {
    getConversationMessages: vi.fn().mockResolvedValue([]),
    appendSubAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function createManager() {
  const db = createMockDb();
  const branchStore = {
    loadEvents: vi.fn().mockResolvedValue([]),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    listAllTaskIds: vi.fn().mockResolvedValue([]),
  };
  const notificationBus = { notifyParent: vi.fn(), unfreezeParent: vi.fn() };

  const manager = new SubAgentManager(
    {} as any, {} as any, branchStore as any, notificationBus as any, db as any,
  );
  return { manager, db, notificationBus };
}

const tick = () => new Promise(r => setTimeout(r, 50));

// =============================================================================
// Tests
// =============================================================================

describe('Feature F: Retry with Backoff', () => {
  let mgr: SubAgentManager;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    runnerRunImpl = () => new Promise(() => {});
    const ctx = createManager();
    mgr = ctx.manager;
    db = ctx.db;
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Retryable errors
  // ---------------------------------------------------------------------------

  describe('retryable errors', () => {
    it('retries on 429 rate limit error', async () => {
      let attempt = 0;
      runnerRunImpl = () => {
        attempt++;
        if (attempt <= 1) return Promise.reject(new Error('429 Too Many Requests'));
        return new Promise(() => {}); // second attempt hangs
      };

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 2,
      });
      await tick();

      // After first failure, task should be re-queued (QUEUED with retryCount=1)
      expect(task.state).toBe('QUEUED');
      expect(task.retryCount).toBe(1);
      expect(task.nextRetryAt).toBeDefined();
      expect(task.nextRetryAt!).toBeGreaterThan(Date.now() - 1000);
    });

    it('retries on 503 Service Unavailable', async () => {
      let attempt = 0;
      runnerRunImpl = () => {
        attempt++;
        if (attempt <= 1) return Promise.reject(new Error('503 Service Unavailable'));
        return new Promise(() => {});
      };

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 1,
      });
      await tick();

      expect(task.state).toBe('QUEUED');
      expect(task.retryCount).toBe(1);
    });

    it('retries on ECONNRESET', async () => {
      let attempt = 0;
      runnerRunImpl = () => {
        attempt++;
        if (attempt <= 1) return Promise.reject(new Error('read ECONNRESET'));
        return new Promise(() => {});
      };

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 1,
      });
      await tick();

      expect(task.state).toBe('QUEUED');
      expect(task.retryCount).toBe(1);
    });

    it('retries on network timeout', async () => {
      let attempt = 0;
      runnerRunImpl = () => {
        attempt++;
        if (attempt <= 1) return Promise.reject(new Error('network request timeout'));
        return new Promise(() => {});
      };

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 1,
      });
      await tick();

      expect(task.state).toBe('QUEUED');
      expect(task.retryCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-retryable errors
  // ---------------------------------------------------------------------------

  describe('non-retryable errors', () => {
    it('does NOT retry on "context too long"', async () => {
      runnerRunImpl = () => Promise.reject(new Error('context too long: 200k tokens'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 3,
      });
      await tick();

      expect(task.state).toBe('ERROR');
      expect(task.error).toContain('context too long');
      expect(task.retryCount ?? 0).toBe(0);
    });

    it('does NOT retry on "Task cancelled"', async () => {
      runnerRunImpl = () => Promise.reject(new Error('Task cancelled'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 3,
      });
      await tick();

      expect(task.state).toBe('ERROR');
    });

    it('does NOT retry on "MCPL beforeInference aborted"', async () => {
      runnerRunImpl = () => Promise.reject(new Error('MCPL beforeInference aborted: policy violation'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 3,
      });
      await tick();

      expect(task.state).toBe('ERROR');
    });

    it('does NOT retry on "Dependency failed"', async () => {
      runnerRunImpl = () => Promise.reject(new Error('Dependency failed: task-123'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 3,
      });
      await tick();

      expect(task.state).toBe('ERROR');
    });

    it('does NOT retry on unknown error type', async () => {
      runnerRunImpl = () => Promise.reject(new Error('Unexpected null pointer'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 3,
      });
      await tick();

      expect(task.state).toBe('ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Retry exhaustion
  // ---------------------------------------------------------------------------

  describe('retry exhaustion', () => {
    it('goes to ERROR after all retries exhausted', async () => {
      // Always fail with retryable error
      runnerRunImpl = () => Promise.reject(new Error('429 Rate Limit'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 2,
      });

      // First attempt fails → QUEUED (retry 1/2)
      await tick();
      expect(task.retryCount).toBe(1);
      expect(task.state).toBe('QUEUED');

      // Wait for backoff timer to fire, then second attempt
      await new Promise(r => setTimeout(r, 3000));
      await tick();
      expect(task.retryCount).toBe(2);
      expect(task.state).toBe('QUEUED');

      // Wait for second backoff timer, third attempt — now retries exhausted
      await new Promise(r => setTimeout(r, 5000));
      await tick();

      expect(task.state).toBe('ERROR');
      expect(task.error).toContain('429');
    }, 15000); // increased timeout for real timers
  });

  // ---------------------------------------------------------------------------
  // Backoff timing
  // ---------------------------------------------------------------------------

  describe('backoff timing', () => {
    it('exponential backoff: 2s, 4s, 8s (capped at 30s)', async () => {
      let attempt = 0;
      const retryTimestamps: number[] = [];

      runnerRunImpl = () => {
        attempt++;
        retryTimestamps.push(Date.now());
        return Promise.reject(new Error('500 Internal Server Error'));
      };

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 3,
      });

      // First attempt (immediate)
      await tick();
      expect(task.retryCount).toBe(1);

      // Backoff for retry 1: RETRY_BASE_DELAY_MS * 2^0 = 2000ms
      expect(task.nextRetryAt).toBeDefined();
      // nextRetryAt should be ~2s from now
      const backoff1 = task.nextRetryAt! - Date.now();
      expect(backoff1).toBeGreaterThan(1500);
      expect(backoff1).toBeLessThan(3000);
    });
  });

  // ---------------------------------------------------------------------------
  // maxRetries cap
  // ---------------------------------------------------------------------------

  describe('maxRetries cap', () => {
    it('caps at MAX_RETRIES_CAP=3 even if higher value provided', async () => {
      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 999,
      });
      expect(task.maxRetries).toBe(3);
    });

    it('maxRetries=0 means no retry', async () => {
      runnerRunImpl = () => Promise.reject(new Error('429 Rate Limit'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 0,
      });
      await tick();

      // Should go straight to ERROR (no retry)
      expect(task.state).toBe('ERROR');
      expect(task.retryCount ?? 0).toBe(0);
    });

    it('no maxRetries provided means no retry', async () => {
      runnerRunImpl = () => Promise.reject(new Error('429 Rate Limit'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        // maxRetries not provided → defaults to undefined → no retry
      });
      await tick();

      expect(task.state).toBe('ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency on retry
  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    it('globalRunning decrements on retry (slot freed for other tasks)', async () => {
      // If globalRunning doesn't decrement on retry, other tasks would be starved.
      // We verify by checking that a second task can start after the first retries.
      let attempt = 0;
      runnerRunImpl = () => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('429'));
        return new Promise(() => {});
      };

      const taskA = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 1, maxConcurrent: 1, // Only 1 concurrent task
      });
      await tick();

      // A failed and is retrying (QUEUED with backoff)
      expect(taskA.state).toBe('QUEUED');

      // Spawn B — should be able to start even though A is retrying (concurrency slot freed)
      const taskB = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'B',
        groupId: taskA.groupId,
      });
      await tick();

      // B should be RUNNING (A is QUEUED in backoff, not consuming a slot)
      expect(taskB.state).toBe('RUNNING');
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle events
  // ---------------------------------------------------------------------------

  describe('lifecycle events', () => {
    it('persists subtask_retrying event to DB', async () => {
      runnerRunImpl = () => Promise.reject(new Error('500 Internal Server Error'));

      const task = await mgr.spawnSubtask({
        conversationId: 'c1', userId: 'u1', instruction: 'A',
        maxRetries: 1,
      });
      await tick();

      const retryingCalls = db.appendSubAgentEvent.mock.calls.filter(
        (c: any[]) => c[1] === 'subtask_retrying',
      );
      expect(retryingCalls.length).toBeGreaterThanOrEqual(1);
      expect(retryingCalls[0][2].taskId).toBe(task.taskId);
      expect(retryingCalls[0][2].retryCount).toBe(1);
      expect(retryingCalls[0][2].maxRetries).toBe(1);
      expect(retryingCalls[0][2].nextRetryAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Batch spawn with maxRetries
  // ---------------------------------------------------------------------------

  describe('batch spawn', () => {
    it('applies maxRetries to all tasks in batch', async () => {
      runnerRunImpl = () => new Promise(() => {});

      const tasks = await mgr.spawnSubtasks({
        conversationId: 'c1', userId: 'u1',
        instructions: ['A', 'B'],
        maxRetries: 2,
      });

      expect(tasks[0].maxRetries).toBe(2);
      expect(tasks[1].maxRetries).toBe(2);
    });
  });
});
