import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InferenceChainTracker } from '../inference-chain.js';

// =============================================================================
// Helpers
// =============================================================================

function createTracker(): InferenceChainTracker {
  return new InferenceChainTracker();
}

/** Helper: create chain and assert allowed. */
function mustCreate(tracker: InferenceChainTracker, convId: string, serverId: string) {
  const result = tracker.createChain(convId, serverId);
  expect(result.allowed).toBe(true);
  if (!result.allowed) throw new Error('createChain unexpectedly denied');
  return result;
}

/** Helper: continue chain and assert allowed. */
function mustContinue(tracker: InferenceChainTracker, chainId: string, frameId: string, serverId: string) {
  const result = tracker.continueChain(chainId, frameId, serverId);
  expect(result.allowed).toBe(true);
  if (!result.allowed) throw new Error(`continueChain unexpectedly denied: ${result.reason}`);
  return result;
}

// =============================================================================
// Tests
// =============================================================================

describe('InferenceChainTracker', () => {
  let tracker: InferenceChainTracker;

  beforeEach(() => {
    tracker = createTracker();
  });

  afterEach(() => {
    tracker.destroy();
  });

  // ---------------------------------------------------------------------------
  // createChain
  // ---------------------------------------------------------------------------

  describe('createChain', () => {
    it('creates chain and returns allowed=true with chainId and frameId', () => {
      const result = tracker.createChain('conv-1', 'server-a');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.chainId).toBeDefined();
        expect(result.frameId).toBeDefined();
        expect(typeof result.chainId).toBe('string');
        expect(typeof result.frameId).toBe('string');
      }
    });

    it('root frame has depth=0 and empty ancestorServerIds', () => {
      const result = mustCreate(tracker, 'conv-1', 'server-a');
      const chains = (tracker as any).chains as Map<string, any>;
      const chain = chains.get(result.chainId);
      const frame = chain.frames.get(result.frameId);

      expect(frame.depth).toBe(0);
      expect(frame.ancestorServerIds.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // continueChain
  // ---------------------------------------------------------------------------

  describe('continueChain', () => {
    it('continues chain with new frameId, same chainId', () => {
      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');
      const continued = mustContinue(tracker, chainId, frameId, 'server-b');

      expect(continued.chainId).toBe(chainId);
      expect(continued.frameId).not.toBe(frameId);
    });

    it('depth = parentFrame.depth + 1', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'server-a');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'server-b');
      const { frameId: f2 } = mustContinue(tracker, chainId, f1, 'server-c');

      const chains = (tracker as any).chains as Map<string, any>;
      const chain = chains.get(chainId);

      expect(chain.frames.get(f0).depth).toBe(0);
      expect(chain.frames.get(f1).depth).toBe(1);
      expect(chain.frames.get(f2).depth).toBe(2);
    });

    it('ancestorServerIds is copy-on-write: parent set unchanged after child creation', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'server-a');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'server-b');

      const chains = (tracker as any).chains as Map<string, any>;
      const chain = chains.get(chainId);

      const parentAncestors = chain.frames.get(f0).ancestorServerIds;
      const childAncestors = chain.frames.get(f1).ancestorServerIds;

      // Parent frame still has empty ancestors (root frame)
      expect(parentAncestors.size).toBe(0);
      // Child has parent's serverId in ancestors
      expect(childAncestors.has('server-a')).toBe(true);
      expect(childAncestors.size).toBe(1);
    });

    it('rejects if parentChainId not found', () => {
      const result = tracker.continueChain('nonexistent-chain', 'some-frame', 'server-a');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('not found');
      }
    });

    it('rejects if parentFrameId not in chain', () => {
      const { chainId } = mustCreate(tracker, 'conv-1', 'server-a');
      const result = tracker.continueChain(chainId, 'nonexistent-frame', 'server-b');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('not found in chain');
      }
    });

    it('rejects at MAX_DEPTH (depth=5 is the limit)', () => {
      // Create chain: depth 0 → 1 → 2 → 3 → 4 (all allowed)
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'srv-0');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'srv-1');
      const { frameId: f2 } = mustContinue(tracker, chainId, f1, 'srv-2');
      const { frameId: f3 } = mustContinue(tracker, chainId, f2, 'srv-3');
      const { frameId: f4 } = mustContinue(tracker, chainId, f3, 'srv-4');

      // Depth 5 should be rejected (MAX_DEPTH = 5)
      const result = tracker.continueChain(chainId, f4, 'srv-5');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('depth limit');
      }
    });

    it('cycle detection: A → B → A is rejected', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'server-a');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'server-b');

      // server-a is in ancestry of f1 → should be rejected
      const result = tracker.continueChain(chainId, f1, 'server-a');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Cycle detected');
        expect(result.reason).toContain('server-a');
      }
    });

    it('unique servers cap: >10 different servers rejected', () => {
      // MAX_UNIQUE_SERVERS = 10, MAX_DEPTH = 5
      // Use parallel sibling frames from root to avoid depth limit
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'srv-0');

      // Add 9 parallel children from root (each at depth=1), all different servers
      // Total unique: srv-0 (root) + srv-1..srv-9 = 10
      for (let i = 1; i <= 9; i++) {
        const child = mustContinue(tracker, chainId, f0, `srv-${i}`);
        // Complete immediately so they don't block (but uniqueServers is tracked per chain)
        tracker.completeFrame(chainId, child.frameId);
      }

      // 11th unique server should be rejected
      const result = tracker.continueChain(chainId, f0, 'srv-10');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('unique servers');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // completeFrame
  // ---------------------------------------------------------------------------

  describe('completeFrame', () => {
    it('decrements activeFrameCount', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'server-a');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'server-b');

      const chains = (tracker as any).chains as Map<string, any>;
      expect(chains.get(chainId).activeFrameCount).toBe(2);

      tracker.completeFrame(chainId, f1);
      expect(chains.get(chainId).activeFrameCount).toBe(1);
    });

    it('chain removed when activeFrameCount reaches 0', () => {
      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');

      const chains = (tracker as any).chains as Map<string, any>;
      expect(chains.has(chainId)).toBe(true);

      tracker.completeFrame(chainId, frameId);
      expect(chains.has(chainId)).toBe(false);
    });

    it('parallel frames: complete one sibling → chain survives, complete other → removed', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'server-a');

      // Two parallel children from same parent frame
      const child1 = mustContinue(tracker, chainId, f0, 'server-b');
      const child2 = mustContinue(tracker, chainId, f0, 'server-c');

      const chains = (tracker as any).chains as Map<string, any>;
      expect(chains.get(chainId).activeFrameCount).toBe(3); // root + 2 children

      // Complete child 1 — chain survives
      tracker.completeFrame(chainId, child1.frameId);
      expect(chains.has(chainId)).toBe(true);
      expect(chains.get(chainId).activeFrameCount).toBe(2);

      // Complete child 2 — chain still survives (root still active)
      tracker.completeFrame(chainId, child2.frameId);
      expect(chains.has(chainId)).toBe(true);
      expect(chains.get(chainId).activeFrameCount).toBe(1);

      // Complete root — chain removed
      tracker.completeFrame(chainId, f0);
      expect(chains.has(chainId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Backstops
  // ---------------------------------------------------------------------------

  describe('backstops', () => {
    it('max new chains per conversation per minute (11th rejected)', () => {
      // MAX_NEW_CHAINS_PER_CONVERSATION_PER_MIN = 10
      // Complete each chain to avoid hitting MAX_ACTIVE_CHAINS (5) first
      for (let i = 0; i < 10; i++) {
        const result = tracker.createChain('conv-1', `server-${i}`);
        expect(result.allowed).toBe(true);
        if (result.allowed) {
          tracker.completeFrame(result.chainId, result.frameId);
        }
      }

      const result = tracker.createChain('conv-1', 'server-overflow');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Too many new chains');
      }
    });

    it('max active chains per conversation (6th rejected)', () => {
      // MAX_ACTIVE_CHAINS_PER_CONVERSATION = 5
      for (let i = 0; i < 5; i++) {
        const result = tracker.createChain('conv-1', `server-${i}`);
        expect(result.allowed).toBe(true);
      }

      const result = tracker.createChain('conv-1', 'server-overflow');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Too many active chains');
      }
    });

    it('per-(serverId, conversationId) rate limit rejects when exhausted', () => {
      // MAX_INFERENCES_PER_SERVER_CONVERSATION_PER_MIN = 20
      // The per-server bucket key is serverId:conversationId.
      // Direct API testing is difficult because newChainBuckets (limit=10) exhausts first.
      // Instead: create 1 chain to seed the bucket, then manipulate it directly.

      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');
      tracker.completeFrame(chainId, frameId);

      // Verify the bucket was created
      const serverBuckets = (tracker as any).serverInferenceBuckets as Map<string, any>;
      const bucket = serverBuckets.get('server-a:conv-1');
      expect(bucket).toBeDefined();

      // Force bucket to 0 tokens (simulate 20 inferences consumed)
      bucket.tokens = 0;
      bucket.lastRefillAt = Date.now();

      // Next attempt should be blocked by per-server rate limit
      const result = tracker.createChain('conv-1', 'server-a');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Too many inferences from server');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  describe('cleanup', () => {
    it('expired chains removed on next create/continue call', () => {
      const { chainId } = mustCreate(tracker, 'conv-1', 'server-a');

      // Manually expire the chain (CHAIN_TTL_MS = 5 * 60 * 1000)
      const chains = (tracker as any).chains as Map<string, any>;
      chains.get(chainId).createdAt = Date.now() - 6 * 60 * 1000;

      // Trigger cleanup via createChain (piggyback)
      tracker.createChain('conv-2', 'server-b');

      expect(chains.has(chainId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  describe('stats', () => {
    it('reports chain count and total frame count', () => {
      expect(tracker.stats).toEqual({ chains: 0, totalFrames: 0 });

      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');
      expect(tracker.stats).toEqual({ chains: 1, totalFrames: 1 });

      mustContinue(tracker, chainId, frameId, 'server-b');
      expect(tracker.stats).toEqual({ chains: 1, totalFrames: 2 });
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('completeFrame is idempotent — second call on same frame is a no-op', () => {
      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');

      tracker.completeFrame(chainId, frameId);
      // Chain should be removed now (activeFrameCount was 1)
      expect(tracker.stats.chains).toBe(0);

      // Second call — should not throw or corrupt state
      expect(() => tracker.completeFrame(chainId, frameId)).not.toThrow();
      expect(tracker.stats.chains).toBe(0);
    });

    it('completeFrame on nonexistent chainId is a no-op', () => {
      expect(() => tracker.completeFrame('nonexistent', 'some-frame')).not.toThrow();
    });

    it('continueChain on expired chain returns not-allowed', () => {
      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');

      // Manually expire
      const chains = (tracker as any).chains as Map<string, any>;
      chains.get(chainId).createdAt = Date.now() - 6 * 60 * 1000;

      const result = tracker.continueChain(chainId, frameId, 'server-b');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('expired');
      }
      // Chain should be cleaned up
      expect(chains.has(chainId)).toBe(false);
    });

    it('destroy() is idempotent', () => {
      tracker.destroy();
      expect(() => tracker.destroy()).not.toThrow();
    });

    it('cleanup with no chains is a no-op', () => {
      expect(tracker.stats.chains).toBe(0);
      expect(() => (tracker as any).cleanup()).not.toThrow();
    });

    it('depth exactly MAX_DEPTH-1 (depth=4) is allowed', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'srv-0');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'srv-1');
      const { frameId: f2 } = mustContinue(tracker, chainId, f1, 'srv-2');
      const { frameId: f3 } = mustContinue(tracker, chainId, f2, 'srv-3');

      // depth=4 should still be allowed (MAX_DEPTH=5 means depth 0..4 ok)
      const result = tracker.continueChain(chainId, f3, 'srv-4');
      expect(result.allowed).toBe(true);

      // Verify it's actually at depth 4
      if (result.allowed) {
        const chains = (tracker as any).chains as Map<string, any>;
        const frame = chains.get(chainId).frames.get(result.frameId);
        expect(frame.depth).toBe(4);
      }
    });

    it('different conversations have independent backstop limits', () => {
      // Exhaust active chains for conv-1 (limit=5)
      for (let i = 0; i < 5; i++) {
        mustCreate(tracker, 'conv-1', `server-${i}`);
      }
      expect(tracker.createChain('conv-1', 'server-overflow').allowed).toBe(false);

      // conv-2 should still work
      const result = tracker.createChain('conv-2', 'server-0');
      expect(result.allowed).toBe(true);
    });

    it('activeChainCounts cleaned up after all chains for conversation complete', () => {
      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');
      const activeCounts = (tracker as any).activeChainCounts as Map<string, Set<string>>;

      expect(activeCounts.has('conv-1')).toBe(true);
      expect(activeCounts.get('conv-1')!.size).toBe(1);

      tracker.completeFrame(chainId, frameId);

      // After last chain completes, conversation entry should be cleaned up
      expect(activeCounts.has('conv-1')).toBe(false);
    });

    it('parallel siblings have same depth value', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'server-a');
      const c1 = mustContinue(tracker, chainId, f0, 'server-b');
      const c2 = mustContinue(tracker, chainId, f0, 'server-c');

      const chains = (tracker as any).chains as Map<string, any>;
      const chain = chains.get(chainId);

      expect(chain.frames.get(c1.frameId).depth).toBe(1);
      expect(chain.frames.get(c2.frameId).depth).toBe(1);
    });

    it('ancestorServerIds accumulates correctly through chain', () => {
      const { chainId, frameId: f0 } = mustCreate(tracker, 'conv-1', 'srv-root');
      const { frameId: f1 } = mustContinue(tracker, chainId, f0, 'srv-mid');
      const { frameId: f2 } = mustContinue(tracker, chainId, f1, 'srv-leaf');

      const chains = (tracker as any).chains as Map<string, any>;
      const chain = chains.get(chainId);

      // f0: ancestors = {} (root)
      expect(chain.frames.get(f0).ancestorServerIds.size).toBe(0);
      // f1: ancestors = {srv-root}
      expect(chain.frames.get(f1).ancestorServerIds.has('srv-root')).toBe(true);
      expect(chain.frames.get(f1).ancestorServerIds.size).toBe(1);
      // f2: ancestors = {srv-root, srv-mid}
      expect(chain.frames.get(f2).ancestorServerIds.has('srv-root')).toBe(true);
      expect(chain.frames.get(f2).ancestorServerIds.has('srv-mid')).toBe(true);
      expect(chain.frames.get(f2).ancestorServerIds.size).toBe(2);
    });

    it('zero-waste: no token burn when activeChains cap rejects (BUG 1 regression)', () => {
      const newChainBuckets = (tracker as any).newChainBuckets as Map<string, any>;
      const serverBuckets = (tracker as any).serverInferenceBuckets as Map<string, any>;

      // Fill 5 active chains to hit MAX_ACTIVE_CHAINS_PER_CONVERSATION
      for (let i = 0; i < 5; i++) {
        mustCreate(tracker, 'conv-1', `server-${i}`);
      }

      // Record bucket states before rejected attempt
      // Buckets for conv-1 and various server-X:conv-1 exist from creates above
      const newChainBucket = newChainBuckets.get('conv-1');
      const newChainTokensBefore = newChainBucket ? newChainBucket.tokens : undefined;

      // 6th chain should be rejected by activeChains cap (non-consuming)
      const result = tracker.createChain('conv-1', 'server-new');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Too many active chains');
      }

      // Neither bucket should have been touched
      if (newChainBucket) {
        expect(newChainBucket.tokens).toBe(newChainTokensBefore);
      }
      // server-new:conv-1 bucket should not exist (never peeked/consumed)
      expect(serverBuckets.has('server-new:conv-1')).toBe(false);
    });

    it('zero-waste: no token burn on peek failure (BUG 7 regression)', () => {
      const newChainBuckets = (tracker as any).newChainBuckets as Map<string, any>;
      const serverBuckets = (tracker as any).serverInferenceBuckets as Map<string, any>;

      // Create 1 chain to seed both buckets, then complete it
      const { chainId, frameId } = mustCreate(tracker, 'conv-1', 'server-a');
      tracker.completeFrame(chainId, frameId);

      // Force server bucket to 0 tokens (simulate exhaustion)
      const serverBucket = serverBuckets.get('server-a:conv-1');
      expect(serverBucket).toBeDefined();
      serverBucket.tokens = 0;
      serverBucket.lastRefillAt = Date.now();

      // Record newChain bucket tokens before attempt
      const newChainBucket = newChainBuckets.get('conv-1');
      expect(newChainBucket).toBeDefined();
      // Set to exact integer to avoid float comparison issues
      newChainBucket.tokens = 5;
      newChainBucket.lastRefillAt = Date.now();
      const newChainTokensBefore = newChainBucket.tokens;

      // Attempt should be rejected by server peek (0 tokens)
      const result = tracker.createChain('conv-1', 'server-a');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Too many inferences from server');
      }

      // newChain bucket should NOT have been consumed (zero waste)
      expect(newChainBucket.tokens).toBe(newChainTokensBefore);
    });
  });
});
