/**
 * MCPL Event Queue
 *
 * Strict FIFO queue for push events from MCPL-connected delegates.
 * Handles: idempotency dedup, global rate limiting, pause/resume per conversation.
 *
 * Push events arrive from delegates (e.g., webhook → delegate → mcpl/push_event)
 * and are queued here. The queue processes events strictly sequentially — no
 * priorities, no reordering.
 *
 * Idempotency:
 *   Primary key: deliveryId from webhook header (X-GitHub-Delivery, X-Gitlab-Event-UUID)
 *   Fallback: sha256(eventType + payload + timeBucket5min)
 *   Without this, every webhook retry = new inference.
 *
 * Rate limiting:
 *   Global maxPushesPerHour — user's limit, not per-server.
 *   Rate-limited pushes get 'rate_limited' status, visible in UI.
 */

import { createHash } from 'crypto';
import { roomManager } from '../websocket/room-manager.js';
import { triggerHandler } from '../delegate/trigger-handler.js';
import { Database } from '../database/index.js';

// =============================================================================
// Types
// =============================================================================

export interface McplEventQueueConfig {
  /** Global max pushes per hour (user-configurable) */
  maxPushesPerHour: number;
  /** How long to keep idempotency keys (ms). Default: 30min */
  idempotencyWindowMs: number;
  /** Max queue size per conversation before rejecting. Default: 100 */
  maxQueueSize: number;
}

export type McplQueueEntryStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rate_limited'
  | 'duplicate_ignored';

export interface McplQueueEntry {
  id: string;
  source: string;
  conversationId: string;
  eventType: string;
  payload: unknown;
  systemMessage: string;
  idempotencyKey: string;
  timestamp: string;
  status: McplQueueEntryStatus;
  delegateId: string;
  userId: string;
  /** Error message if status === 'failed' */
  error?: string;
}

// =============================================================================
// McplEventQueue
// =============================================================================

export class McplEventQueue {
  private config: McplEventQueueConfig;

  /** Queues keyed by conversationId */
  private queues: Map<string, McplQueueEntry[]> = new Map();

  /** Paused conversations */
  private paused: Set<string> = new Set();

  /** Seen idempotency keys with expiry timestamps */
  private seenKeys: Map<string, number> = new Map();

  /** Rate limiting: timestamps of processed events in the current hour window */
  private processedTimestamps: number[] = [];

  /** Whether a conversation is currently processing */
  private processing: Set<string> = new Set();

  /** Reference to database (set via setDatabase) */
  private db: Database | null = null;

  constructor(config?: Partial<McplEventQueueConfig>) {
    this.config = {
      maxPushesPerHour: 60,
      idempotencyWindowMs: 30 * 60 * 1000, // 30 minutes
      maxQueueSize: 100,
      ...config,
    };

    // Periodically clean up expired idempotency keys
    setInterval(() => this.cleanupIdempotencyKeys(), 5 * 60 * 1000);
  }

  /**
   * Set the database reference (called during server startup).
   */
  setDatabase(db: Database): void {
    this.db = db;
  }

  // --------------------------------------------------------------------------
  // Push
  // --------------------------------------------------------------------------

  /**
   * Push an event into the queue.
   * Returns the queue entry with its status.
   */
  push(event: {
    id: string;
    source: string;
    conversationId: string;
    eventType: string;
    payload: unknown;
    systemMessage: string;
    idempotencyKey: string;
    timestamp: string;
    delegateId: string;
    userId: string;
  }): McplQueueEntry {
    // 1. Check idempotency
    const effectiveKey = event.idempotencyKey || this.computeFallbackKey(event);

    if (this.seenKeys.has(effectiveKey)) {
      const entry: McplQueueEntry = {
        ...event,
        idempotencyKey: effectiveKey,
        status: 'duplicate_ignored',
      };
      console.log(`[McplEventQueue] Duplicate ignored: ${event.source}/${event.eventType} (key: ${effectiveKey.substring(0, 12)}...)`);
      this.broadcastQueueUpdate(event.conversationId);
      return entry;
    }

    // 2. Check rate limit
    this.pruneOldTimestamps();
    if (this.processedTimestamps.length >= this.config.maxPushesPerHour) {
      const entry: McplQueueEntry = {
        ...event,
        idempotencyKey: effectiveKey,
        status: 'rate_limited',
      };
      console.warn(`[McplEventQueue] Rate limited: ${event.source}/${event.eventType} (${this.processedTimestamps.length}/${this.config.maxPushesPerHour} per hour)`);
      if (this.db) {
        this.db.appendMcplConversationEvent(event.conversationId, 'push_event_rate_limited', {
          id: entry.id, source: entry.source, eventType: entry.eventType, status: entry.status,
        }).catch(err => console.warn('[McplEventQueue] Failed to persist push_event_rate_limited:', err));
      }
      this.broadcastQueueUpdate(event.conversationId);
      return entry;
    }

    // 3. Check queue size
    const queue = this.getOrCreateQueue(event.conversationId);
    if (queue.length >= this.config.maxQueueSize) {
      const entry: McplQueueEntry = {
        ...event,
        idempotencyKey: effectiveKey,
        status: 'rate_limited',
        error: `Queue full (max ${this.config.maxQueueSize})`,
      };
      console.warn(`[McplEventQueue] Queue full for conversation ${event.conversationId}`);
      return entry;
    }

    // 4. Mark idempotency key as seen
    this.seenKeys.set(effectiveKey, Date.now() + this.config.idempotencyWindowMs);

    // 5. Enqueue
    const entry: McplQueueEntry = {
      ...event,
      idempotencyKey: effectiveKey,
      status: 'queued',
    };
    queue.push(entry);

    // Persist push_event_received (audit trail)
    if (this.db) {
      this.db.appendMcplConversationEvent(event.conversationId, 'push_event_received', {
        id: entry.id, source: entry.source, eventType: entry.eventType, status: entry.status,
      }).catch(err => console.warn('[McplEventQueue] Failed to persist push_event_received:', err));
    }

    console.log(`[McplEventQueue] Queued: ${event.source}/${event.eventType} (${event.id}) → conversation ${event.conversationId} [${queue.length} in queue]`);
    this.broadcastQueueUpdate(event.conversationId);

    // 6. Start processing if not paused and not already processing
    if (!this.paused.has(event.conversationId) && !this.processing.has(event.conversationId)) {
      this.processNext(event.conversationId);
    }

    return entry;
  }

  // --------------------------------------------------------------------------
  // Pause / Resume
  // --------------------------------------------------------------------------

  /**
   * Pause processing for a conversation. Events still queue up.
   */
  pause(conversationId: string): void {
    this.paused.add(conversationId);
    console.log(`[McplEventQueue] Paused: conversation ${conversationId}`);
    this.broadcastQueueUpdate(conversationId);
  }

  /**
   * Resume processing for a conversation. Starts processing queued events.
   */
  resume(conversationId: string): void {
    this.paused.delete(conversationId);
    console.log(`[McplEventQueue] Resumed: conversation ${conversationId}`);
    this.broadcastQueueUpdate(conversationId);

    // Start processing if there are queued events
    if (!this.processing.has(conversationId)) {
      this.processNext(conversationId);
    }
  }

  /**
   * Check if a conversation is paused.
   */
  isPaused(conversationId: string): boolean {
    return this.paused.has(conversationId);
  }

  // --------------------------------------------------------------------------
  // Queue Access
  // --------------------------------------------------------------------------

  /**
   * Get the current queue for a conversation (for UI display).
   */
  getQueue(conversationId: string): McplQueueEntry[] {
    return this.queues.get(conversationId) || [];
  }

  /**
   * Get queue stats.
   */
  getStats(): {
    totalQueued: number;
    pausedConversations: number;
    processedThisHour: number;
    maxPerHour: number;
    seenKeys: number;
  } {
    let totalQueued = 0;
    for (const queue of this.queues.values()) {
      totalQueued += queue.filter(e => e.status === 'queued').length;
    }
    this.pruneOldTimestamps();
    return {
      totalQueued,
      pausedConversations: this.paused.size,
      processedThisHour: this.processedTimestamps.length,
      maxPerHour: this.config.maxPushesPerHour,
      seenKeys: this.seenKeys.size,
    };
  }

  // --------------------------------------------------------------------------
  // Processing (Strict FIFO)
  // --------------------------------------------------------------------------

  /**
   * Process the next queued event for a conversation.
   * Strictly sequential — only one event processes at a time per conversation.
   */
  private async processNext(conversationId: string): Promise<void> {
    if (this.paused.has(conversationId)) return;
    if (this.processing.has(conversationId)) return;

    const queue = this.queues.get(conversationId);
    if (!queue) return;

    // Find next queued event
    const nextIndex = queue.findIndex(e => e.status === 'queued');
    if (nextIndex === -1) {
      // No more queued events — clean up completed entries
      this.cleanupCompletedEntries(conversationId);
      return;
    }

    const entry = queue[nextIndex];
    entry.status = 'processing';
    this.processing.add(conversationId);
    this.broadcastQueueUpdate(conversationId);

    console.log(`[McplEventQueue] Processing: ${entry.source}/${entry.eventType} (${entry.id})`);

    try {
      await this.executeEvent(entry);
      entry.status = 'completed';
      this.processedTimestamps.push(Date.now());
      console.log(`[McplEventQueue] Completed: ${entry.source}/${entry.eventType} (${entry.id})`);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      console.error(`[McplEventQueue] Failed: ${entry.source}/${entry.eventType} (${entry.id}):`, entry.error);
    }

    // Persist push_event_processed (audit trail)
    if (this.db) {
      this.db.appendMcplConversationEvent(conversationId, 'push_event_processed', {
        id: entry.id, success: entry.status === 'completed', error: entry.error,
      }).catch(err => console.warn('[McplEventQueue] Failed to persist push_event_processed:', err));
    }

    this.processing.delete(conversationId);
    this.broadcastQueueUpdate(conversationId);

    // Process next event in queue (strict FIFO — don't process concurrently)
    // Use setImmediate to avoid stack overflow with many queued events
    setImmediate(() => this.processNext(conversationId));
  }

  /**
   * Execute a push event — create a trigger-style inference.
   * Reuses TriggerHandler pattern: adds message to conversation + runs inference.
   */
  private async executeEvent(entry: McplQueueEntry): Promise<void> {
    if (!this.db) {
      throw new Error('Database not set — call setDatabase() first');
    }

    // Convert push event to trigger inference format
    const result = await triggerHandler.handleTrigger(
      {
        type: 'trigger_inference',
        triggerId: entry.id,
        source: entry.source,
        conversationId: entry.conversationId,
        context: {
          eventType: entry.eventType,
          ...(typeof entry.payload === 'object' && entry.payload !== null ? entry.payload as Record<string, unknown> : { data: entry.payload }),
        },
        systemMessage: entry.systemMessage,
      },
      entry.userId,
      this.db
    );

    if (!result.success) {
      throw new Error(result.error || 'Trigger inference failed');
    }
  }

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------

  /**
   * Compute fallback idempotency key when no deliveryId is provided.
   * sha256(eventType + payload + timeBucket5min)
   */
  private computeFallbackKey(event: { eventType: string; payload: unknown }): string {
    const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000)); // 5-minute buckets
    const data = `${event.eventType}:${JSON.stringify(event.payload)}:${timeBucket}`;
    return `fallback:${createHash('sha256').update(data).digest('hex').substring(0, 16)}`;
  }

  /**
   * Clean up expired idempotency keys.
   */
  private cleanupIdempotencyKeys(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, expiry] of this.seenKeys) {
      if (expiry <= now) {
        this.seenKeys.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[McplEventQueue] Cleaned ${cleaned} expired idempotency keys`);
    }
  }

  // --------------------------------------------------------------------------
  // Rate Limiting
  // --------------------------------------------------------------------------

  /**
   * Remove timestamps older than 1 hour.
   */
  private pruneOldTimestamps(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.processedTimestamps = this.processedTimestamps.filter(t => t > oneHourAgo);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getOrCreateQueue(conversationId: string): McplQueueEntry[] {
    let queue = this.queues.get(conversationId);
    if (!queue) {
      queue = [];
      this.queues.set(conversationId, queue);
    }
    return queue;
  }

  /**
   * Remove completed/failed/ignored entries older than 5 minutes.
   * Keeps recent entries for UI display.
   */
  private cleanupCompletedEntries(conversationId: string): void {
    const queue = this.queues.get(conversationId);
    if (!queue) return;

    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const filtered = queue.filter(e => {
      if (e.status === 'queued' || e.status === 'processing') return true;
      const ts = new Date(e.timestamp).getTime();
      return ts > fiveMinAgo;
    });

    if (filtered.length === 0) {
      this.queues.delete(conversationId);
    } else {
      this.queues.set(conversationId, filtered);
    }
  }

  /**
   * Broadcast queue update to UI clients in the conversation room.
   */
  private broadcastQueueUpdate(conversationId: string): void {
    const queue = this.getQueue(conversationId);
    roomManager.broadcastToRoom(conversationId, {
      type: 'mcpl/queue_update',
      conversationId,
      queue: queue.map(e => ({
        id: e.id,
        source: e.source,
        eventType: e.eventType,
        status: e.status,
        timestamp: e.timestamp,
        systemMessage: e.systemMessage,
        error: e.error,
      })),
      totalCount: queue.length,
      isPaused: this.paused.has(conversationId),
    });
  }

  /**
   * Update config at runtime (e.g., user changes maxPushesPerHour).
   */
  updateConfig(config: Partial<McplEventQueueConfig>): void {
    this.config = { ...this.config, ...config };
    console.log(`[McplEventQueue] Config updated:`, this.config);
  }
}

export const mcplEventQueue = new McplEventQueue();
