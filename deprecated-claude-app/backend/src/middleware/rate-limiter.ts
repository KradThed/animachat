/**
 * MCPL Rate Limiter (Fix #2)
 *
 * Token bucket algorithm for per-user and global rate limiting of
 * MCPL WebSocket messages. O(1) memory per user, fixed cost per check.
 *
 * Check order: per-user FIRST → global SECOND
 * (reject cheap before touching shared state)
 *
 * Cost contract: cost = 1 per message for all operation types.
 * If future differentiation needed (e.g., streaming inference costs more),
 * extend check() to accept cost param.
 *
 * Single-instance contract: this in-memory limiter is accurate only for
 * single backend instance. If multi-instance needed, swap to Redis
 * (separate scope — not this fix).
 */

// =============================================================================
// Types
// =============================================================================

export type McplOperationType = 'pushEvents' | 'inferenceRequests' | 'stateOps' | 'toolCalls';

interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRatePerMs: number;  // tokens/ms = maxTokens / WINDOW_MS
  lastRefillAt: number;
}

interface UserBuckets {
  buckets: Map<McplOperationType, TokenBucket>;
  lastSeenAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;   // Math.ceil, always >= 1 when rate limited
  blockedBy?: 'user' | 'global';
}

interface OpConfig {
  userLimit: number;     // tokens per minute per user
  globalLimit: number;   // tokens per minute global
}

// =============================================================================
// Configuration
// =============================================================================

const OP_CONFIGS: Record<McplOperationType, OpConfig> = {
  pushEvents:         { userLimit: 60,  globalLimit: 600 },
  inferenceRequests:  { userLimit: 30,  globalLimit: 300 },
  stateOps:           { userLimit: 120, globalLimit: 1200 },
  toolCalls:          { userLimit: 60,  globalLimit: 600 },
};

const WINDOW_MS = 60_000;  // 1 minute window for all buckets
const GC_INTERVAL_MS = 60_000;
const IDLE_THRESHOLD_MS = 5 * 60_000;  // 5 minutes idle → GC eligible

// =============================================================================
// Message type → operation type mapping
// =============================================================================

const MESSAGE_TYPE_TO_OP: Record<string, McplOperationType> = {
  'mcpl/push_event':          'pushEvents',
  'mcpl/inference_request':   'inferenceRequests',
  'mcpl/state_set':           'stateOps',
  'mcpl/state_patch':         'stateOps',
  'mcpl/state_rollback':      'stateOps',
  'mcpl/state_get':           'stateOps',
  'mcpl/checkpoint_list':     'stateOps',
  'mcpl/scope_change_request':    'stateOps',
  'mcpl/scope_elevate_request':   'stateOps',
  'mcpl/connect_server_result':   'stateOps',
  'mcpl/featureSets_changed':     'stateOps',
  'mcpl/model_info_request':      'stateOps',
  // tool_result classified as toolCalls (otherwise flood via tool_result)
  'tool_call_response':       'toolCalls',
};

// Default catch-all for unmapped mcpl/* types → stateOps
const DEFAULT_MCPL_OP: McplOperationType = 'stateOps';

/**
 * Map a message type to its rate limit operation type.
 * Returns undefined for messages that shouldn't be rate limited
 * (e.g., mcpl/hello, mcpl/ack, ping, delegate_auth).
 */
export function messageTypeToOpType(type: string): McplOperationType | undefined {
  const mapped = MESSAGE_TYPE_TO_OP[type];
  if (mapped) return mapped;

  // Catch-all for unmapped mcpl/* types — prevents finding unmapped loopholes
  if (type.startsWith('mcpl/')) {
    // Exclude handshake/ack messages that shouldn't be rate limited
    if (type === 'mcpl/hello' || type === 'mcpl/ack' ||
        type === 'mcpl/beforeInference_response' || type === 'mcpl/afterInference_ack') {
      return undefined;
    }
    return DEFAULT_MCPL_OP;
  }

  return undefined;
}

// =============================================================================
// McplRateLimiter
// =============================================================================

export class McplRateLimiter {
  private users = new Map<string, UserBuckets>();
  private globalBuckets = new Map<McplOperationType, TokenBucket>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Initialize global buckets
    for (const [opType, config] of Object.entries(OP_CONFIGS)) {
      this.globalBuckets.set(opType as McplOperationType, {
        tokens: config.globalLimit,
        maxTokens: config.globalLimit,
        refillRatePerMs: config.globalLimit / WINDOW_MS,
        lastRefillAt: Date.now(),
      });
    }

    // GC sweep for idle user buckets
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
  }

  /**
   * Check if a message is allowed. Returns result with retryAfterMs if blocked.
   * Check order: per-user FIRST → global SECOND.
   *
   * Preview-then-commit: computes refilled token counts without mutating bucket
   * state. Only commits (tokens + lastRefillAt) when the request is allowed.
   * This prevents rejected requests from advancing lastRefillAt, which would
   * make the limiter stricter than configured under sustained burst.
   */
  check(userId: string, opType: McplOperationType): RateLimitResult {
    const config = OP_CONFIGS[opType];
    const now = Date.now();

    // Get or create user buckets
    let userEntry = this.users.get(userId);
    if (!userEntry) {
      userEntry = { buckets: new Map(), lastSeenAt: now };
      this.users.set(userId, userEntry);
    }
    userEntry.lastSeenAt = now;

    let userBucket = userEntry.buckets.get(opType);
    if (!userBucket) {
      userBucket = { tokens: config.userLimit, maxTokens: config.userLimit, refillRatePerMs: config.userLimit / WINDOW_MS, lastRefillAt: now };
      userEntry.buckets.set(opType, userBucket);
    }

    // Preview: compute refilled tokens without mutating bucket state
    const userPreview = this.preview(userBucket, now);
    if (userPreview < 1) {
      const missing = 1 - userPreview;
      const retryAfterMs = Math.max(1, Math.ceil(missing / userBucket.refillRatePerMs));
      return { allowed: false, retryAfterMs, blockedBy: 'user' };
    }

    const globalBucket = this.globalBuckets.get(opType)!;
    const globalPreview = this.preview(globalBucket, now);
    if (globalPreview < 1) {
      const missing = 1 - globalPreview;
      const retryAfterMs = Math.max(1, Math.ceil(missing / globalBucket.refillRatePerMs));
      return { allowed: false, retryAfterMs, blockedBy: 'global' };
    }

    // Commit: both passed — apply refill + consume (synchronous, no IO)
    this.commit(userBucket, userPreview, now);
    this.commit(globalBucket, globalPreview, now);

    return { allowed: true };
  }

  /**
   * Stop the GC timer (for graceful shutdown/testing).
   */
  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /**
   * Current state (for testing/metrics).
   */
  get userCount(): number {
    return this.users.size;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  /**
   * Compute refilled token count WITHOUT mutating bucket state.
   * Returns what tokens would be after refill.
   */
  private preview(bucket: TokenBucket, now: number): number {
    const elapsed = now - bucket.lastRefillAt;
    if (elapsed <= 0) return bucket.tokens;
    return Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRatePerMs);
  }

  /**
   * Apply previewed token count and consume 1 token.
   * Called only after all checks pass.
   */
  private commit(bucket: TokenBucket, previewedTokens: number, now: number): void {
    bucket.tokens = previewedTokens - 1;
    bucket.lastRefillAt = now;
  }

  /**
   * GC: remove idle user buckets where lastSeenAt + 5min < now.
   */
  private gc(): void {
    const now = Date.now();
    for (const [userId, entry] of this.users) {
      if (now - entry.lastSeenAt > IDLE_THRESHOLD_MS) {
        this.users.delete(userId);
      }
    }
  }
}

// Singleton instance
export const mcplRateLimiter = new McplRateLimiter();
