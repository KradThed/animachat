/**
 * Branch Event Store
 *
 * Wraps BulkEventStore for sub-agent branch files.
 * Each sub-agent task writes to its own JSONL file:
 *   ./data/branches/{shard1}/{shard2}/{taskId}.jsonl
 *
 * Separate from conversationEventStore to keep parent conversation
 * JSONL clean (DR-MAIN-APPEND-001: only lifecycle events in main JSONL).
 */

import fs from 'fs/promises';
import path from 'path';
import { BulkEventStore } from './bulk-event-store.js';
import { Event } from './persistence.js';

export class BranchEventStore {
  private inner: BulkEventStore;

  constructor() {
    this.inner = new BulkEventStore('./data/branches');
  }

  async init(): Promise<void> {
    await this.inner.init();
  }

  async appendEvent(taskId: string, event: Event): Promise<void> {
    await this.inner.appendEvent(taskId, event);
  }

  async loadEvents(taskId: string): Promise<Event[]> {
    return this.inner.loadEvents(taskId);
  }

  /** List all branch task IDs (for orphan recovery on startup). */
  async listAllTaskIds(): Promise<string[]> {
    return this.inner.scanTaskIds();
  }

  /** SA-4: Delete a branch file for orphaned task cleanup. */
  async deleteTask(taskId: string): Promise<void> {
    // Resolve the same sharded path that BulkEventStore uses
    const baseDir = await this.inner.getBaseDirForId(taskId);
    const filePath = path.join(baseDir, this.inner.getFileForId(taskId));
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Evict from BulkEventStore's file handle cache if open
    const cached = this.inner.mostRecentEventStores.get(taskId);
    if (cached) {
      await cached.close();
      this.inner.mostRecentEventStores.delete(taskId);
      const idx = this.inner.mostRecentIds.indexOf(taskId);
      if (idx !== -1) this.inner.mostRecentIds.splice(idx, 1);
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
