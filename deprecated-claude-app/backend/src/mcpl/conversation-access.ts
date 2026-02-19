/**
 * Conversation Access Cache
 *
 * Caches userId→conversationId ownership checks to avoid DB round-trips
 * on every MCPL message. Uses passive TTL expiry and in-flight coalescing.
 *
 * Security: This is NOT a replacement for DB-level checks. It's a performance
 * layer that prevents O(n) DB queries when a delegate sends many messages
 * for the same conversation in rapid succession.
 */

import type { Database } from '../database/index.js';

// =============================================================================
// Types
// =============================================================================

interface CacheEntry {
  granted: boolean;
  expiresAt: number;
  insertedAt: number;
}

// =============================================================================
// ConversationAccessCache
// =============================================================================

const CACHE_TTL_MS = 30_000;      // 30 seconds
const MAX_SIZE = 1000;             // Max cache entries before eviction
const EVICTION_RATIO = 0.5;       // Evict 50% oldest on overflow

export class ConversationAccessCache {
  private cache = new Map<string, CacheEntry>();

  // In-flight coalescing: keyed by userId:conversationId for safety.
  // Even though this cache is per-connection (one userId), using compound key
  // prevents a security footgun if cache is ever shared across connections.
  // Must be cleaned in finally block — even if DB throws.
  private inflight = new Map<string, Promise<boolean>>();

  /**
   * Check if a userId:conversationId pair is cached and valid.
   */
  get(userId: string, conversationId: string): boolean | undefined {
    const key = `${userId}:${conversationId}`;
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Passive expiry
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.granted;
  }

  /**
   * Cache a userId:conversationId access result.
   */
  set(userId: string, conversationId: string, granted: boolean): void {
    const key = `${userId}:${conversationId}`;
    const now = Date.now();

    // Evict before insert if at capacity
    if (this.cache.size >= MAX_SIZE && !this.cache.has(key)) {
      this.evictOldest();
    }

    this.cache.set(key, {
      granted,
      expiresAt: now + CACHE_TTL_MS,
      insertedAt: now,
    });
  }

  /**
   * Invalidate a specific entry (e.g., when ownership changes).
   */
  invalidate(userId: string, conversationId: string): void {
    this.cache.delete(`${userId}:${conversationId}`);
  }

  /**
   * Check cache, or fetch from DB with in-flight coalescing.
   * Returns true if access is granted, false if denied.
   *
   * In-flight coalescing ensures that 20 concurrent messages for the
   * same new conversationId only trigger 1 DB query.
   */
  async checkOrFetch(
    userId: string,
    conversationId: string,
    db: Database,
  ): Promise<boolean> {
    // 1. Check cache first
    const cached = this.get(userId, conversationId);
    if (cached !== undefined) return cached;

    // 2. Check in-flight (coalesce concurrent requests)
    const inflightKey = `${userId}:${conversationId}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    // 3. DB check with coalescing
    const promise = this.fetchFromDb(userId, conversationId, db);
    this.inflight.set(inflightKey, promise);

    try {
      const granted = await promise;
      this.set(userId, conversationId, granted);
      return granted;
    } finally {
      // MUST clean up even if DB throws — otherwise stale Promise stays forever
      this.inflight.delete(inflightKey);
    }
  }

  /**
   * Current cache size (for testing/metrics).
   */
  get size(): number {
    return this.cache.size;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async fetchFromDb(
    userId: string,
    conversationId: string,
    db: Database,
  ): Promise<boolean> {
    // db.getConversation(conversationId, userId) calls tryLoadAndVerifyConversation()
    // which checks conversation.userId === requestingUserId + collaboration store.
    // Returns null on denied access.
    const conversation = await db.getConversation(conversationId, userId);
    return conversation !== null;
  }

  /**
   * Evict 50% oldest entries sorted by expiresAt ASC, tie-break insertedAt ASC.
   * O(n) but only triggered at overflow boundary (rare).
   */
  private evictOldest(): void {
    const entries = Array.from(this.cache.entries());

    // Sort: soonest-to-expire first, then oldest insertion first
    entries.sort((a, b) => {
      const expDiff = a[1].expiresAt - b[1].expiresAt;
      if (expDiff !== 0) return expDiff;
      return a[1].insertedAt - b[1].insertedAt;
    });

    const evictCount = Math.ceil(entries.length * EVICTION_RATIO);
    for (let i = 0; i < evictCount; i++) {
      this.cache.delete(entries[i][0]);
    }
  }
}
