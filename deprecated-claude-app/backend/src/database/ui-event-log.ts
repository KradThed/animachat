import * as fs from 'fs/promises';
import * as path from 'path';

export class UIEventLog {
  private basePath: string;
  private locks: Map<string, Promise<void>> = new Map();

  // Auto-compact tracking (per conversation)
  private writesSinceCompact: Map<string, number> = new Map();
  private static COMPACT_CHECK_INTERVAL = 50;  // Check every N writes
  private static COMPACT_THRESHOLD_BYTES = 50 * 1024;  // 50KB
  private static COMPACT_MAX_WRITES = 500;  // Force compact after N writes

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Get file path with SAME sharding as conversation.jsonl
   * Structure: basePath/{shard1}/{shard2}/{conversationId}.ui.jsonl
   *
   * Where:
   * - shard1 = conversationId.substring(0, 2)  // first 2 chars
   * - shard2 = conversationId.substring(2, 4)  // chars 2-4
   */
  private getFilePath(conversationId: string): string {
    let dir = this.basePath;

    // Apply same sharding as BulkEventStore
    if (conversationId.length >= 2) {
      dir = path.join(dir, conversationId.substring(0, 2));
    }
    if (conversationId.length >= 4) {
      dir = path.join(dir, conversationId.substring(2, 4));
    }

    return path.join(dir, `${conversationId}.ui.jsonl`);
  }

  // Example:
  // conversationId = "19c9ea36-62c6-4593-a6d0-c4c1c4c240ab"
  // -> ./data/conversations/19/c9/19c9ea36-62c6-4593-a6d0-c4c1c4c240ab.ui.jsonl

  // =====================
  // LOCK (promise-chain)
  // =====================
  private async withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prevLock = this.locks.get(conversationId) ?? Promise.resolve();
    let resolve: () => void;
    const newLock = new Promise<void>(r => { resolve = r; });
    this.locks.set(conversationId, newLock);

    try {
      await prevLock;
      return await fn();
    } finally {
      resolve!();
      if (this.locks.get(conversationId) === newLock) {
        this.locks.delete(conversationId);
      }
    }
  }

  // =====================
  // PUBLIC API
  // =====================

  /**
   * Race-safe migration + get branches.
   * Under a single lock: reads/migrates/merges.
   */
  async ensureMigratedAndGetBranches(
    conversationId: string,
    legacyBranches: Record<string, string>
  ): Promise<Record<string, string>> {
    return this.withLock(conversationId, async () => {
      const filePath = this.getFilePath(conversationId);

      let existing: Record<string, string> = {};
      let fileExists = false;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        existing = this.parseEvents(content, conversationId);
        fileExists = true;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }

      if (fileExists) {
        // Merge: existing (clicks from .ui.jsonl) wins over legacy
        const merged = { ...legacyBranches, ...existing };

        // hasMissingLegacy: legacy has keys that .ui.jsonl doesn't
        const hasMissingLegacy = Object.keys(legacyBranches).some(k => !(k in existing));

        if (hasMissingLegacy) {
          // Write merged so .ui.jsonl becomes the complete source of truth
          await this.writeSnapshotUnlocked(conversationId, merged);
        }
        return merged;
      }

      // File doesn't exist — migrate
      if (Object.keys(legacyBranches).length > 0) {
        await this.writeSnapshotUnlocked(conversationId, legacyBranches, { migratedFromLegacy: true });
        return legacyBranches;
      } else {
        await this.markMigratedUnlocked(conversationId);
        return {};
      }
    });
  }

  /**
   * Append single branch change event.
   * Auto-compacts based on write count (not every write).
   */
  async setActiveBranch(
    conversationId: string,
    messageId: string,
    branchId: string,
    changedByUserId?: string
  ): Promise<void> {
    return this.withLock(conversationId, async () => {
      const filePath = this.getFilePath(conversationId);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      const event = JSON.stringify({
        type: 'active_branch_changed',
        ts: Date.now(),
        data: { messageId, branchId },
        ...(changedByUserId ? { changedByUserId } : {})
      }) + '\n';

      await fs.appendFile(filePath, event, 'utf-8');

      // Increment write counter
      const writes = (this.writesSinceCompact.get(conversationId) ?? 0) + 1;
      this.writesSinceCompact.set(conversationId, writes);

      // Check compact only every N writes (reduce I/O)
      if (writes % UIEventLog.COMPACT_CHECK_INTERVAL === 0) {
        try {
          const stats = await fs.stat(filePath);
          const shouldCompact =
            stats.size > UIEventLog.COMPACT_THRESHOLD_BYTES ||
            writes >= UIEventLog.COMPACT_MAX_WRITES;

          if (shouldCompact) {
            const content = await fs.readFile(filePath, 'utf-8');
            const branches = this.parseEvents(content, conversationId);
            await this.writeSnapshotUnlocked(conversationId, branches);
            // Delete instead of set(0) to avoid Map growing forever
            this.writesSinceCompact.delete(conversationId);
          }
        } catch (e) {
          // Non-critical: compaction failure shouldn't break setActiveBranch
          console.warn(`[UIEventLog] Auto-compact failed for ${conversationId}:`, e);
        }
      }
    });
  }

  /**
   * Compact: replace file with snapshot of current state.
   */
  async compact(conversationId: string): Promise<void> {
    return this.withLock(conversationId, async () => {
      const filePath = this.getFilePath(conversationId);

      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (e: any) {
        if (e.code === 'ENOENT') return;
        throw e;
      }

      const branches = this.parseEvents(content, conversationId);
      await this.writeSnapshotUnlocked(conversationId, branches);
    });
  }

  /**
   * Clear write-count cache for a conversation (called from unloadConversation).
   * NEVER deletes locks — withLock manages its own lifecycle.
   */
  clearCache(conversationId: string): void {
    this.writesSinceCompact.delete(conversationId);
  }

  // =====================
  // PRIVATE: Parse
  // =====================

  /**
   * Tolerant parser: skips corrupted lines.
   */
  private parseEvents(content: string, conversationId: string): Record<string, string> {
    const branches: Record<string, string> = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'active_branch_changed' && event.data) {
          branches[event.data.messageId] = event.data.branchId;
        }
      } catch (e) {
        console.warn(`[UIEventLog] Skipping corrupted line in ${conversationId}: ${trimmed.substring(0, 50)}...`);
      }
    }

    return branches;
  }

  // =====================
  // PRIVATE: Write
  // =====================

  private async writeSnapshotUnlocked(
    conversationId: string,
    branches: Record<string, string>,
    meta?: { migratedFromLegacy?: boolean }
  ): Promise<void> {
    const filePath = this.getFilePath(conversationId);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const ts = Date.now();
    const sortedKeys = Object.keys(branches).sort();

    const lines = sortedKeys.map(messageId =>
      JSON.stringify({
        type: 'active_branch_changed',
        ts,
        data: { messageId, branchId: branches[messageId] },
        ...(meta?.migratedFromLegacy ? { migratedFromLegacy: true } : {})
      })
    );

    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
    await this.atomicReplace(tmpPath, filePath);
  }

  private async markMigratedUnlocked(conversationId: string): Promise<void> {
    const filePath = this.getFilePath(conversationId);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const marker = JSON.stringify({ type: 'migrated', ts: Date.now(), empty: true }) + '\n';

    try {
      // wx = create only if NOT exists
      await fs.writeFile(filePath, marker, { flag: 'wx' });
    } catch (e: any) {
      if (e.code === 'EEXIST') return;
      throw e;
    }
  }

  // =====================
  // PRIVATE: Atomic Replace (Windows-safe)
  // =====================

  private async atomicReplace(tmpPath: string, filePath: string): Promise<void> {
    const bakPath = filePath + '.bak';

    try {
      // Delete old .bak if exists
      try { await fs.unlink(bakPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }

      // Backup current file
      try {
        await fs.rename(filePath, bakPath);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Rename tmp -> target
      try {
        await fs.rename(tmpPath, filePath);
      } catch (e) {
        // ROLLBACK: restore backup
        try { await fs.rename(bakPath, filePath); } catch {}
        // Cleanup tmp
        try { await fs.unlink(tmpPath); } catch {}
        throw e;
      }

      // Success — cleanup backup
      try { await fs.unlink(bakPath); } catch {}
    } catch (e) {
      // Cleanup tmp if still exists
      try { await fs.unlink(tmpPath); } catch {}
      throw e;
    }
  }
}
