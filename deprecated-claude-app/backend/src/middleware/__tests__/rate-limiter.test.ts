import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McplRateLimiter, messageTypeToOpType } from '../rate-limiter.js';

// =============================================================================
// Helpers
// =============================================================================

function createLimiter(): McplRateLimiter {
  return new McplRateLimiter();
}

// =============================================================================
// Tests: messageTypeToOpType
// =============================================================================

describe('messageTypeToOpType', () => {
  it('maps mcpl/push_event → pushEvents', () => {
    expect(messageTypeToOpType('mcpl/push_event')).toBe('pushEvents');
  });

  it('maps mcpl/inference_request → inferenceRequests', () => {
    expect(messageTypeToOpType('mcpl/inference_request')).toBe('inferenceRequests');
  });

  it('maps mcpl/state_set → stateOps', () => {
    expect(messageTypeToOpType('mcpl/state_set')).toBe('stateOps');
  });

  it('maps mcpl/state_patch → stateOps', () => {
    expect(messageTypeToOpType('mcpl/state_patch')).toBe('stateOps');
  });

  it('maps tool_call_response → toolCalls', () => {
    expect(messageTypeToOpType('tool_call_response')).toBe('toolCalls');
  });

  it('maps unknown mcpl/* type → stateOps (catch-all)', () => {
    expect(messageTypeToOpType('mcpl/some_future_type')).toBe('stateOps');
  });

  it('returns undefined for mcpl/hello (handshake, excluded)', () => {
    expect(messageTypeToOpType('mcpl/hello')).toBeUndefined();
  });

  it('returns undefined for mcpl/ack (excluded)', () => {
    expect(messageTypeToOpType('mcpl/ack')).toBeUndefined();
  });

  it('returns undefined for mcpl/beforeInference_response (excluded)', () => {
    expect(messageTypeToOpType('mcpl/beforeInference_response')).toBeUndefined();
  });

  it('returns undefined for mcpl/afterInference_ack (excluded)', () => {
    expect(messageTypeToOpType('mcpl/afterInference_ack')).toBeUndefined();
  });

  it('returns undefined for non-mcpl types', () => {
    expect(messageTypeToOpType('ping')).toBeUndefined();
    expect(messageTypeToOpType('delegate_auth')).toBeUndefined();
    expect(messageTypeToOpType('tool_manifest')).toBeUndefined();
  });
});

// =============================================================================
// Tests: McplRateLimiter
// =============================================================================

describe('McplRateLimiter', () => {
  let limiter: McplRateLimiter;

  beforeEach(() => {
    limiter = createLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  // ---------------------------------------------------------------------------
  // check — basic
  // ---------------------------------------------------------------------------

  describe('check — basic', () => {
    it('allows first request', () => {
      const result = limiter.check('user-1', 'pushEvents');
      expect(result.allowed).toBe(true);
    });

    it('allows requests up to per-user limit', () => {
      // inferenceRequests limit = 30/min
      for (let i = 0; i < 30; i++) {
        const result = limiter.check('user-1', 'inferenceRequests');
        expect(result.allowed).toBe(true);
      }
    });

    it('blocks request at per-user limit+1', () => {
      // Exhaust per-user limit (30 for inferenceRequests)
      for (let i = 0; i < 30; i++) {
        limiter.check('user-1', 'inferenceRequests');
      }

      const result = limiter.check('user-1', 'inferenceRequests');
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe('user');
    });

    it('retryAfterMs is always >= 1 (never 0)', () => {
      // Exhaust per-user limit
      for (let i = 0; i < 30; i++) {
        limiter.check('user-1', 'inferenceRequests');
      }

      const result = limiter.check('user-1', 'inferenceRequests');
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeDefined();
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1);
    });

    it('blockedBy is "user" when per-user limit hit', () => {
      for (let i = 0; i < 60; i++) {
        limiter.check('user-1', 'pushEvents');
      }

      const result = limiter.check('user-1', 'pushEvents');
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe('user');
    });

    it('different users have independent limits', () => {
      // User 1 exhausts their limit
      for (let i = 0; i < 30; i++) {
        limiter.check('user-1', 'inferenceRequests');
      }
      expect(limiter.check('user-1', 'inferenceRequests').allowed).toBe(false);

      // User 2 still has full budget
      const result = limiter.check('user-2', 'inferenceRequests');
      expect(result.allowed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // check — global limit
  // ---------------------------------------------------------------------------

  describe('check — global limit', () => {
    it('multiple users exhaust global limit → blockedBy = "global"', () => {
      // Global inferenceRequests limit = 300/min
      // Use 10 users, each sending 30 (= 300 total)
      for (let u = 0; u < 10; u++) {
        for (let i = 0; i < 30; i++) {
          limiter.check(`user-${u}`, 'inferenceRequests');
        }
      }

      // Next request from a fresh user should be blocked by global
      const result = limiter.check('user-new', 'inferenceRequests');
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe('global');
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // userCount metric
  // ---------------------------------------------------------------------------

  describe('userCount', () => {
    it('tracks number of unique users', () => {
      expect(limiter.userCount).toBe(0);

      limiter.check('user-1', 'pushEvents');
      expect(limiter.userCount).toBe(1);

      limiter.check('user-2', 'pushEvents');
      expect(limiter.userCount).toBe(2);

      // Same user again — no change
      limiter.check('user-1', 'stateOps');
      expect(limiter.userCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('all 4 opTypes are independently limited', () => {
      // Exhaust pushEvents for user
      for (let i = 0; i < 60; i++) limiter.check('user-1', 'pushEvents');
      expect(limiter.check('user-1', 'pushEvents').allowed).toBe(false);

      // But other opTypes still work for same user
      expect(limiter.check('user-1', 'inferenceRequests').allowed).toBe(true);
      expect(limiter.check('user-1', 'stateOps').allowed).toBe(true);
      expect(limiter.check('user-1', 'toolCalls').allowed).toBe(true);
    });

    it('per-user tokens consumed even when request is ultimately allowed', () => {
      // Each allowed check should consume exactly 1 token from both user + global
      limiter.check('user-1', 'inferenceRequests');
      limiter.check('user-1', 'inferenceRequests');

      // Access internal state to verify token count decreased
      const users = (limiter as any).users as Map<string, any>;
      const userBucket = users.get('user-1')!.buckets.get('inferenceRequests')!;
      // Started at 30 tokens, consumed 2, should be ~28 (small refill possible)
      expect(userBucket.tokens).toBeLessThan(29);
      expect(userBucket.tokens).toBeGreaterThan(27);
    });

    it('destroy() is idempotent — second call does not throw', () => {
      limiter.destroy();
      expect(() => limiter.destroy()).not.toThrow();
    });

    it('check() still works after destroy() (just no GC)', () => {
      limiter.destroy();
      const result = limiter.check('user-1', 'pushEvents');
      expect(result.allowed).toBe(true);
    });

    it('retryAfterMs is an integer (Math.ceil)', () => {
      // Exhaust user limit
      for (let i = 0; i < 30; i++) limiter.check('user-1', 'inferenceRequests');
      const result = limiter.check('user-1', 'inferenceRequests');
      expect(result.retryAfterMs).toBe(Math.floor(result.retryAfterMs!));
    });

    it('stateOps has highest per-user limit (120/min)', () => {
      for (let i = 0; i < 120; i++) {
        const r = limiter.check('user-1', 'stateOps');
        expect(r.allowed).toBe(true);
      }
      expect(limiter.check('user-1', 'stateOps').allowed).toBe(false);
    });

    it('toolCalls limit includes tool_call_response messages', () => {
      // Verify the mapping exists (tested in messageTypeToOpType)
      // and that toolCalls limit = 60 works
      for (let i = 0; i < 60; i++) {
        expect(limiter.check('user-1', 'toolCalls').allowed).toBe(true);
      }
      expect(limiter.check('user-1', 'toolCalls').allowed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // BUG 8 regression: preview-then-commit
  // ---------------------------------------------------------------------------

  describe('preview-then-commit (BUG 8 regression)', () => {
    it('rejected requests do not advance lastRefillAt', () => {
      // Exhaust user bucket for inferenceRequests (30 calls)
      for (let i = 0; i < 30; i++) limiter.check('user-1', 'inferenceRequests');

      const users = (limiter as any).users as Map<string, any>;
      const bucket = users.get('user-1')!.buckets.get('inferenceRequests')!;

      // Force time backward to simulate 100ms passing since last refill
      bucket.lastRefillAt = Date.now() - 100;
      const lastRefillAfterBackdate = bucket.lastRefillAt;
      const tokensBefore = bucket.tokens;

      // Rejected request should NOT update lastRefillAt or tokens
      const result = limiter.check('user-1', 'inferenceRequests');
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe('user');
      expect(bucket.lastRefillAt).toBe(lastRefillAfterBackdate);
      expect(bucket.tokens).toBe(tokensBefore);
    });

    it('rejected by global does not advance user bucket state', () => {
      // Exhaust global inferenceRequests (10 users × 30 = 300)
      for (let u = 0; u < 10; u++) {
        for (let i = 0; i < 30; i++) limiter.check(`user-${u}`, 'inferenceRequests');
      }

      // Fresh user — user bucket has full tokens but global is exhausted
      const result = limiter.check('user-fresh', 'inferenceRequests');
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe('global');

      // User bucket should NOT have been touched (no token consumed, no lastRefillAt advanced)
      const users = (limiter as any).users as Map<string, any>;
      const bucket = users.get('user-fresh')!.buckets.get('inferenceRequests')!;
      // Bucket was just created with full tokens — should still be full
      expect(bucket.tokens).toBe(30);
    });
  });

  // ---------------------------------------------------------------------------
  // messageTypeToOpType: exhaustive mapping coverage
  // ---------------------------------------------------------------------------

  describe('messageTypeToOpType — exhaustive mapping', () => {
    it('mcpl/state_rollback → stateOps', () => {
      expect(messageTypeToOpType('mcpl/state_rollback')).toBe('stateOps');
    });

    it('mcpl/state_get → stateOps', () => {
      expect(messageTypeToOpType('mcpl/state_get')).toBe('stateOps');
    });

    it('mcpl/checkpoint_list → stateOps', () => {
      expect(messageTypeToOpType('mcpl/checkpoint_list')).toBe('stateOps');
    });

    it('mcpl/scope_change_request → stateOps', () => {
      expect(messageTypeToOpType('mcpl/scope_change_request')).toBe('stateOps');
    });

    it('mcpl/scope_elevate_request → stateOps', () => {
      expect(messageTypeToOpType('mcpl/scope_elevate_request')).toBe('stateOps');
    });

    it('mcpl/connect_server_result → stateOps', () => {
      expect(messageTypeToOpType('mcpl/connect_server_result')).toBe('stateOps');
    });

    it('mcpl/featureSets_changed → stateOps', () => {
      expect(messageTypeToOpType('mcpl/featureSets_changed')).toBe('stateOps');
    });

    it('mcpl/model_info_request → stateOps', () => {
      expect(messageTypeToOpType('mcpl/model_info_request')).toBe('stateOps');
    });
  });
});
