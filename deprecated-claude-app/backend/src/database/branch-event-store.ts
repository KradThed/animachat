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
    const ids: string[] = [];
    try {
      for await (const { id } of this.inner.loadAllEvents()) {
        ids.push(id);
      }
    } catch (error: any) {
      // M7: Belt+suspenders ENOENT handling (BulkEventStore.loadAllEvents already handles this,
      // but the error may come from a different path)
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return ids;
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
