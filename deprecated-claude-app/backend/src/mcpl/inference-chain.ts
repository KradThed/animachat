/**
 * Inference Chain Tracker (Fix #5)
 *
 * Prevents infinite inference loops: mcpl/inference_request → tool call →
 * another mcpl/inference_request → ...
 *
 * Frame-based ancestry model:
 * - Each inference in a chain is a "frame" with its own frameId
 * - ancestorServerIds is immutable per frame (copy-on-write, ReadonlySet<string>)
 * - Parallel sibling frames are safe (depth = ancestry depth, not global counter)
 * - Chain is cleaned when activeFrameCount === 0
 *
 * 3-layer protection:
 * 1. Depth limit (MAX_DEPTH = 5)
 * 2. Cycle detection (serverId ∈ ancestorServerIds) — configurable via STRICT_ANCESTRY_CHECK
 * 3. Unique server count per chain (MAX_UNIQUE_SERVERS = 10)
 *
 * Backstops for parentChainId bypass (server omits it):
 * - Max new chains per conversationId per minute
 * - Max active chains per conversationId
 * - Per-(serverId, conversationId) inference rate limit
 */

import { randomUUID } from 'crypto';

// =============================================================================
// Configuration
// =============================================================================

const MAX_DEPTH = 5;
const MAX_UNIQUE_SERVERS = 10;
const CHAIN_TTL_MS = 5 * 60 * 1000;  // 5 minutes

// Backstop limits
const MAX_NEW_CHAINS_PER_CONVERSATION_PER_MIN = 10;
const MAX_ACTIVE_CHAINS_PER_CONVERSATION = 5;
const MAX_INFERENCES_PER_SERVER_CONVERSATION_PER_MIN = 20;

// Feature flag: strict "server only once per ancestry" check
const STRICT_ANCESTRY_CHECK = true;

// Cleanup interval
const CLEANUP_INTERVAL_MS = 60_000;

// =============================================================================
// Types
// =============================================================================

interface ChainFrame {
  chainId: string;
  frameId: string;
  parentFrameId: string | null;
  serverId: string;
  depth: number;  // ancestry depth (parent.depth + 1), NOT global counter
  ancestorServerIds: ReadonlySet<string>;  // immutable by construction — never mutated after creation
}

interface Chain {
  chainId: string;
  conversationId: string;
  createdAt: number;
  activeFrameCount: number;
  uniqueServers: Set<string>;
  frames: Map<string, ChainFrame>;  // frameId → frame
}

// Token bucket for backstop rate limiting
interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRatePerMs: number;  // tokens per millisecond = maxTokens / windowMs
  lastRefillAt: number;
}

// =============================================================================
// InferenceChainTracker
// =============================================================================

export class InferenceChainTracker {
  private chains = new Map<string, Chain>();

  // Backstop tracking
  private newChainBuckets = new Map<string, TokenBucket>();        // conversationId → bucket
  private activeChainCounts = new Map<string, Set<string>>();      // conversationId → Set<chainId>
  private serverInferenceBuckets = new Map<string, TokenBucket>(); // serverId:conversationId → bucket

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Safety net for abandoned chains (connection dropped mid-chain)
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Create a new chain (no parent — first inference in sequence).
   * Checks backstop limits before creating.
   */
  createChain(
    conversationId: string,
    serverId: string,
  ): { allowed: true; chainId: string; frameId: string } | { allowed: false; reason: string } {
    // Piggyback cleanup on create
    this.cleanup();

    // Backstop: max active chains per conversation (non-consuming check FIRST)
    const activeChainsForConv = this.activeChainCounts.get(conversationId) || new Set();
    if (activeChainsForConv.size >= MAX_ACTIVE_CHAINS_PER_CONVERSATION) {
      return { allowed: false, reason: `Too many active chains for conversation (limit: ${MAX_ACTIVE_CHAINS_PER_CONVERSATION})` };
    }

    // Peek-then-commit: check both token buckets BEFORE consuming either.
    // This prevents wasting tokens from one bucket when the other rejects.
    // serverInferenceBuckets is shared with continueChain() — burning tokens here
    // on rejected createChain() requests would starve legitimate chain continuations.
    // No await between peek and commit → effectively atomic in JS.

    // Peek: per-(serverId, conversationId) rate limit (narrow, shared with continueChain)
    const serverConvKey = `${serverId}:${conversationId}`;
    const serverPeek = this.peekToken(this.serverInferenceBuckets, serverConvKey, MAX_INFERENCES_PER_SERVER_CONVERSATION_PER_MIN, 60_000);
    if (!serverPeek.ok) {
      return { allowed: false, reason: `Too many inferences from server ${serverId} for conversation (limit: ${MAX_INFERENCES_PER_SERVER_CONVERSATION_PER_MIN}/min)` };
    }

    // Peek: max new chains per conversation per minute (broad, createChain-only)
    const newChainKey = conversationId;
    const newChainPeek = this.peekToken(this.newChainBuckets, newChainKey, MAX_NEW_CHAINS_PER_CONVERSATION_PER_MIN, 60_000);
    if (!newChainPeek.ok) {
      return { allowed: false, reason: `Too many new chains for conversation (limit: ${MAX_NEW_CHAINS_PER_CONVERSATION_PER_MIN}/min)` };
    }

    // Commit: both peeks passed — consume from both buckets (synchronous, no IO)
    serverPeek.bucket.tokens -= 1;
    newChainPeek.bucket.tokens -= 1;

    const chainId = randomUUID();
    const frameId = randomUUID();

    const frame: ChainFrame = {
      chainId,
      frameId,
      parentFrameId: null,
      serverId,
      depth: 0,
      ancestorServerIds: new Set(),  // root frame has no ancestors
    };

    const chain: Chain = {
      chainId,
      conversationId,
      createdAt: Date.now(),
      activeFrameCount: 1,
      uniqueServers: new Set([serverId]),
      frames: new Map([[frameId, frame]]),
    };

    this.chains.set(chainId, chain);

    // Track active chains per conversation
    if (!this.activeChainCounts.has(conversationId)) {
      this.activeChainCounts.set(conversationId, new Set());
    }
    this.activeChainCounts.get(conversationId)!.add(chainId);

    return { allowed: true, chainId, frameId };
  }

  /**
   * Continue an existing chain (inference triggered by a tool call in the chain).
   * Validates parentChainId + parentFrameId, checks depth and cycle detection.
   */
  continueChain(
    parentChainId: string,
    parentFrameId: string,
    serverId: string,
  ): { allowed: true; chainId: string; frameId: string } | { allowed: false; reason: string } {
    // Piggyback cleanup on continue
    this.cleanup();

    // Guard 1: parentChain exists and not expired
    const chain = this.chains.get(parentChainId);
    if (!chain) {
      return { allowed: false, reason: 'Parent chain not found or expired' };
    }
    if (Date.now() - chain.createdAt > CHAIN_TTL_MS) {
      this.removeChain(parentChainId);
      return { allowed: false, reason: 'Parent chain expired' };
    }

    // Guard 2: parentFrame exists within this chainId
    const parentFrame = chain.frames.get(parentFrameId);
    if (!parentFrame) {
      return { allowed: false, reason: 'Parent frame not found in chain (possible forgery)' };
    }

    // Check depth limit
    const newDepth = parentFrame.depth + 1;
    if (newDepth >= MAX_DEPTH) {
      return { allowed: false, reason: `Inference chain depth limit reached (max: ${MAX_DEPTH})` };
    }

    // Cycle detection: immutable by construction — new Set from parent + parent's serverId
    const ancestorServerIds: ReadonlySet<string> = new Set([
      ...parentFrame.ancestorServerIds,
      parentFrame.serverId,
    ]);

    // Strict ancestry check (configurable via feature flag)
    if (STRICT_ANCESTRY_CHECK && ancestorServerIds.has(serverId)) {
      return { allowed: false, reason: `Cycle detected: server ${serverId} already in ancestry chain` };
    }

    // Unique servers per chain cap
    const uniqueAfter = new Set(chain.uniqueServers);
    uniqueAfter.add(serverId);
    if (uniqueAfter.size > MAX_UNIQUE_SERVERS) {
      return { allowed: false, reason: `Too many unique servers in chain (max: ${MAX_UNIQUE_SERVERS})` };
    }

    // Backstop: per-(serverId, conversationId) rate limit
    const serverConvKey = `${serverId}:${chain.conversationId}`;
    if (!this.consumeToken(this.serverInferenceBuckets, serverConvKey, MAX_INFERENCES_PER_SERVER_CONVERSATION_PER_MIN, 60_000)) {
      return { allowed: false, reason: `Too many inferences from server ${serverId} for conversation` };
    }

    // Create new frame
    const frameId = randomUUID();
    const frame: ChainFrame = {
      chainId: parentChainId,
      frameId,
      parentFrameId,
      serverId,
      depth: newDepth,
      ancestorServerIds,
    };

    chain.frames.set(frameId, frame);
    chain.uniqueServers.add(serverId);
    chain.activeFrameCount++;

    return { allowed: true, chainId: parentChainId, frameId };
  }

  /**
   * Complete a frame. Decrements activeFrameCount.
   * Chain is removed when activeFrameCount reaches 0.
   */
  completeFrame(chainId: string, frameId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;

    // Remove the frame
    chain.frames.delete(frameId);
    chain.activeFrameCount = Math.max(0, chain.activeFrameCount - 1);

    // Clean up chain if no active frames remain
    if (chain.activeFrameCount === 0) {
      this.removeChain(chainId);
    }
  }

  /**
   * Clean up expired chains and stale backstop buckets.
   * Called on every create/continue (piggyback) + setInterval as safety net.
   */
  cleanup(): void {
    const now = Date.now();

    // Remove expired chains
    for (const [chainId, chain] of this.chains) {
      if (now - chain.createdAt > CHAIN_TTL_MS) {
        this.removeChain(chainId);
      }
    }

    // Clean up empty bucket maps (prevent memory leak)
    for (const [key, bucket] of this.newChainBuckets) {
      if (this.isTokenBucketFull(bucket, now)) {
        this.newChainBuckets.delete(key);
      }
    }
    for (const [key, bucket] of this.serverInferenceBuckets) {
      if (this.isTokenBucketFull(bucket, now)) {
        this.serverInferenceBuckets.delete(key);
      }
    }
  }

  /**
   * Stop the background cleanup timer (for graceful shutdown/testing).
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Current state (for testing/metrics).
   */
  get stats(): { chains: number; totalFrames: number } {
    let totalFrames = 0;
    for (const chain of this.chains.values()) {
      totalFrames += chain.frames.size;
    }
    return { chains: this.chains.size, totalFrames };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private removeChain(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;

    // Remove from active chain tracking
    const activeSet = this.activeChainCounts.get(chain.conversationId);
    if (activeSet) {
      activeSet.delete(chainId);
      if (activeSet.size === 0) {
        this.activeChainCounts.delete(chain.conversationId);
      }
    }

    this.chains.delete(chainId);
  }

  /**
   * Get or create a token bucket. Always starts full (tokens = maxTokens).
   * Bucket initialization is separated from consumption to prevent
   * divergence between peek and consume paths.
   */
  private getOrInitBucket(
    buckets: Map<string, TokenBucket>,
    key: string,
    maxTokens: number,
    windowMs: number,
    now: number,
  ): TokenBucket {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: maxTokens,
        maxTokens,
        refillRatePerMs: maxTokens / windowMs,
        lastRefillAt: now,
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Refill a bucket based on elapsed time. Single source of truth for refill logic.
   * Idempotent if called multiple times in same tick (elapsed <= 0 → no-op).
   */
  private refillBucket(bucket: TokenBucket, now: number): void {
    const elapsed = now - bucket.lastRefillAt;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRatePerMs);
    bucket.lastRefillAt = now;
  }

  /**
   * Token bucket: consume one token. Returns true if allowed.
   * Uses getOrInitBucket() + refillBucket() for consistent behavior.
   * Used by continueChain() where only one bucket needs consuming.
   */
  private consumeToken(
    buckets: Map<string, TokenBucket>,
    key: string,
    maxTokens: number,
    windowMs: number,
  ): boolean {
    const now = Date.now();
    const bucket = this.getOrInitBucket(buckets, key, maxTokens, windowMs, now);
    this.refillBucket(bucket, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Peek: refill + check availability WITHOUT consuming.
   * Returns the bucket reference for subsequent commit (bucket.tokens -= 1).
   *
   * Used by createChain() which must peek multiple buckets before committing any,
   * ensuring zero wasted tokens on partial failure.
   *
   * Refill contract: peek updates lastRefillAt. Commit is just `bucket.tokens -= 1`
   * (no refill, no lastRefillAt update). If consumeToken() is called on the same
   * bucket in the same tick, refillBucket()'s elapsed <= 0 guard is a no-op — safe.
   */
  private peekToken(
    buckets: Map<string, TokenBucket>,
    key: string,
    maxTokens: number,
    windowMs: number,
  ): { ok: boolean; bucket: TokenBucket } {
    const now = Date.now();
    const bucket = this.getOrInitBucket(buckets, key, maxTokens, windowMs, now);
    this.refillBucket(bucket, now);
    return { ok: bucket.tokens >= 1, bucket };
  }

  /**
   * Check if a token bucket is full (for cleanup: if full, it's idle).
   */
  private isTokenBucketFull(bucket: TokenBucket, now: number): boolean {
    const elapsed = now - bucket.lastRefillAt;
    const currentTokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRatePerMs);
    return currentTokens >= bucket.maxTokens;
  }
}

// Singleton instance
export const inferenceChainTracker = new InferenceChainTracker();
