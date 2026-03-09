/**
 * MCPL Hook Manager
 *
 * Manages beforeInference / afterInference hooks for MCPL-connected servers.
 *
 * Flow:
 *   1. User sends message
 *   2. Host calls beforeInference on ALL MCPL servers with context_hooks (parallel, with timeout)
 *   3. Servers return injections: { position, content }
 *   4. Sort injections by serverId for deterministic ordering
 *   5. Host assembles context placing injections by position
 *   6. Run inference
 *   7. Host calls afterInference (fire-and-forget notify for MVP)
 *
 * Critical: deterministic ordering — injections sorted by serverId before injection.
 * Same config = same context regardless of response timing.
 */

import { randomUUID } from 'crypto';
import type { McplTransport } from '../delegate/mcpl-transport.js';
import type { McplContextInjection } from '@deprecated-claude/shared';
import { matchesPattern } from './mcpl-wildcard.js';

// =============================================================================
// Types
// =============================================================================

export interface McplHookManagerConfig {
  beforeInferenceTimeoutMs: number;          // default 5000
  afterInferenceTimeoutMs: number;           // default 10000
  maxCallsPerMinutePerDelegate: number;      // default 10 — rate limit per delegate
}

interface RegisteredHookServer {
  sessionId: string;
  delegateId: string;
  userId: string;
  transport: McplTransport;
  serverIds: string[];         // which serverIds support context_hooks (may contain wildcards)
}

/** Per-server response from beforeInference (internal) */
interface ServerBeforeInferenceResult {
  injections: McplContextInjection[];
  abort?: boolean;
  abortReason?: string;
}

/** Aggregated result from beforeInference (public) */
export interface BeforeInferenceResult {
  injections: McplContextInjection[];
  abort: boolean;
  abortReason?: string;
  abortServerId?: string;  // which server requested abort (for logging/UI)
}

interface PendingHookRequest {
  requestId: string;
  resolve: (result: ServerBeforeInferenceResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface InferenceHookContext {
  conversationId: string;
  userId: string;
  isSubAgent: boolean;
  taskId?: string;    // sub-agent only
  groupId?: string;   // sub-agent only
  instruction?: string; // sub-agent task instruction
  // Gap 6: additional context per MCPL spec
  inferenceId?: string;   // unique ID for this inference run
  turnIndex?: number;     // conversation turn number
  model?: string;         // model ID being used
}

// =============================================================================
// McplHookManager
// =============================================================================

export class McplHookManager {
  private config: McplHookManagerConfig;

  /** Registered hook servers keyed by sessionId */
  private servers: Map<string, RegisteredHookServer> = new Map();

  /** Pending beforeInference requests keyed by requestId */
  private pendingRequests: Map<string, PendingHookRequest> = new Map();

  /** Max hook depth before stopping re-entrant hooks (sync loop prevention) */
  private static readonly MAX_HOOK_DEPTH = 3;

  /** Per-delegate call timestamps for rate limiting (async loop prevention) */
  private delegateCallTimestamps: Map<string, number[]> = new Map();

  /** Per-delegate custom rate limits (overrides config.maxCallsPerMinutePerDelegate) */
  private delegateRateLimits: Map<string, number> = new Map();

  constructor(config?: Partial<McplHookManagerConfig>) {
    this.config = {
      beforeInferenceTimeoutMs: 5000,
      afterInferenceTimeoutMs: 10000,
      maxCallsPerMinutePerDelegate: 10,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Server Registration
  // --------------------------------------------------------------------------

  /**
   * Register a delegate connection as supporting context hooks for specific serverIds.
   */
  registerServer(
    sessionId: string,
    delegateId: string,
    userId: string,
    transport: McplTransport,
    serverIds: string[]
  ): void {
    this.servers.set(sessionId, { sessionId, delegateId, userId, transport, serverIds });
    console.log(`[McplHookManager] Registered hook server: ${delegateId} (serverIds: ${serverIds.join(', ')})`);
  }

  /**
   * Update registered serverIds for a hook server (e.g., after featureSets_changed).
   * If new serverIds is empty, unregisters the server.
   */
  updateServerIds(sessionId: string, serverIds: string[]): void {
    const server = this.servers.get(sessionId);
    if (!server) return;

    if (serverIds.length === 0) {
      this.unregisterServer(sessionId);
      return;
    }

    server.serverIds = serverIds;
    console.log(`[McplHookManager] Updated hook server ${server.delegateId} serverIds: ${serverIds.join(', ')}`);
  }

  /**
   * Unregister a server (on disconnect).
   */
  unregisterServer(sessionId: string): void {
    const server = this.servers.get(sessionId);
    if (server) {
      this.servers.delete(sessionId);
      console.log(`[McplHookManager] Unregistered hook server: ${server.delegateId}`);
    }
  }

  /**
   * Check if a serverId is allowed for a specific hook server.
   * Validates against registered serverIds using wildcard pattern matching.
   * Used at runtime to validate incoming push/inference messages.
   */
  isServerAllowed(sessionId: string, serverId: string): boolean {
    const server = this.servers.get(sessionId);
    if (!server) return false;

    return server.serverIds.some(pattern => matchesPattern(pattern, serverId));
  }

  // --------------------------------------------------------------------------
  // Before Inference
  // --------------------------------------------------------------------------

  /**
   * Set a custom rate limit for a specific delegate (overrides global config).
   */
  setDelegateRateLimit(delegateId: string, maxPerMinute: number): void {
    this.delegateRateLimits.set(delegateId, maxPerMinute);
    console.log(`[McplHookManager] Custom rate limit for delegate ${delegateId}: ${maxPerMinute}/min`);
  }

  /**
   * Call beforeInference on all registered hook servers for a user.
   * Returns aggregated injections sorted by serverId.
   *
   * hookDepth: sync loop prevention counter.
   *   - depth 0 = any top-level inference (user message OR push event).
   *   - depth increments only when a hook within an inference chain triggers another inference.
   *   - At MAX_HOOK_DEPTH, hooks are skipped entirely (never block inference).
   *
   * Timeout: server doesn't respond within timeoutMs → skip (never block inference).
   */
  async beforeInference(
    userId: string,
    conversationId: string,
    messagesSummary?: string,
    hookDepth = 0,
    context?: InferenceHookContext,
  ): Promise<BeforeInferenceResult> {
    const noAbort: BeforeInferenceResult = { injections: [], abort: false };

    // Sync loop prevention: stop at max depth
    if (hookDepth >= McplHookManager.MAX_HOOK_DEPTH) {
      console.warn(`[McplHookManager] Max hook depth (${McplHookManager.MAX_HOOK_DEPTH}) reached for ${conversationId}, skipping hooks`);
      return noAbort;
    }

    const servers = this.getServersForUser(userId);
    if (servers.length === 0) return noAbort;

    const hookContext = context ?? { conversationId, userId, isSubAgent: false };
    const allInjections: McplContextInjection[] = [];

    // Sort servers by delegateId for deterministic abort priority (first abort wins)
    const sortedServers = [...servers].sort((a, b) => a.delegateId.localeCompare(b.delegateId));

    // Parallel requests to all hook servers with timeout + per-server rate limit
    const results = await Promise.allSettled(
      sortedServers.map(server => this.requestBeforeInference(server, conversationId, messagesSummary, hookContext))
    );

    // Gap 3: track first abort (deterministic — sorted by delegateId)
    let abortResult: { abortReason?: string; abortServerId: string } | undefined;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allInjections.push(...result.value.injections);
        // First abort wins (servers sorted by delegateId)
        if (!abortResult && result.value.abort) {
          abortResult = {
            abortReason: result.value.abortReason,
            abortServerId: sortedServers[i].delegateId,
          };
        }
      } else {
        // Timeout/error → no abort (never block inference on failure)
        console.warn(`[McplHookManager] beforeInference failed for ${sortedServers[i].delegateId}:`, result.reason);
      }
    }

    // CRITICAL: sort by serverId for deterministic ordering
    allInjections.sort((a, b) => a.serverId.localeCompare(b.serverId));

    if (abortResult) {
      console.warn(`[McplHookManager] Inference abort requested by ${abortResult.abortServerId}: ${abortResult.abortReason ?? '(no reason)'}`);
    }

    return {
      injections: allInjections,
      abort: !!abortResult,
      abortReason: abortResult?.abortReason,
      abortServerId: abortResult?.abortServerId,
    };
  }

  /**
   * Request beforeInference from a single server.
   * Applies per-server rate limiting — if rate limited, skips (returns empty).
   */
  private requestBeforeInference(
    server: RegisteredHookServer,
    conversationId: string,
    messagesSummary?: string,
    context?: InferenceHookContext,
  ): Promise<ServerBeforeInferenceResult> {
    const empty: ServerBeforeInferenceResult = { injections: [] };

    if (!server.transport.isOpen) {
      return Promise.resolve(empty);
    }

    // Per-server rate limit check (async loop prevention)
    if (!this.checkRateLimit(server.delegateId)) {
      console.warn(`[McplHookManager] Rate limited: ${server.delegateId} exceeded ${this.getDelegateRateLimit(server.delegateId)}/min`);
      return Promise.resolve(empty);
    }

    const requestId = randomUUID();

    return new Promise<ServerBeforeInferenceResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.warn(`[McplHookManager] beforeInference timed out for ${server.delegateId} (${this.config.beforeInferenceTimeoutMs}ms)`);
        resolve(empty); // Skip on timeout — never block inference
      }, this.config.beforeInferenceTimeoutMs);

      this.pendingRequests.set(requestId, { requestId, resolve, timeout });

      try {
        server.transport.send({
          type: 'mcpl/beforeInference',
          requestId,
          conversationId,
          messagesSummary,
          context,
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        console.warn(`[McplHookManager] Failed to send beforeInference to ${server.delegateId}:`, err);
        resolve(empty);
      }
    });
  }

  /**
   * Handle a beforeInference response from a delegate.
   */
  handleBeforeInferenceResponse(
    requestId: string,
    injections: McplContextInjection[],
    abort?: boolean,
    abortReason?: string,
  ): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve({ injections, abort, abortReason });
  }

  // --------------------------------------------------------------------------
  // After Inference
  // --------------------------------------------------------------------------

  /** Pending afterInference requests keyed by requestId */
  private pendingAfterRequests: Map<string, {
    resolve: (modifiedResponse?: string) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  /**
   * Notify all registered hook servers after inference completes.
   * Blocking with timeout — waits for responses that may contain modifiedResponse.
   * If any server returns modifiedResponse, the FIRST one wins (sorted by serverId for determinism).
   * Timeout → skip that server (never block response delivery).
   */
  async afterInference(
    userId: string,
    conversationId: string,
    responseSummary?: string,
    context?: InferenceHookContext,
  ): Promise<string | undefined> {
    const servers = this.getServersForUser(userId);
    if (servers.length === 0) return undefined;

    // Sort by delegateId for deterministic ordering (first modifiedResponse wins)
    const sorted = [...servers].sort((a, b) => a.delegateId.localeCompare(b.delegateId));

    const results = await Promise.allSettled(
      sorted.map(server => this.requestAfterInference(server, conversationId, responseSummary, context))
    );

    // Return first modifiedResponse found (deterministic order due to sort)
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== undefined) {
        return result.value;
      }
    }
    return undefined;
  }

  /**
   * Request afterInference from a single server with timeout.
   * Returns modifiedResponse if server provides one, undefined otherwise.
   */
  private requestAfterInference(
    server: RegisteredHookServer,
    conversationId: string,
    responseSummary?: string,
    context?: InferenceHookContext,
  ): Promise<string | undefined> {
    if (!server.transport.isOpen) {
      return Promise.resolve(undefined);
    }

    const requestId = randomUUID();

    return new Promise<string | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingAfterRequests.delete(requestId);
        console.warn(`[McplHookManager] afterInference timed out for ${server.delegateId} (${this.config.afterInferenceTimeoutMs}ms)`);
        resolve(undefined); // Skip on timeout — never block response delivery
      }, this.config.afterInferenceTimeoutMs);

      this.pendingAfterRequests.set(requestId, { resolve, timeout });

      try {
        server.transport.send({
          type: 'mcpl/afterInference',
          requestId,
          conversationId,
          responseSummary,
          context: context ?? { conversationId, userId: server.userId, isSubAgent: false },
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingAfterRequests.delete(requestId);
        console.warn(`[McplHookManager] Failed to send afterInference to ${server.delegateId}:`, err);
        resolve(undefined);
      }
    });
  }

  /**
   * Handle an afterInference response from a delegate.
   * Replaces the old mcpl/afterInference_ack handler — now supports modifiedResponse.
   */
  handleAfterInferenceResponse(requestId: string, modifiedResponse?: string): void {
    const pending = this.pendingAfterRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingAfterRequests.delete(requestId);
    pending.resolve(modifiedResponse);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getServersForUser(userId: string): RegisteredHookServer[] {
    const result: RegisteredHookServer[] = [];
    for (const server of this.servers.values()) {
      if (server.userId === userId) {
        result.push(server);
      }
    }
    return result;
  }

  getStats(): { registeredServers: number; pendingRequests: number; pendingAfterRequests: number } {
    return {
      registeredServers: this.servers.size,
      pendingRequests: this.pendingRequests.size,
      pendingAfterRequests: this.pendingAfterRequests.size,
    };
  }

  // --------------------------------------------------------------------------
  // Rate Limiting (async loop prevention)
  // --------------------------------------------------------------------------

  /**
   * Get the effective rate limit for a delegate (custom or global default).
   */
  private getDelegateRateLimit(delegateId: string): number {
    return this.delegateRateLimits.get(delegateId) ?? this.config.maxCallsPerMinutePerDelegate;
  }

  /**
   * Check and record a call for rate limiting (keyed by delegateId).
   * Returns true if the call is allowed, false if rate limited.
   */
  private checkRateLimit(delegateId: string): boolean {
    const limit = this.getDelegateRateLimit(delegateId);
    const now = Date.now();

    const timestamps = this.delegateCallTimestamps.get(delegateId) || [];
    // Keep only timestamps within the last 60 seconds
    const recent = timestamps.filter(t => now - t < 60_000);

    if (recent.length >= limit) {
      return false;
    }

    recent.push(now);
    this.delegateCallTimestamps.set(delegateId, recent);
    return true;
  }

  /**
   * Clean up per-delegate rate-limiting state on disconnect.
   * Prevents unbounded Map growth from disconnected delegates.
   */
  cleanupDelegate(delegateId: string): void {
    this.delegateCallTimestamps.delete(delegateId);
    this.delegateRateLimits.delete(delegateId);
  }
}

export const mcplHookManager = new McplHookManager();
