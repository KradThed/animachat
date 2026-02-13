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
  maxCallsPerMinutePerServer: number;        // default 10 — global rate limit per server
}

interface RegisteredHookServer {
  sessionId: string;
  delegateId: string;
  userId: string;
  transport: McplTransport;
  serverIds: string[];         // which serverIds support context_hooks (may contain wildcards)
}

interface PendingHookRequest {
  requestId: string;
  resolve: (injections: McplContextInjection[]) => void;
  timeout: ReturnType<typeof setTimeout>;
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

  /** Per-server call timestamps for rate limiting (async loop prevention) */
  private serverCallTimestamps: Map<string, number[]> = new Map();

  /** Per-server custom rate limits (overrides config.maxCallsPerMinutePerServer) */
  private serverRateLimits: Map<string, number> = new Map();

  constructor(config?: Partial<McplHookManagerConfig>) {
    this.config = {
      beforeInferenceTimeoutMs: 5000,
      afterInferenceTimeoutMs: 10000,
      maxCallsPerMinutePerServer: 10,
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
   * Set a custom rate limit for a specific server (overrides global config).
   */
  setServerRateLimit(serverId: string, maxPerMinute: number): void {
    this.serverRateLimits.set(serverId, maxPerMinute);
    console.log(`[McplHookManager] Custom rate limit for ${serverId}: ${maxPerMinute}/min`);
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
    hookDepth = 0
  ): Promise<McplContextInjection[]> {
    // Sync loop prevention: stop at max depth
    if (hookDepth >= McplHookManager.MAX_HOOK_DEPTH) {
      console.warn(`[McplHookManager] Max hook depth (${McplHookManager.MAX_HOOK_DEPTH}) reached for ${conversationId}, skipping hooks`);
      return [];
    }

    const servers = this.getServersForUser(userId);
    if (servers.length === 0) return [];

    const allInjections: McplContextInjection[] = [];

    // Parallel requests to all hook servers with timeout + per-server rate limit
    const results = await Promise.allSettled(
      servers.map(server => this.requestBeforeInference(server, conversationId, messagesSummary))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allInjections.push(...result.value);
      } else {
        console.warn(`[McplHookManager] beforeInference failed for ${servers[i].delegateId}:`, result.reason);
      }
    }

    // CRITICAL: sort by serverId for deterministic ordering
    allInjections.sort((a, b) => a.serverId.localeCompare(b.serverId));

    return allInjections;
  }

  /**
   * Request beforeInference from a single server.
   * Applies per-server rate limiting — if rate limited, skips (returns empty).
   */
  private requestBeforeInference(
    server: RegisteredHookServer,
    conversationId: string,
    messagesSummary?: string
  ): Promise<McplContextInjection[]> {
    if (!server.transport.isOpen) {
      return Promise.resolve([]);
    }

    // Per-server rate limit check (async loop prevention)
    if (!this.checkRateLimit(server.delegateId)) {
      console.warn(`[McplHookManager] Rate limited: ${server.delegateId} exceeded ${this.getServerRateLimit(server.delegateId)}/min`);
      return Promise.resolve([]);
    }

    const requestId = randomUUID();

    return new Promise<McplContextInjection[]>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.warn(`[McplHookManager] beforeInference timed out for ${server.delegateId} (${this.config.beforeInferenceTimeoutMs}ms)`);
        resolve([]); // Skip on timeout — never block inference
      }, this.config.beforeInferenceTimeoutMs);

      this.pendingRequests.set(requestId, { requestId, resolve, timeout });

      try {
        server.transport.send({
          type: 'mcpl/beforeInference',
          requestId,
          conversationId,
          messagesSummary,
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        console.warn(`[McplHookManager] Failed to send beforeInference to ${server.delegateId}:`, err);
        resolve([]);
      }
    });
  }

  /**
   * Handle a beforeInference response from a delegate.
   */
  handleBeforeInferenceResponse(requestId: string, injections: McplContextInjection[]): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(injections);
  }

  // --------------------------------------------------------------------------
  // After Inference
  // --------------------------------------------------------------------------

  /**
   * Notify all registered hook servers after inference completes.
   * Fire-and-forget for MVP — we don't wait for responses.
   */
  async afterInference(
    userId: string,
    conversationId: string,
    responseSummary?: string
  ): Promise<void> {
    const servers = this.getServersForUser(userId);
    if (servers.length === 0) return;

    const requestId = randomUUID();

    for (const server of servers) {
      if (!server.transport.isOpen) continue;

      try {
        server.transport.send({
          type: 'mcpl/afterInference',
          requestId,
          conversationId,
          responseSummary,
        });
      } catch (err) {
        console.warn(`[McplHookManager] Failed to send afterInference to ${server.delegateId}:`, err);
      }
    }
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

  getStats(): { registeredServers: number; pendingRequests: number } {
    return {
      registeredServers: this.servers.size,
      pendingRequests: this.pendingRequests.size,
    };
  }

  // --------------------------------------------------------------------------
  // Rate Limiting (async loop prevention)
  // --------------------------------------------------------------------------

  /**
   * Get the effective rate limit for a server (custom or global default).
   */
  private getServerRateLimit(serverId: string): number {
    return this.serverRateLimits.get(serverId) ?? this.config.maxCallsPerMinutePerServer;
  }

  /**
   * Check and record a call for rate limiting.
   * Returns true if the call is allowed, false if rate limited.
   */
  private checkRateLimit(serverId: string): boolean {
    const limit = this.getServerRateLimit(serverId);
    const now = Date.now();

    const timestamps = this.serverCallTimestamps.get(serverId) || [];
    // Keep only timestamps within the last 60 seconds
    const recent = timestamps.filter(t => now - t < 60_000);

    if (recent.length >= limit) {
      return false;
    }

    recent.push(now);
    this.serverCallTimestamps.set(serverId, recent);
    return true;
  }
}

export const mcplHookManager = new McplHookManager();
