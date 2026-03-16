// Vendored from @deprecated-claude/backend
// Original location: node_modules/@deprecated-claude/backend/src/delegate/delegate-handler.ts
// Modified: Phase 3 — strict delegateId validation, normalization, prefixed ack, reconnect race guard
// Modified: Phase 3.5 — single message path (Variant A), ReliableChannel, session resume

/**
 * Delegate WebSocket Handler
 *
 * Handles WebSocket connections from delegate apps.
 * Delegates connect with:
 *   ?token=JWT&delegateId=xxx (JWT auth - for testing/legacy)
 *   ?apiKey=dak_xxx&delegateId=xxx (API Key auth - recommended)
 *
 * Message flow (single message path — Variant A):
 *   Pre-MCPL:  WebSocketTransport auto-listens → handleDelegateMessage()
 *   Post-MCPL: ReliableChannel wraps transport → unwraps frames → handleDelegateMessage()
 *   The RC constructor calls transport.onMessage(), replacing the initial handler.
 */

import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { verifyToken } from '../middleware/auth.js';
import { Database } from '../database/index.js';
import { delegateManager } from './delegate-manager.js';
import { toolRegistry } from '../tools/tool-registry.js';
import { triggerHandler } from './trigger-handler.js';
import type {
  ToolManifestMessage,
  ToolCallResponseMessage,
  TriggerInferenceMessage,
} from './protocol.js';
import { mcplSessionManager, McplSessionManager } from './mcpl-session-manager.js';
import { mcplHookManager } from '../services/mcpl-hook-manager.js';
import { mcplEventQueue } from '../services/mcpl-event-queue.js';
import { mcplInferenceBroker } from '../services/mcpl-inference-broker.js';
import { mcplStateManager } from '../services/mcpl-state-manager.js';
import { roomManager } from '../websocket/room-manager.js';
import { WebSocketTransport, ReliableChannel } from './mcpl-transport.js';
import type { McplTransport } from './mcpl-transport.js';
import { McplCodec } from './mcpl-codec.js';
import type { ScopeChangeStatus, McplFeatureSet, DeclaredFeatureSet, McplCapability, McplScopePolicy, McplHandshakeCapabilities, McplCapabilities } from '@deprecated-claude/shared';
import { resolveCapabilities, validateDeclarationUses } from '@deprecated-claude/shared';
import { ConversationAccessCache } from '../mcpl/conversation-access.js';
import { serverRegistry } from '../mcpl/server-registry.js';
import { mcplRateLimiter, messageTypeToOpType } from '../middleware/rate-limiter.js';

// =============================================================================
// Conversation Access Cache (Fix #4 — CRITICAL)
// =============================================================================

// Per-connection instance created in handleDelegateConnection().
// Singleton would leak across users — each connection gets its own cache.
const conversationAccessCaches = new Map<string, ConversationAccessCache>();

/**
 * Extract conversationId from any MCPL message payload.
 * Returns empty string if not present (e.g., scope_change_request with no conversationId).
 */
function extractConversationId(msg: Record<string, unknown>): string {
  return (msg.conversationId as string) || '';
}

/**
 * Send mcpl/error to delegate via transport.
 * conversationId is never included in the error message (masked).
 */
/**
 * MCPL error codes per JSON-RPC spec.
 * Custom codes in -32000..-32099 range (JSON-RPC implementation-defined).
 */
const MCPL_ERROR_CODES = {
  CAPABILITY_DISABLED:    -32001,  // feature set capability is false
  RATE_LIMITED:           -32002,  // rate limit exceeded
  UNKNOWN_SERVER:         -32003,  // serverId not in featureSets
  ACCESS_DENIED:          -32004,  // conversation access denied
  CHECKPOINT_NOT_FOUND:   -32005,  // state checkpoint not found
  NO_SESSION:             -32006,  // no MCPL session for this delegate
  // Spec Appendix A — channel error codes (Section 14.6):
  CHANNEL_NOT_PERMITTED:  -32017,  // lacking scope to publish or observe channel
  UNKNOWN_CHANNEL:        -32023,  // channel id doesn't exist or not registered
  CHANNEL_OPEN_FAILED:    -32024,  // server could not open/connect the requested channel
} as const;

function sendMcplError(
  transport: McplTransport,
  code: number,
  message: string,
  inReplyTo: { type: string; requestId?: string; seq?: number },
  retryAfterMs?: number,
  data?: Record<string, unknown>,
): void {
  const errorMsg: Record<string, unknown> = {
    type: 'mcpl/error',
    code,
    message,
    inReplyTo,
  };
  if (retryAfterMs !== undefined) {
    errorMsg.retryAfterMs = retryAfterMs;
  }
  if (data !== undefined) {
    errorMsg.data = data;
  }
  transport.send(errorMsg);
}

// =============================================================================
// DelegateId Validation
// =============================================================================

const DELEGATE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const DELEGATE_ID_MAX_LENGTH = 32;
const RESERVED_DELEGATE_NAMES = new Set(['server', 'system', 'internal', 'admin']);

function validateDelegateId(raw: string | null): { valid: false; reason: string } | { valid: true; delegateId: string } {
  if (!raw || !raw.trim()) {
    return { valid: false, reason: 'Missing delegateId' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > DELEGATE_ID_MAX_LENGTH) {
    return { valid: false, reason: `delegateId too long (max ${DELEGATE_ID_MAX_LENGTH} chars)` };
  }
  if (!DELEGATE_ID_REGEX.test(trimmed)) {
    return { valid: false, reason: 'delegateId contains invalid characters (allowed: a-z, A-Z, 0-9, _, -)' };
  }
  if (trimmed.includes('__')) {
    return { valid: false, reason: 'delegateId must not contain "__" (reserved as namespace separator)' };
  }
  if (RESERVED_DELEGATE_NAMES.has(trimmed.toLowerCase())) {
    return { valid: false, reason: `delegateId "${trimmed}" is reserved` };
  }
  return { valid: true, delegateId: trimmed };
}

// =============================================================================
// Pending Scope Changes (Phase 6d)
// =============================================================================

interface PendingScopeChange {
  delegateId: string;
  userId: string;
  serverId: string;
  conversationId: string;
  url: string;
  serverName: string;
  requestedCapabilities: string[];
  timestamp: number;
}

// Not persisted — server restart clears all pending requests.
// Delegates expecting ack should implement retry logic.
const pendingScopeChanges = new Map<string, PendingScopeChange>();

// C-1 fix: Guard against concurrent mcpl/hello for the same delegate.
// Prevents race where two hellos create duplicate sessions.
const pendingHandshakes = new Set<string>();

/**
 * Resolve a pending scope change request.
 * Called from handler.ts when user approves/denies via UI.
 */
export function resolveScopeChange(
  requestId: string,
  approved: boolean,
  db?: Database,
  newCapabilities?: string[],
  overrideStatus?: ScopeChangeStatus,
): void {
  const pending = pendingScopeChanges.get(requestId);
  if (!pending) return;
  pendingScopeChanges.delete(requestId);

  // Send result to originating delegate only
  const delegate = delegateManager.findDelegate(pending.userId, pending.delegateId);
  if (delegate) {
    const resultMsg: Record<string, unknown> = {
      type: 'mcpl/scope_change_result',
      requestId,
      approved,
      scoped: true,  // F12: per spec
    };
    if (approved && newCapabilities) {
      resultMsg.newCapabilities = newCapabilities;
    }

    const transport = (delegate.ws as DelegateWebSocket).mcplTransport;
    if (transport) {
      transport.send(resultMsg);
    } else {
      delegate.ws.send(JSON.stringify(resultMsg));
    }
  }

  if (!approved) {
    // Denied — persist immediately (final state)
    const status = overrideStatus ?? 'denied_by_user';
    db?.appendMcplUserEvent(pending.userId, 'scope_change_resolved', {
      requestId,
      delegateId: pending.delegateId,
      serverId: pending.serverId,
      status,
    } as Record<string, unknown>).catch(err =>
      console.warn('[DelegateHandler] Failed to persist scope_change_resolved:', err)
    );
  }
  // Approved — do NOT persist yet. Wait for mcpl/connect_server_result from delegate.
}

// =============================================================================
// Pending Scope Elevations (Phase 7 — Batch 4)
// =============================================================================

interface PendingScopeElevate {
  requestId: string;          // latest requestId (may be replaced on dedup)
  delegateId: string;
  serverId: string;
  conversationId: string;
  featureSet: string;
  label: string;
  requestedUses: string[];
  reason: string;
  userId: string;
  timeout: ReturnType<typeof setTimeout>;
  payload?: Record<string, unknown>;  // spec: echo back in result
}

// Not persisted — server restart clears all pending requests.
// Delegates expecting ack should implement retry logic.
const pendingScopeElevations = new Map<string, PendingScopeElevate>();

function makeScopeElevateDedupKey(delegateId: string, featureSet: string, label: string): string {
  return `${delegateId}::${featureSet}::${label}`;
}

/** In-memory scope policies keyed by userId::delegateId */
const scopePolicies = new Map<string, McplScopePolicy>();

export function getScopePolicy(userId: string, delegateId: string): McplScopePolicy | undefined {
  return scopePolicies.get(`${userId}::${delegateId}`);
}

export function setScopePolicy(userId: string, delegateId: string, policy: McplScopePolicy): void {
  scopePolicies.set(`${userId}::${delegateId}`, policy);
}

/** Get all scope policies for a user (optionally filtered by delegateId) */
export function getScopePoliciesForUser(userId: string, delegateId?: string): Array<{ delegateId: string; policy: McplScopePolicy }> {
  const result: Array<{ delegateId: string; policy: McplScopePolicy }> = [];
  for (const [key, policy] of scopePolicies) {
    const [uid, did] = key.split('::');
    if (uid === userId && (!delegateId || did === delegateId)) {
      result.push({ delegateId: did, policy });
    }
  }
  return result;
}

/**
 * Build scopes object for featureSets/update (spec Section 5.3, 7.2).
 * Groups whitelist/blacklist labels by featureSet from scope policies.
 */
function buildScopesForDelegate(
  userId: string,
  delegateId: string,
): Record<string, { whitelist: string[]; blacklist: string[] }> | undefined {
  const policy = getScopePolicy(userId, delegateId);
  if (!policy) return undefined;

  const scopes: Record<string, { whitelist: string[]; blacklist: string[] }> = {};

  for (const rule of policy.whitelist) {
    if (!rule.label) continue;
    if (!scopes[rule.featureSet]) scopes[rule.featureSet] = { whitelist: [], blacklist: [] };
    scopes[rule.featureSet].whitelist.push(rule.label);
  }

  for (const rule of policy.blacklist) {
    if (!rule.label) continue;
    if (!scopes[rule.featureSet]) scopes[rule.featureSet] = { whitelist: [], blacklist: [] };
    scopes[rule.featureSet].blacklist.push(rule.label);
  }

  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

/**
 * Unified scope elevation decision handler.
 * Used by both manual (UI dialog) and auto (policy) paths to ensure
 * session state, scope_elevate_result, and featureSets_update are all sent consistently.
 *
 * IMPORTANT: Entry points must call getScopeElevateTargetError() and getScopeElevateUsesError()
 * BEFORE calling this function. This function trusts that validation has already passed.
 *
 * Deny path: sends only scope_elevate_result (no featureSets_update, no broadcast).
 *   If sendScopes=true: additionally sends scopes-only featureSets_update (for remembered deny).
 * Approve path: sends scope_elevate_result + featureSets_update + broadcast.
 */
function completeScopeDecision(opts: {
  approved: boolean;
  userId: string;
  delegateId: string;
  featureSet: string;
  requestedUses: string[];
  requestId: string;
  payload: unknown;
  reason?: string;
  sendScopes?: boolean;
  transport?: McplTransport;
  ws?: WebSocket;
}) {
  const send = (msg: Record<string, unknown>) => {
    if (opts.transport) {
      opts.transport.send(msg);
    } else if (opts.ws) {
      opts.ws.send(JSON.stringify(msg));
    }
  };

  if (opts.approved) {
    // --- Approve path ---
    // Assert: session must exist (entry points validated via getScopeElevateTargetError)
    const session = mcplSessionManager.getSessionForDelegate(opts.userId, opts.delegateId);
    if (!session) return; // defensive — should never happen after entry-point validation

    // 1. Update session state
    mcplSessionManager.addUsesToFeatureSet(
      opts.userId, opts.delegateId, opts.featureSet, opts.requestedUses
    );

    // 2. Safety net: re-validate after add (should be no-op — pre-validation catches bad uses)
    const decl = session.declaredFeatureSets[opts.featureSet];
    if (decl) {
      applyUsesValidation(session.sessionId, { [opts.featureSet]: decl }, opts.delegateId);
    }

    // 3. scope_elevate_result
    send({
      type: 'mcpl/scope_elevate_result',
      requestId: opts.requestId,
      approved: true,
      payload: opts.payload,
      scoped: true,
      newUses: opts.requestedUses,
    });

    // 4. featureSets_update — effective state after addUses + validation
    const effectivelyEnabled = mcplSessionManager.isFeatureSetEffectivelyEnabled(session.sessionId, opts.featureSet);
    const scopes = buildScopesForDelegate(opts.userId, opts.delegateId);
    send({
      type: 'mcpl/featureSets_update',
      enabled: effectivelyEnabled ? [opts.featureSet] : [],
      disabled: effectivelyEnabled ? [] : [opts.featureSet],
      ...(scopes ? { scopes } : {}),
    });

    // 5. Broadcast runtime change to frontend
    roomManager.broadcastToUser(opts.userId, {
      type: 'mcpl/feature_sets_runtime_changed',
      delegateId: opts.delegateId,
      addedFeatureSets: [],
      removedFeatureSets: [],
      enabledFeatureSets: mcplSessionManager.getEffectiveEnabledNames(session.sessionId),
      timestamp: Date.now(),
    });
  } else {
    // --- Deny path ---
    // Send only scope_elevate_result. NO featureSets_update with enabled/disabled, NO broadcast.
    // The feature set's runtime state has NOT changed.
    send({
      type: 'mcpl/scope_elevate_result',
      requestId: opts.requestId,
      approved: false,
      payload: opts.payload,
      scoped: true,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });

    // If remembered deny → send scopes-only featureSets_update (delegate needs to know the new rule)
    if (opts.sendScopes) {
      const scopes = buildScopesForDelegate(opts.userId, opts.delegateId);
      if (scopes) {
        send({
          type: 'mcpl/featureSets_update',
          scopes,
        });
      }
    }
  }
}

/** Remove matching policy rules for a user */
export function revokeScopePolicyRule(
  userId: string,
  delegateId: string,
  featureSet: string,
  label?: string
): boolean {
  const policy = getScopePolicy(userId, delegateId);
  if (!policy) return false;

  const filterFn = (rule: { featureSet: string; label?: string }) =>
    !(rule.featureSet === featureSet && (!label || rule.label === label));

  const origLen = policy.whitelist.length + policy.blacklist.length;
  policy.whitelist = policy.whitelist.filter(filterFn);
  policy.blacklist = policy.blacklist.filter(filterFn);
  const newLen = policy.whitelist.length + policy.blacklist.length;

  return newLen < origLen;
}

/** S-3 fix: Default TTL for remembered policy rules (30 days in ms). */
const SCOPE_POLICY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Match feature-set policy patterns. Wildcards only in policy layer. */
function matchesFeatureSetRule(pattern: string, featureSet: string): boolean {
  if (pattern.endsWith('.*')) {
    return featureSet.startsWith(pattern.slice(0, -1));
  }
  return pattern === featureSet;
}

/**
 * Validate declared feature sets and quarantine unsupported ones.
 * Policy:
 *   - Hard quarantine: ANY unsupported use string → quarantined (not effective)
 *   - Auto-recovery: all uses supported → remove from quarantine
 *   - Soft warn: missing description
 */
function applyUsesValidation(
  sessionId: string,
  declared: Record<string, McplFeatureSet | DeclaredFeatureSet>,
  delegateId: string
): void {
  for (const [name, fs] of Object.entries(declared)) {
    const uses = 'rawUses' in fs ? fs.rawUses : fs.uses;
    const { unsupported } = validateDeclarationUses(uses);
    if (unsupported.length > 0) {
      console.warn(
        `[DelegateHandler] Quarantining feature set "${name}" from "${delegateId}": ` +
        `unsupported uses: ${unsupported.join(', ')}`
      );
      mcplSessionManager.quarantineFeatureSet(sessionId, name);
    } else {
      // Valid declaration → remove from quarantine (auto-recovery)
      mcplSessionManager.unquarantineFeatureSet(sessionId, name);
    }
    if (!fs.description) {
      console.warn(
        `[DelegateHandler] Feature set "${name}" from "${delegateId}" has no description`
      );
    }
  }
}

/**
 * Pre-validate scope elevation target: session must exist, featureSet must be declared.
 * Returns null if valid, or a deny reason string.
 */
function getScopeElevateTargetError(
  userId: string,
  delegateId: string,
  featureSet: string
): string | null {
  const session = mcplSessionManager.getSessionForDelegate(userId, delegateId);
  if (!session) return 'No active session';
  if (!(featureSet in session.declaredFeatureSets)) {
    return `Unknown feature set: ${featureSet}`;
  }
  return null;
}

/**
 * Pre-validate requestedUses for scope elevation.
 * Returns null if valid, or a deny reason string.
 */
function getScopeElevateUsesError(requestedUses: string[]): string | null {
  const { unsupported } = validateDeclarationUses(requestedUses);
  if (unsupported.length > 0) {
    return `Unsupported uses: ${unsupported.join(', ')}`;
  }
  return null;
}

/**
 * Evaluate scope policy for a request.
 * Blacklist checked first (deny takes priority over whitelist).
 * Blacklist uses some() — ANY matching use → deny.
 * Whitelist uses every() — ALL requested must be covered → approve.
 *
 * S-1 fix: Wildcard rules only auto-approve feature sets that existed when approved.
 * S-3 fix: Rules older than SCOPE_POLICY_TTL_MS are treated as expired.
 */
function evaluateScopePolicy(
  userId: string,
  delegateId: string,
  featureSet: string,
  label: string,
  requestedUses: string[]
): 'approve' | 'deny' | 'ask_user' {
  const policy = getScopePolicy(userId, delegateId);
  if (!policy) return 'ask_user';

  const now = Date.now();

  // Blacklist checked first (deny takes priority)
  for (const rule of policy.blacklist) {
    // S-3: skip expired rules (default createdAt=0 so legacy rules expire immediately)
    if ((now - (rule.createdAt ?? 0)) > SCOPE_POLICY_TTL_MS) continue;

    if (matchesFeatureSetRule(rule.featureSet, featureSet)
        && rule.uses.some(u => requestedUses.includes(u))
        && (!rule.label || rule.label === label)) {
      return 'deny';
    }
  }

  // Whitelist
  for (const rule of policy.whitelist) {
    // S-3: skip expired rules (default createdAt=0 so legacy rules expire immediately)
    if ((now - (rule.createdAt ?? 0)) > SCOPE_POLICY_TTL_MS) continue;

    if (matchesFeatureSetRule(rule.featureSet, featureSet)
        && requestedUses.every(u => rule.uses.includes(u))
        && (!rule.label || rule.label === label)) {
      // S-1: For wildcard rules, only auto-approve known feature sets
      if (rule.featureSet.endsWith('.*') && rule.approvedFeatureSetNames) {
        if (!rule.approvedFeatureSetNames.includes(featureSet)) {
          // New feature set under wildcard — require re-approval
          continue;
        }
      }
      return 'approve';
    }
  }

  return 'ask_user';
}

/**
 * Resolve a pending scope elevate request.
 * Called from handler.ts when user approves/denies via UI.
 */
export function resolveScopeElevate(
  requestId: string,
  approved: boolean,
  remember?: boolean,
  db?: Database
): void {
  // Find the pending elevation by requestId (may be in any dedup entry)
  let foundKey: string | undefined;
  let pending: PendingScopeElevate | undefined;

  for (const [key, entry] of pendingScopeElevations) {
    if (entry.requestId === requestId) {
      foundKey = key;
      pending = entry;
      break;
    }
  }

  if (!foundKey || !pending) return;

  clearTimeout(pending.timeout);
  pendingScopeElevations.delete(foundKey);

  // Send result to delegate via unified helper
  const delegate = delegateManager.findDelegate(pending.userId, pending.delegateId);
  if (!delegate) return;

  // --- Preflight checks BEFORE completeScopeDecision ---

  // 1. Target validation: session must exist, featureSet must be declared
  const targetError = getScopeElevateTargetError(pending.userId, pending.delegateId, pending.featureSet);
  if (targetError) {
    const transport = (delegate.ws as DelegateWebSocket).mcplTransport;
    const response = {
      type: 'mcpl/scope_elevate_result',
      requestId: pending.requestId,
      approved: false,
      reason: targetError,
      scoped: true,
    };
    if (transport) transport.send(response); else delegate.ws.send(JSON.stringify(response));
    return;
  }

  // 2. Uses validation: host-supported only (override user approval if unsupported)
  let finalApproved = approved;
  let finalReason = !approved ? 'Denied by user' : undefined;

  if (approved) {
    const usesError = getScopeElevateUsesError(pending.requestedUses);
    if (usesError) {
      finalApproved = false;
      finalReason = usesError;
    }
  }

  const isHostLimitationDeny = approved && !finalApproved; // user approved but host overrode
  const shouldPersistPolicy = remember && !isHostLimitationDeny;

  // --- Persist policy BEFORE completeScopeDecision so buildScopesForDelegate sees new rules ---
  if (shouldPersistPolicy) {
    const policy = getScopePolicy(pending.userId, pending.delegateId) || { whitelist: [], blacklist: [] };

    // S-1 fix: For wildcard rules, record which feature set names were known at approval time.
    // New feature sets matching the wildcard will require re-approval.
    let approvedFeatureSetNames: string[] | undefined;
    if (pending.featureSet.endsWith('.*')) {
      const session = mcplSessionManager.getSessionForDelegate(pending.userId, pending.delegateId);
      if (session) {
        const prefix = pending.featureSet.slice(0, -1); // "memory.*" → "memory."
        approvedFeatureSetNames = Object.keys(session.declaredFeatureSets).filter(id => id.startsWith(prefix));
      }
    }

    const rule = {
      featureSet: pending.featureSet,
      uses: pending.requestedUses,
      label: pending.label,
      approvedFeatureSetNames,    // S-1: track known feature sets for wildcards
      createdAt: Date.now(),      // S-3: timestamp for TTL expiry
    };

    if (finalApproved) {
      policy.whitelist.push(rule);
    } else {
      policy.blacklist.push(rule);
    }
    setScopePolicy(pending.userId, pending.delegateId, policy);

    // Persist to event store (include _userId for replay — callback gets only event.data)
    db?.appendMcplUserEvent(pending.userId, 'scope_policy_updated', {
      _userId: pending.userId,
      delegateId: pending.delegateId,
      policy,
    } as Record<string, unknown>).catch(err =>
      console.warn('[DelegateHandler] Failed to persist scope_policy_updated:', err)
    );
  }

  // --- Execute decision ---
  completeScopeDecision({
    approved: finalApproved,
    userId: pending.userId,
    delegateId: pending.delegateId,
    featureSet: pending.featureSet,
    requestedUses: pending.requestedUses,
    requestId: pending.requestId,
    payload: pending.payload,
    reason: finalReason,
    sendScopes: shouldPersistPolicy,
    transport: (delegate.ws as DelegateWebSocket).mcplTransport,
    ws: delegate.ws,
  });
}

// =============================================================================
// WebSocket Handler
// =============================================================================

interface DelegateWebSocket extends WebSocket {
  userId?: string;
  delegateId?: string;
  sessionId?: string;
  isAlive?: boolean;
  isMcpl?: boolean;              // true if delegate connected via mcpl/hello
  mcplSessionId?: string;        // MCPL session ID (survives reconnects)
  mcplTransport?: McplTransport; // McplCodec wrapping ReliableChannel after mcpl/hello
  mcplReliable?: ReliableChannel; // Direct RC ref for getState() on disconnect
  mcplCodecRef?: McplCodec;      // Direct codec ref for pendingRequests save/restore
}

export async function delegateWebsocketHandler(
  ws: DelegateWebSocket,
  req: IncomingMessage,
  db: Database
): Promise<void> {
  // Parse query parameters (only non-sensitive routing params in URL)
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Strict delegateId validation (delegateId is in URL — non-sensitive identifier)
  const delegateIdResult = validateDelegateId(url.searchParams.get('delegateId'));
  if (!delegateIdResult.valid) {
    console.warn(`[DelegateHandler] Invalid delegateId: ${delegateIdResult.reason}`);
    ws.close(1008, delegateIdResult.reason);
    return;
  }
  let delegateId = delegateIdResult.delegateId;  // trimmed, validated; may be overridden by DB namespace

  // Support both first-message auth (new) and URL params (legacy backward compat)
  let token = url.searchParams.get('token');
  let apiKey = url.searchParams.get('apiKey');

  if (!token && !apiKey) {
    // New flow: wait for first message with auth credentials
    try {
      const authMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const authTimeout = setTimeout(() => {
          ws.close(1008, 'Authentication timeout');
          reject(new Error('Authentication timeout'));
        }, 5000);

        ws.once('message', (data) => {
          clearTimeout(authTimeout);
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type !== 'delegate_auth') {
              ws.close(1008, 'First message must be delegate_auth');
              reject(new Error('Invalid auth message'));
              return;
            }
            resolve(msg);
          } catch {
            ws.close(1008, 'Invalid auth message');
            reject(new Error('Invalid auth message'));
          }
        });
      });

      token = (authMsg.token as string) || null;
      apiKey = (authMsg.apiKey as string) || null;
    } catch {
      // Connection already closed by timeout/error handler above
      return;
    }
  }

  if (!token && !apiKey) {
    console.warn('[DelegateHandler] Missing token or apiKey');
    ws.close(1008, 'Missing authentication (token or apiKey required)');
    return;
  }

  let userId: string;

  // Try API Key auth first (preferred)
  // Uses validateDelegateApiKeyWithDelegate which checks both new delegate entity keys
  // and legacy delegateApiKeys for backward compat.
  if (apiKey) {
    const keyResult = await db.validateDelegateApiKeyWithDelegate(apiKey);
    if (!keyResult) {
      console.warn('[DelegateHandler] Invalid API key');
      ws.close(1008, 'Invalid API key (expired, revoked, or invalid)');
      return;
    }
    userId = keyResult.userId;

    // Namespace from DB is source of truth; fallback to CLI-sent delegateId for legacy keys
    const resolvedNamespace = keyResult.delegate?.namespace ?? delegateId;
    if (keyResult.delegate && delegateId !== resolvedNamespace) {
      console.warn(`[DelegateHandler] Namespace mismatch: CLI sent "${delegateId}", DB has "${resolvedNamespace}"`);
    }
    delegateId = resolvedNamespace;

    // Update lastSeenAt
    if (keyResult.delegate) {
      db.updateDelegateLastSeen(keyResult.delegate.id);
    }

    console.log(`[DelegateHandler] Delegate "${delegateId}" authenticated via API key (user: ${userId})`);
  } else {
    // Fallback to JWT auth
    const decoded = verifyToken(token!);
    if (!decoded) {
      console.warn('[DelegateHandler] Invalid token');
      ws.close(1008, 'Authentication failed');
      return;
    }
    userId = decoded.userId;
    console.log(`[DelegateHandler] Delegate "${delegateId}" authenticated via JWT (user: ${userId})`);
  }

  ws.userId = userId;
  ws.delegateId = delegateId;
  ws.isAlive = true;

  // Name collision check — reject if delegate with same ID already connected for this user
  const existingDelegate = delegateManager.findDelegate(userId, delegateId);
  if (existingDelegate) {
    // Check if the existing connection is actually alive (ghost detection)
    if (existingDelegate.ws.readyState !== WebSocket.OPEN) {
      // Ghost connection — the WebSocket is dead but was never cleaned up.
      // Force-unregister the ghost and allow the new connection to proceed.
      console.warn(`[DelegateHandler] Ghost connection detected for "${delegateId}" (readyState: ${existingDelegate.ws.readyState}) — replacing`);
      delegateManager.unregisterDelegate(existingDelegate.sessionId);
      toolRegistry.unregisterDelegateTools(userId, delegateId.toLowerCase());
    } else {
      console.warn(`[DelegateHandler] Name collision: "${delegateId}" already connected for user ${userId}`);
      ws.send(JSON.stringify({
        type: 'delegate_auth_result',
        success: false,
        error: `Delegate "${delegateId}" already connected. Use a different --delegate-id or disconnect the other.`,
      }));
      setTimeout(() => ws.close(4001, 'name_collision'), 150);
      return;
    }
  }

  // Create transport — auto-listens on ws (constructor registers ws.on('message'))
  const transport: McplTransport = new WebSocketTransport(ws);

  // Register delegate
  const sessionId = delegateManager.registerDelegate(ws, userId, delegateId);
  ws.sessionId = sessionId;

  // Send auth result
  ws.send(JSON.stringify({
    type: 'delegate_auth_result',
    success: true,
    userId,
    sessionId,
  }));

  console.log(`[DelegateHandler] Delegate "${delegateId}" authenticated for user ${userId}`);

  // Handle pong for heartbeat
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Per-connection access cache (Fix #4)
  const accessCache = new ConversationAccessCache();
  conversationAccessCaches.set(sessionId, accessCache);

  // Single message path — ALL messages through transport.
  // NOTE: When ReliableChannel is created in handleMcplHello, RC constructor calls
  // transport.onMessage(handleIncoming), replacing this handler. After that:
  // messages flow: transport → RC.handleIncoming → RC.messageHandler → handleDelegateMessage
  //
  // CRITICAL: handleDelegateMessage is async — caller MUST handle rejection.
  // void + .catch() ensures no uncaught rejections escape.
  transport.onMessage((msg) => {
    void handleDelegateMessage(ws, transport, msg, userId, delegateId, sessionId, db, accessCache)
      .catch((err) => {
        console.error(`[DelegateHandler] Unhandled error in message handler for "${delegateId}":`, err);
        ws.close(4500, 'internal_error');
      });
  });

  // Handle disconnect — save RC state for resume or clean up session
  transport.onClose((code, reason) => {
    console.log(`[DelegateHandler] Delegate "${delegateId}" disconnected (code: ${code}, reason: ${reason})`);

    // C-4 fix: Determine if this is a clean (intentional) close vs unclean (crash/network).
    // Clean close (1000, 1001) → remove session immediately (no resume expected).
    // Unclean close → save state for resume, session will be TTL-swept later.
    const isCleanClose = code === 1000 || code === 1001;

    if (!isCleanClose) {
      // Unclean: save ReliableChannel state + codec pending requests for session resume
      if (ws.mcplReliable && ws.mcplSessionId) {
        mcplSessionManager.saveReliableState(ws.mcplSessionId, ws.mcplReliable.getState());
      }
      if (ws.mcplCodecRef && ws.mcplSessionId) {
        mcplSessionManager.savePendingRequestsState(ws.mcplSessionId, ws.mcplCodecRef.getPendingRequests());
      }
    } else {
      // Clean close: remove MCPL session entirely (C-4 fix — prevents memory leak)
      if (ws.mcplSessionId) {
        mcplSessionManager.removeSession(ws.mcplSessionId);
        console.log(`[DelegateHandler] Clean close — removed MCPL session ${ws.mcplSessionId}`);
      }
    }

    // Unregister MCPL services + clean up rate-limiting state
    if (ws.mcplSessionId) {
      mcplHookManager.unregisterServer(sessionId);
    }
    mcplHookManager.cleanupDelegate(delegateId);

    // Clean up per-connection access cache (Fix #4)
    conversationAccessCaches.delete(sessionId);

    // Unregister THIS session from delegate manager (fails pending calls)
    delegateManager.unregisterDelegate(sessionId);

    // Race guard: only unregister tools if no replacement connection exists.
    // Prevents: Connection B replaces A → A.onClose deletes B's tools.
    const currentDelegate = delegateManager.findDelegate(userId, delegateId);
    if (!currentDelegate) {
      // No active connection with this delegateId → safe to unregister tools
      toolRegistry.unregisterDelegateTools(userId, delegateId.toLowerCase());
    } else {
      console.log(`[DelegateHandler] Skipping tool unregister — delegate "${delegateId}" has active replacement (session: ${currentDelegate.sessionId})`);
    }
  });

  ws.on('error', (error) => {
    console.error(`[DelegateHandler] WebSocket error for delegate "${delegateId}":`, error.message);
  });
}

// =============================================================================
// Unified Message Handler (single message path)
// =============================================================================

async function handleDelegateMessage(
  ws: DelegateWebSocket,
  transport: McplTransport,
  msg: Record<string, unknown>,
  userId: string,
  delegateId: string,
  sessionId: string,
  db: Database,
  accessCache: ConversationAccessCache,
): Promise<void> {
  // H5: Normalize raw JSON-RPC requests to internal format for dispatch.
  // initialize and notifications/initialized arrive as { jsonrpc, method, id?, params }
  // which has no `type` field. Flatten to { type, requestId, ...params }.
  if (msg.jsonrpc === '2.0' && typeof msg.method === 'string' && !msg.type) {
    const params = (msg.params || {}) as Record<string, unknown>;
    msg = { ...params, type: msg.method as string, ...(msg.id !== undefined ? { requestId: msg.id } : {}) };
  }

  const type = msg.type as string;
  if (!type) return;

  // ==========================================================================
  // Fix #4: Dispatch-level conversation access guard
  // All MCPL messages with a conversationId are checked BEFORE the switch.
  // This is the ONLY place the check runs — no per-handler checks needed.
  // ==========================================================================
  if (type.startsWith('mcpl/')) {
    const conversationId = extractConversationId(msg);
    if (conversationId) {
      const granted = await accessCache.checkOrFetch(userId, conversationId, db);
      if (!granted) {
        const activeTransport = ws.mcplTransport || transport;
        sendMcplError(
          activeTransport,
          MCPL_ERROR_CODES.ACCESS_DENIED,
          'Conversation not found or access denied',  // never reveal existence
          {
            type,
            requestId: (msg.requestId as string) || undefined,
            seq: typeof msg.seq === 'number' ? msg.seq : undefined,
          },
        );
        // conversationId masked in logs — only first 8 chars
        const masked = conversationId.length > 8 ? conversationId.substring(0, 8) + '...' : '***';
        console.warn(`[DelegateHandler] Access denied: delegate "${delegateId}" → conversation ${masked} (type: ${type})`);
        return;
      }
    }
  }

  // ==========================================================================
  // Fix #2: Rate limiting — after auth+access guard, before dispatch
  // Per-user FIRST → global SECOND (reject cheap before touching shared state)
  // ==========================================================================
  const opType = messageTypeToOpType(type);
  if (opType) {
    const rateLimitResult = mcplRateLimiter.check(userId, opType);
    if (!rateLimitResult.allowed) {
      const activeTransport = ws.mcplTransport || transport;
      sendMcplError(
        activeTransport,
        MCPL_ERROR_CODES.RATE_LIMITED,
        'Rate limited',  // don't leak timing in human message
        {
          type,
          requestId: (msg.requestId as string) || undefined,
          seq: typeof msg.seq === 'number' ? msg.seq : undefined,
        },
        rateLimitResult.retryAfterMs,
      );
      return;
    }
  }

  switch (type) {
    // Legacy messages
    case 'tool_manifest':
      handleToolManifest(ws, msg as unknown as ToolManifestMessage, userId, delegateId, sessionId, db);
      break;

    case 'tool_call_response':
      handleToolCallResponse(msg as unknown as ToolCallResponseMessage);
      break;

    case 'trigger_inference':
      handleTriggerInference(ws, msg as unknown as TriggerInferenceMessage, userId, db);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: (msg as any).timestamp }));
      break;

    case 'delegate_auth':
      // Already authenticated at connection time, ignore re-auth
      break;

    // MCPL messages (arrive unwrapped if via ReliableChannel)
    // H5: Standard MCP initialize replaces custom mcpl/hello
    case 'initialize':
      handleInitialize(ws, transport, msg, userId, delegateId, sessionId, db, accessCache);
      break;

    // H5: MCP spec requires notifications/initialized after successful init — no-op
    case 'notifications/initialized':
      break;

    case 'mcpl/beforeInference_response':
      mcplHookManager.handleBeforeInferenceResponse(
        (msg as any).requestId,
        (msg as any).contextInjections ?? (msg as any).injections ?? [],  // spec: contextInjections
        (msg as any).abort,
        (msg as any).abortReason,
      );
      break;

    case 'mcpl/afterInference_ack':
    case 'mcpl/afterInference_response':
      // Gap 4: Blocking afterInference — delegate responds with optional modifiedResponse
      mcplHookManager.handleAfterInferenceResponse(
        (msg as any).requestId,
        (msg as any).modifiedResponse,
        (msg as any).featureSet,
        (msg as any).metadata,
      );
      break;

    case 'mcpl/push_event': {
      const pushMsg = msg as any;
      // Gap 1: Feature set enforcement — check pushEvents capability
      // F8a: source → featureSet rename
      const pushCheck = mcplSessionManager.validateCapability(userId, delegateId, pushMsg.featureSet, 'push_events');
      if (pushCheck !== 'ok') {
        const activeTransport = ws.mcplTransport || transport;
        const reason = pushCheck === 'unknown_server'
          ? `Server "${pushMsg.featureSet}" not registered`
          : pushCheck === 'disabled'
          ? `Push events disabled for "${pushMsg.featureSet}"`
          : 'No MCPL session';
        const errorCode = pushCheck === 'unknown_server' ? MCPL_ERROR_CODES.UNKNOWN_SERVER
          : pushCheck === 'disabled' ? MCPL_ERROR_CODES.CAPABILITY_DISABLED
          : MCPL_ERROR_CODES.NO_SESSION;
        sendMcplError(activeTransport, errorCode, reason, { type, requestId: pushMsg.requestId });
        // M3: Also send spec-compliant push_event_response with accepted: false
        activeTransport.send({
          type: 'mcpl/push_event_response',
          requestId: pushMsg.requestId,
          accepted: false,
          reason,
        });
        return;
      }
      mcplEventQueue.push({
        id: pushMsg.eventId,             // spec: eventId on wire, id internally
        featureSet: pushMsg.featureSet,  // F8a: consistent naming
        conversationId: pushMsg.conversationId,
        eventType: pushMsg.eventType,
        payload: pushMsg.payload,
        systemMessage: pushMsg.systemMessage,
        idempotencyKey: pushMsg.idempotencyKey,
        timestamp: pushMsg.timestamp,
        delegateId,
        userId,
      });

      // F8b: Send push_event_response back to delegate (spec Section 9.3)
      const pushTransport = ws.mcplTransport || transport;
      pushTransport.send({
        type: 'mcpl/push_event_response',
        requestId: pushMsg.requestId,
        accepted: true,
      });
      break;
    }

    case 'mcpl/inference_request': {
      const infMsg = msg as any;
      // spec: featureSet is the wire field name (was: serverId)
      const infServerId: string = infMsg.featureSet;
      // Gap 1: Feature set enforcement — check inferenceRequests capability
      const infCheck = mcplSessionManager.validateCapability(userId, delegateId, infServerId, 'inference_requests');
      if (infCheck !== 'ok') {
        const activeTransport = ws.mcplTransport || transport;
        if (infCheck === 'unknown_server') {
          sendMcplError(activeTransport, MCPL_ERROR_CODES.UNKNOWN_SERVER,
            `Server "${infServerId}" not registered for this delegate`,
            { type, requestId: infMsg.requestId });
        } else if (infCheck === 'disabled') {
          sendMcplError(activeTransport, MCPL_ERROR_CODES.CAPABILITY_DISABLED,
            `Inference requests disabled for server "${infServerId}"`,
            { type, requestId: infMsg.requestId });
        } else {
          sendMcplError(activeTransport, MCPL_ERROR_CODES.NO_SESSION,
            'No MCPL session',
            { type, requestId: infMsg.requestId });
        }
        return;
      }
      // Direct lookup — infMsg.featureSet IS the featureSet name
      const infSession = mcplSessionManager.getSessionForDelegate(userId, delegateId);
      let inferenceFeatureSet: string | undefined;
      if (infSession?.declaredFeatureSets[infServerId]) {
        inferenceFeatureSet = infServerId;
      }

      // Bug 4: conversationId required by broker (chain tracking, room broadcast, DB)
      if (!infMsg.conversationId) {
        const activeTransport = ws.mcplTransport || transport;
        sendMcplError(
          activeTransport,
          -32602,
          'conversationId is required for inference requests',
          { type: 'mcpl/inference_request', requestId: infMsg.requestId }
        );
        return;
      }

      mcplInferenceBroker.handleInferenceRequest({
        requestId: infMsg.requestId,
        featureSet: infServerId,  // infServerId IS the featureSet name (from infMsg.featureSet)
        conversationId: infMsg.conversationId,
        systemMessage: infMsg.systemMessage,
        userMessage: infMsg.userMessage,      // F17: legacy
        messages: infMsg.messages,            // F17: multi-turn
        maxTokens: infMsg.preferences?.maxTokens,   // spec: unwrap from preferences
        stream: infMsg.stream,
        delegateId,
        userId,
        transport: ws.mcplTransport || transport,
        parentChainId: infMsg.parentChainId,
        parentFrameId: infMsg.parentFrameId,
      });
      break;
    }

    case 'mcpl/scope_change_request': {
      const scopeMsg = msg as any;

      // Track pending request for resolution
      pendingScopeChanges.set(scopeMsg.requestId, {
        delegateId,
        userId,
        serverId: scopeMsg.serverId,
        conversationId: scopeMsg.conversationId || '',
        url: scopeMsg.url || '',
        serverName: scopeMsg.serverName || scopeMsg.serverId,
        requestedCapabilities: scopeMsg.requestedCapabilities,
        timestamp: Date.now(),
      });

      // 5-minute timeout — auto-deny if user doesn't respond
      setTimeout(() => {
        if (pendingScopeChanges.has(scopeMsg.requestId)) {
          resolveScopeChange(scopeMsg.requestId, false, db, undefined, 'denied_by_timeout');
        }
      }, 5 * 60 * 1000);

      // Forward scope change request to user's UI (all their browser tabs)
      roomManager.broadcastToUser(userId, {
        type: 'mcpl/scope_change_approval_needed',
        requestId: scopeMsg.requestId,
        conversationId: scopeMsg.conversationId || '',
        delegateId,
        delegateName: delegateId,
        requestedCapabilities: {
          servers: [{
            url: scopeMsg.url || '',
            name: scopeMsg.serverName || scopeMsg.serverId,
            reason: scopeMsg.reason || '',
          }],
        },
        timeout: 300,
        ...(scopeMsg.payload ? { payload: scopeMsg.payload } : {}),  // F12
      });
      console.log(`[DelegateHandler] Scope change requested by ${delegateId}: ${scopeMsg.serverName || scopeMsg.serverId} (${scopeMsg.url || 'no url'})`);
      break;
    }

    case 'mcpl/connect_server_result': {
      // Delegate reports outcome of addServer() after scope change was approved
      const result = msg as any;
      const status = result.success ? 'approved_connected' : 'approved_failed';
      db?.appendMcplUserEvent(userId, 'scope_change_resolved', {
        requestId: result.requestId,
        delegateId,
        serverId: result.serverId ?? '',
        status,
        url: result.url,
        error: result.error,
      } as Record<string, unknown>).catch(err =>
        console.warn('[DelegateHandler] Failed to persist scope_change_resolved:', err)
      );
      break;
    }

    case 'mcpl/scope_elevate_request': {
      // Phase 7 Batch 4: capability elevation request with dedup + policy eval
      const elevateMsg = msg as any;
      handleScopeElevateRequest(ws, elevateMsg, userId, delegateId, db);
      break;
    }

    case 'mcpl/featureSets_changed': {
      // Phase 7 Batch 2a: dynamic featureSet update (full replacement)
      handleFeatureSetsChanged(ws, msg as any, userId, delegateId, sessionId, db);
      break;
    }

    case 'mcpl/state_set': {
      // H8+L2: state keyed by featureSet + conversationId (spec §8)
      const stateMsg = msg as any;
      const setFs = stateMsg.featureSet || '';
      mcplStateManager.setUserId(setFs, stateMsg.conversationId, userId);
      const setResult = mcplStateManager.setState(
        setFs,
        stateMsg.conversationId,
        stateMsg.state,
        stateMsg.expectedVersion,
      );
      if (stateMsg.requestId) {
        const setTransport = ws.mcplTransport || transport;
        setTransport.send({
          type: 'mcpl/state_set_result',
          requestId: stateMsg.requestId,
          success: setResult.success,
          ...(setResult.error ? { error: setResult.error } : {}),
          stateVersion: mcplStateManager.getStateVersion(setFs, stateMsg.conversationId),
        });
      }
      break;
    }

    case 'mcpl/state_patch': {
      const patchMsg = msg as any;
      const patchFs = patchMsg.featureSet || '';
      mcplStateManager.setUserId(patchFs, patchMsg.conversationId, userId);
      const patchResult = mcplStateManager.applyPatch(
        patchFs,
        patchMsg.conversationId,
        patchMsg.patch,
        patchMsg.expectedVersion,
      );
      const patchResponse = {
        type: 'mcpl/state_patch_result',
        requestId: patchMsg.requestId,
        success: patchResult.success,
        ...(patchResult.error ? { error: patchResult.error } : {}),
        stateVersion: mcplStateManager.getStateVersion(patchFs, patchMsg.conversationId),
      };
      const patchTransport = ws.mcplTransport || transport;
      patchTransport.send(patchResponse);
      break;
    }

    case 'mcpl/state_rollback': {
      const rollbackMsg = msg as any;
      const rollbackTransport = ws.mcplTransport || transport;
      const rollbackFs = rollbackMsg.featureSet || '';
      mcplStateManager.setUserId(rollbackFs, rollbackMsg.conversationId, userId);

      const check = mcplStateManager.canRollback(
        rollbackFs,
        rollbackMsg.conversationId,
        rollbackMsg.checkpointId,
      );

      if (!check.exists) {
        // M1: Emit -32005 CHECKPOINT_NOT_FOUND per spec
        sendMcplError(
          rollbackTransport,
          MCPL_ERROR_CODES.CHECKPOINT_NOT_FOUND,
          check.error === 'expired' ? 'Checkpoint expired'
            : check.error === 'unknown' ? 'Checkpoint not found'
            : 'No checkpoints exist',
          { type: 'mcpl/state_rollback', requestId: rollbackMsg.requestId },
        );
        break;
      }

      const result = mcplStateManager.commitRollback(
        rollbackFs,
        rollbackMsg.conversationId,
        check.checkpointId,
      );

      if (result.success) {
        rollbackTransport.send({
          type: 'mcpl/state_response',
          requestId: rollbackMsg.requestId,
          state: mcplStateManager.getState(rollbackFs, rollbackMsg.conversationId) ?? null,
          rolledBack: true,
          checkpointId: check.checkpointId,
        });
      } else {
        rollbackTransport.send({
          type: 'mcpl/state_response',
          requestId: rollbackMsg.requestId,
          state: null,
          rolledBack: false,
          error: result.error,
        });
      }
      break;
    }

    case 'mcpl/state_get': {
      const getMsg = msg as any;
      const getFs = getMsg.featureSet || '';
      const currentState = mcplStateManager.getState(getFs, getMsg.conversationId) ?? null;
      const getResponse = {
        type: 'mcpl/state_response',
        requestId: getMsg.requestId,
        state: currentState,
        stateVersion: mcplStateManager.getStateVersion(getFs, getMsg.conversationId),
      };
      const getTransport = ws.mcplTransport || transport;
      getTransport.send(getResponse);
      break;
    }

    case 'mcpl/checkpoint_list': {
      const listMsg = msg as any;
      const listTransport = ws.mcplTransport || transport;
      const listFs = listMsg.featureSet || '';
      const checkpointResult = mcplStateManager.getCheckpoints(listFs, listMsg.conversationId);

      listTransport.send({
        type: 'mcpl/checkpoint_list_response',
        requestId: listMsg.requestId,
        current: checkpointResult?.current ?? '',
        checkpoints: checkpointResult?.checkpoints ?? [],
      });
      break;
    }

    case 'mcpl/model_info_request': {
      // Phase 7: delegate requests model capabilities for its conversation
      handleModelInfoRequest(ws, msg as any, userId, db);
      break;
    }

    default:
      console.warn(`[DelegateHandler] Unknown message type "${type}" from "${delegateId}"`);
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

function handleToolManifest(
  ws: DelegateWebSocket,
  msg: ToolManifestMessage,
  userId: string,
  delegateId: string,
  sessionId: string,
  db: Database
): void {
  // NOTE: msg.delegateId is IGNORED — handshake delegateId is canonical.
  // Prevents delegate from "renaming" itself inside a manifest message.
  const delegateName = delegateId.toLowerCase();  // normalize for namespacing

  console.log(`[DelegateHandler] Tool manifest from "${delegateId}" (namespace: ${delegateName}): ${msg.tools.length} tools`);

  // 1. Validate and split: MCP-backed tools without featureSet are rejected
  const acceptedTools: Array<typeof msg.tools[0] & { serverId: string; featureSet?: string }> = [];
  const rejectedTools: Array<{ toolName: string; reason: string }> = [];

  for (const t of msg.tools) {
    const serverName = (t as any).serverName;
    const featureSet = (t as any).featureSet;
    if (serverName && !featureSet) {
      console.error(`[DelegateHandler] Tool "${t.name}" from delegate "${delegateId}" has serverName but no featureSet — rejected`);
      rejectedTools.push({ toolName: t.name, reason: 'missing featureSet' });
      continue;
    }
    acceptedTools.push({
      ...t,
      serverId: delegateManager.getOrCreateServerId(
        delegateId,
        serverName || '_default'
      ),
      featureSet,
    });
  }
  if (rejectedTools.length > 0) {
    console.warn(`[DelegateHandler] Rejected ${rejectedTools.length} tools from "${delegateId}": ${rejectedTools.map(r => r.toolName).join(', ')}`);
  }

  // 2. Use acceptedTools everywhere downstream
  delegateManager.updateTools(sessionId, acceptedTools as any, msg.timestamp);

  // Persist tool manifest snapshot to DB (fire-and-forget — don't block ack)
  db.appendMcplUserEvent(userId, 'delegate_tool_manifest', {
    delegateId,
    timestamp: msg.timestamp || new Date().toISOString(),
    toolCount: acceptedTools.length,
    tools: acceptedTools.map(t => ({ name: t.name, serverName: (t as any).serverName })),
  }).catch(err => {
    console.error(`[DelegateHandler] Failed to persist tool manifest for "${delegateId}":`, err);
  });

  // Clean old tools before registering new ones (handles re-manifest with changed tool set)
  toolRegistry.unregisterDelegateTools(userId, delegateName);

  // Fix #3: Register unique (delegateId, serverName, serverId) tuples with ServerRegistry.
  const registeredServers = new Set<string>();
  for (const t of acceptedTools) {
    const serverName = (t as any).serverName || '_default';
    const key = `${delegateId}:${serverName}:${t.serverId}`;
    if (!registeredServers.has(key)) {
      registeredServers.add(key);
      serverRegistry.register(delegateId, serverName, t.serverId);
    }
  }

  // Gap 7 REMOVED — featureSets come from delegate's hello, not tool manifest.

  // Register tools in tool registry with prefixed names
  toolRegistry.registerDelegateTools(
    userId,
    delegateName,     // normalized (lowercase) for registry keys
    delegateId,       // original case for display
    acceptedTools as any,
    async (originalToolName: string, input: Record<string, unknown>, ctx?: { conversationId?: string }) => {
      // Resolve scopeContext from tool's explicit featureSet metadata
      let scopeCtx: { featureSet: string; activeCapabilities: string[] } | undefined;
      const tool = acceptedTools.find(t => t.name === originalToolName);
      if (tool?.featureSet) {
        const session = mcplSessionManager.getSessionForDelegate(userId, delegateId);
        if (session) {
          const decl = session.declaredFeatureSets[tool.featureSet];
          if (decl) {
            scopeCtx = {
              featureSet: tool.featureSet,
              activeCapabilities: [...decl.rawUses],
            };
          }
        }
      } else if (tool && (tool as any).serverName) {
        // Tool registered without explicit featureSet — warn, scope tagging lost
        console.warn(`[DelegateHandler] Tool "${originalToolName}" has no featureSet metadata — scope tagging disabled for this call`);
      }

      // H7+H8: Spec §8.4 — state/checkpoint at top level, keyed by featureSet
      let mcplState: { state: Record<string, unknown> | null; checkpoint?: string; stateVersion?: number } | undefined;
      if (ctx?.conversationId) {
        const toolFs = scopeCtx?.featureSet || '';
        const currentState = mcplStateManager.getState(toolFs, ctx.conversationId) ?? null;
        const stateVersion = mcplStateManager.getStateVersion(toolFs, ctx.conversationId);
        mcplState = {
          state: currentState,
          ...(stateVersion > 0 ? { stateVersion } : {}),
        };
      }

      return delegateManager.executeToolOnDelegate(
        delegateId,
        userId,
        { id: '', name: originalToolName, input },
        undefined,
        scopeCtx,
        undefined,
        mcplState,
      );
    }
  );

  // 3. Ack includes rejected tools as structured warnings
  ws.send(JSON.stringify({
    type: 'tool_manifest_ack',
    toolCount: acceptedTools.length,
    tools: acceptedTools.map(t => `${delegateName}__${t.name}`),
    ...(rejectedTools.length > 0 ? {
      warnings: rejectedTools.map(r => ({ toolName: r.toolName, reason: r.reason })),
    } : {}),
  }));
}

function handleToolCallResponse(msg: ToolCallResponseMessage): void {
  delegateManager.handleToolCallResponse(msg);
}

/** Convert McplHandshakeCapabilities (wire) → McplCapabilities (session).
 *  Dict featureSets → boolean true. Missing → undefined. */
function normalizeHandshakeCapabilities(handshake: McplHandshakeCapabilities): McplCapabilities {
  return {
    version: handshake.version,
    pushEvents: handshake.pushEvents,
    contextHooks: handshake.contextHooks,
    inferenceRequest: handshake.inferenceRequest,
    modelInfo: handshake.modelInfo,
    featureSets: typeof handshake.featureSets === 'object' ? true : handshake.featureSets,
    toolManagement: handshake.toolManagement,
  };
}

/** Build McplHandshakeCapabilities for ack — separates negotiated booleans from declarations. */
function buildAckCapabilities(session: ReturnType<typeof mcplSessionManager.getSession>): McplHandshakeCapabilities {
  if (!session) return {};
  return {
    version: session.capabilities.version,
    pushEvents: session.capabilities.pushEvents,
    contextHooks: session.capabilities.contextHooks,
    inferenceRequest: session.capabilities.inferenceRequest,
    modelInfo: session.capabilities.modelInfo,
    toolManagement: session.capabilities.toolManagement,
    featureSets: buildAckFeatureSets(session),  // declarations dict, not boolean
  };
}

/** Build featureSets dict for ack from all declared feature sets. */
function buildAckFeatureSets(session: ReturnType<typeof mcplSessionManager.getSession>): Record<string, McplFeatureSet> {
  if (!session) return {};
  const result: Record<string, McplFeatureSet> = {};
  for (const [name, decl] of Object.entries(session.declaredFeatureSets)) {
    result[name] = {
      uses: [...decl.rawUses],
      description: decl.description,
      scoped: decl.scoped,
      rollback: decl.rollback,
      ownerServerId: decl.ownerServerId,
    };
  }
  return result;
}

/**
 * H5: Handle MCP initialize request with experimental.mcpl capabilities.
 * Replaces custom mcpl/hello per spec §3.1, §5.1-5.2.
 */
function handleInitialize(
  ws: DelegateWebSocket,
  transport: McplTransport,
  msg: Record<string, unknown>,
  userId: string,
  delegateId: string,
  _legacySessionId: string,
  db: Database,
  accessCache: ConversationAccessCache,
): void {
  // H5: Extract fields from MCP initialize params structure
  const mcplCaps: McplHandshakeCapabilities = (msg as any).capabilities?.experimental?.mcpl || {};
  const mcplData = (msg as any)._mcpl || {};
  const initDelegateId = mcplData.delegateId || delegateId;
  const protocolVersion = (msg as any).protocolVersion || '2024-11-05';
  const resumeSessionId = mcplData.sessionId;
  const lastReceivedSeq = mcplData.lastReceivedSeq;

  // 1. Extract declared featureSets from handshake (wire field = featureSets)
  const declared: Record<string, McplFeatureSet> | null =
    (typeof mcplCaps?.featureSets === 'object' && mcplCaps.featureSets !== null)
      ? mcplCaps.featureSets
      : null;  // null = "not sent" (distinct from empty {})

  // 1b. Normalize handshake → session capabilities (dict featureSets → boolean true)
  const sessionCaps = normalizeHandshakeCapabilities(mcplCaps);

  console.log(`[DelegateHandler] MCP initialize from "${initDelegateId}" (protocol: ${protocolVersion}, mcpl capabilities: ${JSON.stringify(mcplCaps)})`);

  // ── C-1 fix: race guard ──────────────────────────────────────────────
  const handshakeKey = `${userId}:${initDelegateId}`;
  if (pendingHandshakes.has(handshakeKey)) {
    console.warn(`[DelegateHandler] Concurrent initialize rejected for "${initDelegateId}" — handshake already in progress`);
    const errorPayload = {
      jsonrpc: '2.0' as const,
      id: (msg as any).requestId ?? null,
      error: { code: -32002, message: 'Handshake already in progress — retry after backoff' },
    };
    transport.send(errorPayload);
    return;
  }
  pendingHandshakes.add(handshakeKey);
  // ─────────────────────────────────────────────────────────────────────

  try {
    // Try session resume if delegate sends a sessionId in _mcpl
    let session = resumeSessionId
      ? mcplSessionManager.resumeSession(resumeSessionId, userId)
      : null;

    const isResume = !!session;

    if (!session) {
      // Create new MCPL session
      const negotiated = mcplSessionManager.negotiateCapabilities(sessionCaps);
      session = mcplSessionManager.createSession(initDelegateId, userId, negotiated, protocolVersion);
    } else {
      // Resume: re-negotiate capabilities to catch changes
      const renegotiated = mcplSessionManager.negotiateCapabilities(sessionCaps);
      mcplSessionManager.updateSessionCapabilities(session.sessionId, renegotiated);
    }

    // 3. Feature set reconciliation — single flow, no duplication
    if (declared !== null) {
      // Delegate sent declarations → reconcile
      const { added } = mcplSessionManager.reconcileDeclaredFeatureSets(session.sessionId, declared);
      if (!isResume) {
        // New session: enable all declared feature sets (default host policy)
        mcplSessionManager.enableAllDeclaredFeatureSets(session.sessionId);
      } else {
        // Resume: only enable newly added (preserve existing host decisions)
        for (const name of added) {
          mcplSessionManager.enableFeatureSet(session.sessionId, name);
        }
      }
      // Semantic validation: quarantine feature sets with unsupported uses
      // Runs AFTER enable — quarantine overrides enabledFeatureSets at effective level
      applyUsesValidation(session.sessionId, declared, initDelegateId);
    } else if (!isResume) {
      // New session without declarations → empty feature sets (nothing to enable)
    }
    // else: resume without declarations → preserve existing state (no reconcile)

    // Mark this connection as MCPL
    ws.isMcpl = true;
    ws.mcplSessionId = session.sessionId;

    // Create ReliableChannel wrapping the raw transport
    const reliable = new ReliableChannel(transport);

    // Restore seq/ack state on resume
    if (isResume) {
      const savedState = mcplSessionManager.getReliableState(session.sessionId);
      if (savedState) {
        reliable.restoreState(savedState);
      }
    }

    // Wrap ReliableChannel with McplCodec for JSON-RPC 2.0 wire format
    const codec = new McplCodec(reliable);
    ws.mcplTransport = codec;
    ws.mcplReliable = reliable;   // direct RC ref for getState() on disconnect
    ws.mcplCodecRef = codec;      // direct codec ref for pendingRequests save/restore

    // Restore pending requests on resume (BUG 6+7 fix)
    if (isResume) {
      const savedPending = mcplSessionManager.getPendingRequestsState(session.sessionId);
      if (savedPending) {
        codec.restorePendingRequests(savedPending);
      }
    }

    // IMPORTANT: Set message handler BEFORE sending ack or resending buffered frames.
    // CRITICAL: handleDelegateMessage is async — use void + .catch() (Fix #4)
    codec.onMessage((innerMsg) => {
      void handleDelegateMessage(ws, codec, innerMsg, userId, initDelegateId, _legacySessionId, db, accessCache)
        .catch((err) => {
          console.error(`[DelegateHandler] Unhandled error in RC message handler for "${initDelegateId}":`, err);
          ws.close(4500, 'internal_error');
        });
    });

    // 5. Reconcile scopes from host policy
    const scopes = buildScopesForDelegate(userId, initDelegateId);
    mcplSessionManager.reconcileFeatureSetScopes(session.sessionId, scopes ?? {});

    // 6. Send ack — use dedicated builder (no spread of session.capabilities)
    const ackMsg: Record<string, unknown> = {
      type: 'mcpl/ack',
      requestId: (msg as any).requestId,  // correlate with initialize request id
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'animachat', version: '1.0.0' },
      capabilities: {
        experimental: { mcpl: buildAckCapabilities(session) },
      },
      _mcpl: {
        sessionId: session.sessionId,
        ...(isResume && typeof lastReceivedSeq === 'number' ? { resumedFromSeq: lastReceivedSeq } : {}),
      },
    };
    codec.send(ackMsg);

    // 7. Send featureSets/update — explicit host decision
    codec.send({
      type: 'mcpl/featureSets_update',
      enabled: mcplSessionManager.getEffectiveEnabledNames(session.sessionId),
      disabled: mcplSessionManager.getEffectiveDisabledNames(session.sessionId),
      scopes: mcplSessionManager.exportScopes(session.sessionId),
    });

    // Resend buffered frames on resume
    if (isResume && typeof lastReceivedSeq === 'number') {
      reliable.resendBufferedAfter(lastReceivedSeq);
    }

    // 8. Hook registration — use _legacySessionId consistently
    const hookFeatureSetNames = Object.entries(session.declaredFeatureSets)
      .filter(([name, decl]) =>
        mcplSessionManager.isFeatureSetEffectivelyEnabled(session.sessionId, name) &&
        resolveCapabilities(decl.rawUses).includes('context_hooks')
      )
      .map(([name]) => name);

    if (hookFeatureSetNames.length > 0) {
      mcplHookManager.registerServer(
        _legacySessionId, initDelegateId, userId, codec, hookFeatureSetNames
      );
    }

    console.log(`[DelegateHandler] MCPL ${isResume ? 'resumed' : 'new'} session for "${initDelegateId}" (session: ${session.sessionId}, capabilities: ${JSON.stringify(session.capabilities)})`);
  } finally {
    // C-1: Always release handshake lock
    pendingHandshakes.delete(handshakeKey);
  }
}

/**
 * Handle scope_elevate_request — MCP server requests capability elevation mid-operation.
 * Dedup by (delegateId, featureSet, label) — NOT by requestId.
 * Policy evaluation first: auto-approve/deny if policy exists, otherwise ask user.
 */
/**
 * §7.5 Security: Validate that payload paths don't escape label scope.
 * Prevents: label="/tmp/safe.txt" + payload={ path: "/etc/passwd" }
 */
function validatePayloadAgainstLabel(label: string, payload?: Record<string, unknown>): string | null {
  if (!payload) return null; // no payload = no risk

  // Check all string values in payload for path traversal relative to label
  const labelDir = label.includes('/') ? label.substring(0, label.lastIndexOf('/')) : '';

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue;

    // Check for path-like values that escape label scope
    if (key === 'path' || key === 'file' || key === 'target' || key === 'destination' || key === 'source') {
      // Normalize: resolve .. and check if path stays within label scope
      if (value.includes('..')) {
        return `Payload "${key}" contains path traversal: ${value}`;
      }
      // If label looks like a path, payload paths should share the same prefix
      if (labelDir && value.startsWith('/') && !value.startsWith(labelDir)) {
        return `Payload "${key}" escapes label scope: label="${label}", ${key}="${value}"`;
      }
    }
  }
  return null;
}

function handleScopeElevateRequest(
  ws: DelegateWebSocket,
  msg: {
    requestId: string;
    featureSet: string;
    scope: { label: string; payload?: Record<string, unknown> };
    delegateId: string;
    serverId: string;
    conversationId: string;
    requestedUses: string[];
    reason: string;
    timeoutMs?: number;
  },
  userId: string,
  delegateId: string,
  db: Database
): void {
  const timeoutMs = msg.timeoutMs || 60_000;
  const dedupKey = makeScopeElevateDedupKey(delegateId, msg.featureSet, msg.scope.label);

  // §7.5 Security: Validate payload against label before policy check
  const payloadViolation = validatePayloadAgainstLabel(msg.scope.label, msg.scope.payload);
  if (payloadViolation) {
    console.warn(`[DelegateHandler] Scope elevate DENIED (payload mismatch) for ${delegateId}: ${payloadViolation}`);
    const transport = ws.mcplTransport;
    const response = {
      type: 'mcpl/scope_elevate_result',
      requestId: msg.requestId,
      approved: false,
      reason: `Payload validation failed: ${payloadViolation}`,
      scoped: true,
    };
    if (transport) {
      transport.send(response);
    } else {
      ws.send(JSON.stringify(response));
    }
    return;
  }

  // 0. Preflight checks before policy evaluation
  const sendDeny = (reason: string) => {
    const transport = ws.mcplTransport;
    const response = {
      type: 'mcpl/scope_elevate_result',
      requestId: msg.requestId,
      approved: false,
      reason,
      scoped: true,
    };
    if (transport) transport.send(response); else ws.send(JSON.stringify(response));
  };

  // 0a. Target validation: session + declared featureSet
  const targetError = getScopeElevateTargetError(userId, delegateId, msg.featureSet);
  if (targetError) {
    sendDeny(targetError);
    console.log(`[DelegateHandler] Scope elevate denied (invalid target) for ${delegateId}: ${targetError}`);
    return;
  }

  // 0b. Uses validation: host-supported only
  const usesError = getScopeElevateUsesError(msg.requestedUses);
  if (usesError) {
    sendDeny(usesError);
    console.log(`[DelegateHandler] Scope elevate denied (unsupported uses) for ${delegateId}: ${usesError}`);
    return;
  }

  // 1. Policy check
  const policyResult = evaluateScopePolicy(userId, delegateId, msg.featureSet, msg.scope.label, msg.requestedUses);

  if (policyResult === 'approve') {
    // Auto-approve via unified helper (updates session + sends featureSets_update)
    completeScopeDecision({
      approved: true,
      userId,
      delegateId,
      featureSet: msg.featureSet,
      requestedUses: msg.requestedUses,
      requestId: msg.requestId,
      payload: msg.scope.payload,
      transport: ws.mcplTransport,
      ws,
    });
    console.log(`[DelegateHandler] Scope elevate auto-approved (policy) for ${delegateId}:${msg.featureSet}:${msg.scope.label}`);
    return;
  }

  if (policyResult === 'deny') {
    // Auto-deny via unified helper (sends featureSets_update with disabled)
    completeScopeDecision({
      approved: false,
      userId,
      delegateId,
      featureSet: msg.featureSet,
      requestedUses: msg.requestedUses,
      requestId: msg.requestId,
      payload: msg.scope.payload,
      reason: 'Denied by policy',
      transport: ws.mcplTransport,
      ws,
    });
    console.log(`[DelegateHandler] Scope elevate auto-denied (policy) for ${delegateId}:${msg.featureSet}:${msg.scope.label}`);
    return;
  }

  // 2. Check dedup — if same (delegateId, featureSet, label) is already pending
  const existing = pendingScopeElevations.get(dedupKey);
  if (existing) {
    // Replace requestId (DON'T send new UI dialog), reset timeout
    clearTimeout(existing.timeout);
    existing.requestId = msg.requestId;
    existing.timeout = setTimeout(() => {
      resolveScopeElevateTimeout(dedupKey);
    }, timeoutMs);
    console.log(`[DelegateHandler] Scope elevate dedup: updated requestId for ${dedupKey}`);
    return;
  }

  // 3. New elevation request — store and send UI dialog
  const timeout = setTimeout(() => {
    resolveScopeElevateTimeout(dedupKey);
  }, timeoutMs);

  pendingScopeElevations.set(dedupKey, {
    requestId: msg.requestId,
    delegateId,
    serverId: msg.serverId,
    conversationId: msg.conversationId,
    featureSet: msg.featureSet,
    label: msg.scope.label,
    requestedUses: msg.requestedUses,
    reason: msg.reason,
    userId,
    timeout,
    payload: msg.scope.payload,
  });

  // Broadcast approval dialog to user's UI
  roomManager.broadcastToUser(userId, {
    type: 'mcpl/scope_elevate_approval_needed',
    requestId: msg.requestId,
    conversationId: msg.conversationId,
    delegateId,
    delegateName: delegateId,
    featureSet: msg.featureSet,
    label: msg.scope.label,
    requestedUses: msg.requestedUses,
    reason: msg.reason,
    timeout: Math.round(timeoutMs / 1000),
    ...(msg.scope.payload ? { payload: msg.scope.payload } : {}),
  });

  console.log(`[DelegateHandler] Scope elevate requested by ${delegateId}: ${msg.featureSet}/${msg.scope.label} → ${msg.requestedUses.join(', ')}`);
}

/**
 * Auto-deny a scope elevate request on timeout.
 */
function resolveScopeElevateTimeout(dedupKey: string): void {
  const pending = pendingScopeElevations.get(dedupKey);
  if (!pending) return;

  pendingScopeElevations.delete(dedupKey);

  const delegate = delegateManager.findDelegate(pending.userId, pending.delegateId);
  if (delegate) {
    const response = {
      type: 'mcpl/scope_elevate_result',
      requestId: pending.requestId,
      approved: false,
      reason: 'Timed out',                    // spec: denial reason
      payload: pending.payload,                // spec: echo back payload
      scoped: true,
    };
    const transport = (delegate.ws as DelegateWebSocket).mcplTransport;
    if (transport) {
      transport.send(response);
    } else {
      delegate.ws.send(JSON.stringify(response));
    }
  }

  console.log(`[DelegateHandler] Scope elevate timed out for ${pending.delegateId}:${pending.featureSet}:${pending.label}`);
}

/**
 * Handle featureSets/changed — F15: delta semantics with legacy fallback.
 * Delta mode: msg.added / msg.removed apply incremental changes.
 * Legacy mode: msg.featureSets is full replacement (server computes diff).
 */
function handleFeatureSetsChanged(
  ws: DelegateWebSocket,
  msg: { added?: Record<string, McplFeatureSet>; removed?: string[]; featureSets?: Record<string, McplFeatureSet> },
  userId: string,
  delegateId: string,
  sessionId: string,
  db: Database
): void {
  // sessionId here IS _legacySessionId (passed from handleDelegateMessage)
  if (!ws.mcplSessionId) {
    console.warn(`[DelegateHandler] featureSets_changed before mcpl/hello from "${delegateId}", ignoring`);
    return;
  }

  const session = mcplSessionManager.getSession(ws.mcplSessionId);
  if (!session) {
    console.warn(`[DelegateHandler] featureSets_changed for unknown session ${ws.mcplSessionId}, ignoring`);
    return;
  }

  let addedNames: string[] = [];
  let removedNames: string[] = [];

  const isDelta = msg.added !== undefined || msg.removed !== undefined;

  if (isDelta) {
    // Delta mode
    if (msg.removed?.length) {
      removedNames = msg.removed.filter((n: string) => n in session.declaredFeatureSets);
      if (removedNames.length) {
        mcplSessionManager.undeclareFeatureSets(ws.mcplSessionId, removedNames);
      }
    }
    if (msg.added) {
      addedNames = mcplSessionManager.mergeDeclaredFeatureSets(ws.mcplSessionId, msg.added);
      // Host policy: only enable newly added (existing names keep their state)
      for (const name of addedNames) {
        mcplSessionManager.enableFeatureSet(ws.mcplSessionId, name);
      }
      // Quarantine invalid — auto-recovers valid
      applyUsesValidation(ws.mcplSessionId, msg.added, delegateId);
    }
  } else if (msg.featureSets) {
    // Full replacement — reconcile preserves enabled/scopes for surviving names
    const result = mcplSessionManager.reconcileDeclaredFeatureSets(ws.mcplSessionId, msg.featureSets);
    addedNames = result.added;
    removedNames = result.removed;
    // Only enable newly added names (surviving names keep host decisions)
    for (const name of addedNames) {
      mcplSessionManager.enableFeatureSet(ws.mcplSessionId, name);
    }
    // Quarantine invalid — auto-recovers valid on re-declaration
    applyUsesValidation(ws.mcplSessionId, msg.featureSets, delegateId);
  } else {
    return;
  }

  const refreshed = mcplSessionManager.getSession(ws.mcplSessionId);
  if (!refreshed) return;

  // Reconcile scopes from host policy (replaces all, prunes stale keys)
  const scopes = buildScopesForDelegate(userId, delegateId);
  mcplSessionManager.reconcileFeatureSetScopes(ws.mcplSessionId, scopes ?? {});

  // Send featureSets/update to delegate
  const codec = ws.mcplTransport;
  if (codec) {
    codec.send({
      type: 'mcpl/featureSets_update',
      enabled: mcplSessionManager.getEffectiveEnabledNames(ws.mcplSessionId),
      disabled: mcplSessionManager.getEffectiveDisabledNames(ws.mcplSessionId),
      scopes: mcplSessionManager.exportScopes(ws.mcplSessionId),
    });
  }

  // Hook manager — use sessionId (_legacySessionId) to match register key
  if (McplSessionManager.hasCapability(refreshed.capabilities, 'context_hooks')) {
    const hookFeatureSetNames = Object.entries(refreshed.declaredFeatureSets)
      .filter(([name, decl]) =>
        mcplSessionManager.isFeatureSetEffectivelyEnabled(ws.mcplSessionId!, name) &&
        resolveCapabilities(decl.rawUses).includes('context_hooks')
      )
      .map(([name]) => name);

    if (hookFeatureSetNames.length > 0) {
      mcplHookManager.updateFeatureSetNames(sessionId, hookFeatureSetNames);  // sessionId = _legacySessionId
    } else {
      mcplHookManager.unregisterServer(sessionId);
    }
  }

  // Session-level event: feature set runtime change (for UI/session state)
  // Always broadcast — enable/disable-only changes also need to reach frontend
  roomManager.broadcastToUser(userId, {
    type: 'mcpl/feature_sets_runtime_changed',
    delegateId,
    addedFeatureSets: addedNames,
    removedFeatureSets: removedNames,
    enabledFeatureSets: mcplSessionManager.getEffectiveEnabledNames(ws.mcplSessionId),
    timestamp: Date.now(),
  });

  // Immediate conversation-level event: write toolset_changed with per-conversation tool list.
  // Always fire — lastHistoryToolsetHash dedup handles cost.
  if (db) {
    db.recordToolsetChangedForUser(userId, delegateId, toolRegistry)
      .catch(err => console.warn('[DelegateHandler] Failed to write toolset_changed:', err));
  }

  console.log(`[DelegateHandler] featureSets_changed for "${delegateId}": ${Object.keys(refreshed.declaredFeatureSets).length} feature set(s) (added: ${addedNames.length}, removed: ${removedNames.length}, mode: ${isDelta ? 'delta' : 'legacy'})`);
}

/**
 * Handle model/info request — delegate asks what model is active in conversation.
 * Backend resolves from conversation context, returns capabilities from ModelLoader.
 */
async function handleModelInfoRequest(
  ws: DelegateWebSocket,
  msg: { requestId: string; conversationId?: string },
  userId: string,
  db: Database
): Promise<void> {
  try {
    const { ModelLoader } = await import('../config/model-loader.js');
    const modelLoader = ModelLoader.getInstance();
    const { ConfigLoader } = await import('../config/loader.js');
    const configLoader = ConfigLoader.getInstance();

    // Resolve model: prefer conversation's model, fallback to default
    let modelId: string | undefined;

    if (msg.conversationId) {
      const conv = await db.getConversation(msg.conversationId, userId);
      if (!conv) {
        // Dual delivery: prefer mcplTransport (ReliableChannel), fall back to raw ws
        const activeTransport = ws.mcplTransport;
        if (activeTransport) {
          sendMcplError(activeTransport, MCPL_ERROR_CODES.ACCESS_DENIED,
            'Conversation not found or not accessible',
            { type: 'mcpl/model_info_request', requestId: msg.requestId });
        } else {
          ws.send(JSON.stringify({
            type: 'mcpl/error',
            code: MCPL_ERROR_CODES.ACCESS_DENIED,
            message: 'Conversation not found or not accessible',
            inReplyTo: { type: 'mcpl/model_info_request', requestId: msg.requestId },
          }));
        }
        return;
      }
      modelId = conv.model;
    }

    if (!modelId) {
      modelId = await configLoader.getDefaultModel();
    }

    const model = await modelLoader.getModelById(modelId, userId);

    if (!model) {
      const transport = ws.mcplTransport;
      const response = {
        type: 'mcpl/model_info_response',
        requestId: msg.requestId,
        id: modelId,
        vendor: 'unknown',
        contextWindow: 0,
        capabilities: [] as string[],
        outputTokenLimit: 0,
        supportsThinking: false,
        supportsPrefill: false,
      };
      if (transport) {
        transport.send(response);
      } else {
        ws.send(JSON.stringify(response));
      }
      return;
    }

    const caps: string[] = [];
    if (model.capabilities?.imageInput) caps.push('vision');
    if (model.capabilities?.pdfInput) caps.push('pdf');
    if (model.capabilities?.audioInput) caps.push('audio');
    if (model.capabilities?.videoInput) caps.push('video');
    if (model.capabilities?.imageOutput) caps.push('image_output');
    if (model.capabilities?.audioOutput) caps.push('audio_output');

    const response = {
      type: 'mcpl/model_info_response',
      requestId: msg.requestId,
      id: model.id,
      vendor: model.provider,
      contextWindow: model.contextWindow,
      capabilities: caps,
      outputTokenLimit: model.outputTokenLimit,
      supportsThinking: model.supportsThinking ?? false,
      supportsPrefill: model.supportsPrefill ?? false,
    };

    const transport = ws.mcplTransport;
    if (transport) {
      transport.send(response);
    } else {
      ws.send(JSON.stringify(response));
    }
  } catch (err) {
    // F3 fix: Send error response instead of swallowing — delegate would hang forever
    console.error('[DelegateHandler] Failed to handle model_info_request:', err);
    const errorTransport = ws.mcplTransport;
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorTransport) {
      sendMcplError(errorTransport, MCPL_ERROR_CODES.UNKNOWN_SERVER, `model/info failed: ${errorMsg}`, msg as { type: string; requestId?: string });
    } else {
      ws.send(JSON.stringify({
        type: 'mcpl/error',
        code: MCPL_ERROR_CODES.UNKNOWN_SERVER,
        message: `model/info failed: ${errorMsg}`,
        inReplyTo: msg,
      }));
    }
  }
}

async function handleTriggerInference(
  ws: DelegateWebSocket,
  msg: TriggerInferenceMessage,
  userId: string,
  db: Database
): Promise<void> {
  try {
    const result = await triggerHandler.handleTrigger(msg, userId, db);
    ws.send(JSON.stringify(result));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[DelegateHandler] Trigger inference error:`, errorMsg);
    ws.send(JSON.stringify({
      type: 'trigger_inference_result',
      triggerId: msg.triggerId,
      success: false,
      error: errorMsg,
    }));
  }
}
