import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationAccessCache } from '../conversation-access.js';
import type { Database } from '../../database/index.js';

// =============================================================================
// Helpers
// =============================================================================

function createCache(): ConversationAccessCache {
  return new ConversationAccessCache();
}

function mockDb(returns: any = { id: 'conv-1', userId: 'u1' }): Database {
  return {
    getConversation: vi.fn().mockResolvedValue(returns),
  } as unknown as Database;
}

function mockDbReject(error: Error): Database {
  return {
    getConversation: vi.fn().mockRejectedValue(error),
  } as unknown as Database;
}

// =============================================================================
// Tests
// =============================================================================

describe('ConversationAccessCache', () => {
  let cache: ConversationAccessCache;

  beforeEach(() => {
    cache = createCache();
  });

  // ---------------------------------------------------------------------------
  // get / set / invalidate
  // ---------------------------------------------------------------------------

  describe('get/set/invalidate', () => {
    it('returns undefined for unknown key', () => {
      expect(cache.get('u1', 'conv-1')).toBeUndefined();
    });

    it('returns granted=true after set(true)', () => {
      cache.set('u1', 'conv-1', true);
      expect(cache.get('u1', 'conv-1')).toBe(true);
    });

    it('returns granted=false after set(false)', () => {
      cache.set('u1', 'conv-1', false);
      expect(cache.get('u1', 'conv-1')).toBe(false);
    });

    it('returns undefined after TTL expires', () => {
      cache.set('u1', 'conv-1', true);

      // Manually expire the entry
      const internalCache = (cache as any).cache as Map<string, any>;
      const entry = internalCache.get('u1:conv-1');
      entry.expiresAt = Date.now() - 1;

      expect(cache.get('u1', 'conv-1')).toBeUndefined();
      // Entry should also be cleaned up
      expect(internalCache.has('u1:conv-1')).toBe(false);
    });

    it('invalidate() removes entry', () => {
      cache.set('u1', 'conv-1', true);
      cache.invalidate('u1', 'conv-1');
      expect(cache.get('u1', 'conv-1')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Eviction
  // ---------------------------------------------------------------------------

  describe('eviction', () => {
    it('evicts 50% oldest when MAX_SIZE reached', () => {
      // MAX_SIZE is 1000 — insert 1001 entries
      for (let i = 0; i < 1001; i++) {
        cache.set('u1', `conv-${i}`, true);
      }

      // After eviction, size should be around 501 (1001 - 500)
      expect(cache.size).toBeLessThanOrEqual(1001);
      expect(cache.size).toBeGreaterThan(0);
      // Eviction should have run, removing ~500 entries
      expect(cache.size).toBeLessThanOrEqual(501);
    });

    it('eviction order: soonest expiresAt first, tie-break by insertedAt ASC', () => {
      // Insert entries with controlled expiresAt/insertedAt
      const internalCache = (cache as any).cache as Map<string, any>;

      const now = Date.now();

      // Manually set MAX_SIZE to 4 for easier testing
      // We'll insert 5 entries, which should trigger eviction of 2 (50%)
      // Override by inserting directly into map to control timestamps
      const entries = [
        { key: 'u1:a', granted: true, expiresAt: now + 100, insertedAt: now - 40 }, // expires soonest → evicted first
        { key: 'u1:b', granted: true, expiresAt: now + 200, insertedAt: now - 30 },
        { key: 'u1:c', granted: true, expiresAt: now + 200, insertedAt: now - 20 }, // same expiry as b, newer → survives
        { key: 'u1:d', granted: true, expiresAt: now + 300, insertedAt: now - 10 }, // latest expiry → survives
      ];

      for (const e of entries) {
        internalCache.set(e.key, {
          granted: e.granted,
          expiresAt: e.expiresAt,
          insertedAt: e.insertedAt,
        });
      }

      expect(internalCache.size).toBe(4);

      // Now trigger eviction by adding one more that exceeds some limit
      // Instead, call evictOldest directly to test sort order
      (cache as any).evictOldest();

      // Should evict 50% = 2 entries: 'a' (soonest expiry), then 'b' (same expiry as c but older insertedAt)
      expect(internalCache.has('u1:a')).toBe(false); // evicted — soonest expiry
      expect(internalCache.has('u1:b')).toBe(false); // evicted — same expiry as c, older insertedAt
      expect(internalCache.has('u1:c')).toBe(true);  // survives
      expect(internalCache.has('u1:d')).toBe(true);  // survives
    });
  });

  // ---------------------------------------------------------------------------
  // checkOrFetch
  // ---------------------------------------------------------------------------

  describe('checkOrFetch', () => {
    it('calls db.getConversation on cache miss and caches result', async () => {
      const db = mockDb({ id: 'conv-1', userId: 'u1' });
      const result = await cache.checkOrFetch('u1', 'conv-1', db);

      expect(result).toBe(true);
      expect(db.getConversation).toHaveBeenCalledWith('conv-1', 'u1');

      // Now should be cached
      expect(cache.get('u1', 'conv-1')).toBe(true);
    });

    it('returns cached value on hit — db NOT called second time', async () => {
      const db = mockDb({ id: 'conv-1', userId: 'u1' });

      await cache.checkOrFetch('u1', 'conv-1', db);
      await cache.checkOrFetch('u1', 'conv-1', db);

      expect(db.getConversation).toHaveBeenCalledTimes(1);
    });

    it('in-flight coalescing: 2 concurrent calls → only 1 db call', async () => {
      const db = mockDb({ id: 'conv-1', userId: 'u1' });

      const [r1, r2] = await Promise.all([
        cache.checkOrFetch('u1', 'conv-1', db),
        cache.checkOrFetch('u1', 'conv-1', db),
      ]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(db.getConversation).toHaveBeenCalledTimes(1);
    });

    it('inflight cleanup on DB error — inflight map cleared', async () => {
      const db = mockDbReject(new Error('DB connection lost'));
      const inflightMap = (cache as any).inflight as Map<string, any>;

      await expect(cache.checkOrFetch('u1', 'conv-1', db)).rejects.toThrow('DB connection lost');

      // Inflight must be cleaned up even after error
      expect(inflightMap.size).toBe(0);
    });

    it('returns false when db.getConversation returns null (access denied)', async () => {
      const db = mockDb(null);
      const result = await cache.checkOrFetch('u1', 'conv-1', db);

      expect(result).toBe(false);
      expect(cache.get('u1', 'conv-1')).toBe(false);
    });

    it('different conversationIds do NOT coalesce — separate DB calls', async () => {
      const db = mockDb({ id: 'conv-1', userId: 'u1' });

      await Promise.all([
        cache.checkOrFetch('u1', 'conv-1', db),
        cache.checkOrFetch('u1', 'conv-2', db),
      ]);

      // Two separate conversationIds → two DB calls
      expect(db.getConversation).toHaveBeenCalledTimes(2);
      expect(db.getConversation).toHaveBeenCalledWith('conv-1', 'u1');
      expect(db.getConversation).toHaveBeenCalledWith('conv-2', 'u1');
    });

    it('after error, retry succeeds with fresh DB call', async () => {
      const failDb = mockDbReject(new Error('DB down'));
      await expect(cache.checkOrFetch('u1', 'conv-1', failDb)).rejects.toThrow();

      // Now retry with working DB
      const okDb = mockDb({ id: 'conv-1', userId: 'u1' });
      const result = await cache.checkOrFetch('u1', 'conv-1', okDb);
      expect(result).toBe(true);
      expect(okDb.getConversation).toHaveBeenCalledTimes(1);
    });

    it('denied result is cached and prevents subsequent DB calls', async () => {
      const db = mockDb(null); // denied
      await cache.checkOrFetch('u1', 'conv-1', db);

      // Second call should use cache (no DB hit)
      const db2 = mockDb({ id: 'conv-1', userId: 'u1' });
      const result = await cache.checkOrFetch('u1', 'conv-1', db2);
      expect(result).toBe(false); // still denied from cache
      expect(db2.getConversation).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('size getter reflects current count', () => {
      expect(cache.size).toBe(0);
      cache.set('u1', 'conv-1', true);
      expect(cache.size).toBe(1);
      cache.set('u2', 'conv-2', false);
      expect(cache.size).toBe(2);
      cache.invalidate('u1', 'conv-1');
      expect(cache.size).toBe(1);
    });

    it('set() overwrites existing entry with fresh TTL', () => {
      cache.set('u1', 'conv-1', true);
      const internalCache = (cache as any).cache as Map<string, any>;
      const entry1 = internalCache.get('u1:conv-1');
      const origExpires = entry1.expiresAt;

      // Overwrite with denied
      cache.set('u1', 'conv-1', false);
      const entry2 = internalCache.get('u1:conv-1');
      expect(entry2.granted).toBe(false);
      expect(entry2.expiresAt).toBeGreaterThanOrEqual(origExpires);
    });

    it('invalidate on nonexistent key is a no-op', () => {
      cache.invalidate('nonexistent', 'nonexistent');
      expect(cache.size).toBe(0);
    });

    it('concurrent checkOrFetch errors for different keys both clean up inflight', async () => {
      const db = mockDbReject(new Error('DB down'));
      const inflightMap = (cache as any).inflight as Map<string, any>;

      await Promise.allSettled([
        cache.checkOrFetch('u1', 'conv-1', db),
        cache.checkOrFetch('u1', 'conv-2', db),
      ]);

      expect(inflightMap.size).toBe(0);
    });

    it('user isolation: different users different conversations', async () => {
      const db = {
        getConversation: vi.fn()
          .mockResolvedValueOnce({ id: 'conv-1', userId: 'u1' }) // u1:conv-1 → granted
          .mockResolvedValueOnce(null), // u2:conv-1 → denied
      } as unknown as Database;

      const cache1 = createCache();
      const r1 = await cache1.checkOrFetch('u1', 'conv-1', db);
      const r2 = await cache1.checkOrFetch('u2', 'conv-1', db);

      expect(r1).toBe(true);
      expect(r2).toBe(false);
      expect(db.getConversation).toHaveBeenCalledTimes(2);
    });
  });
});
