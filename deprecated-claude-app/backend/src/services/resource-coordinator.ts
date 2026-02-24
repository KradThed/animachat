/**
 * Resource Coordinator
 *
 * Write lock per resource path. Prevents concurrent sub-agents from
 * corrupting the same file via simultaneous writeFile calls.
 *
 * Single-threaded (Node.js) — no OS-level mutex needed.
 * Lock granularity: `{userId}:{delegateName}:{normalizedPath}`
 *
 * Integration point: InferenceRunner wraps executeToolCall with
 * createGuardedExecuteTool() from write-tool-guard.ts.
 */

type ReleaseFunction = () => void;

interface PendingWaiter {
  resolve: (release: ReleaseFunction) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ResourceCoordinator {
  private held = new Set<string>();
  private waiters = new Map<string, PendingWaiter[]>();

  /**
   * Acquire lock, execute fn, release lock.
   * If lock is held — wait up to timeoutMs.
   */
  async withLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const release = await this.acquire(lockKey, timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(lockKey: string, timeoutMs: number): Promise<ReleaseFunction> {
    // Fast path: not held
    if (!this.held.has(lockKey)) {
      this.held.add(lockKey);
      return Promise.resolve(() => this.release(lockKey));
    }

    // Slow path: wait in queue
    return new Promise<ReleaseFunction>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(lockKey, waiter);
        reject(new Error(`Lock timeout on ${lockKey} after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter: PendingWaiter = { resolve, reject, timer };

      if (!this.waiters.has(lockKey)) {
        this.waiters.set(lockKey, []);
      }
      this.waiters.get(lockKey)!.push(waiter);
    });
  }

  private release(lockKey: string): void {
    const queue = this.waiters.get(lockKey);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      clearTimeout(next.timer);
      if (queue.length === 0) this.waiters.delete(lockKey);
      // Lock stays held, transfer to next waiter
      next.resolve(() => this.release(lockKey));
    } else {
      this.held.delete(lockKey);
    }
  }

  private removeWaiter(lockKey: string, waiter: PendingWaiter): void {
    const queue = this.waiters.get(lockKey);
    if (!queue) return;
    const idx = queue.indexOf(waiter);
    if (idx !== -1) queue.splice(idx, 1);
    if (queue.length === 0) this.waiters.delete(lockKey);
  }

  destroy(): void {
    for (const queue of this.waiters.values()) {
      for (const w of queue) {
        clearTimeout(w.timer);
        w.reject(new Error('ResourceCoordinator destroyed'));
      }
    }
    this.waiters.clear();
    this.held.clear();
  }
}
