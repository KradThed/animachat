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
  McplHelloMessage,
} from './protocol.js';
import { mcplSessionManager } from './mcpl-session-manager.js';
import { mcplHookManager } from '../services/mcpl-hook-manager.js';
import { mcplEventQueue } from '../services/mcpl-event-queue.js';
import { mcplInferenceBroker } from '../services/mcpl-inference-broker.js';
import { mcplStateManager } from '../services/mcpl-state-manager.js';
import { roomManager } from '../websocket/room-manager.js';
import { WebSocketTransport, ReliableChannel } from './mcpl-transport.js';
import type { McplTransport } from './mcpl-transport.js';
import type { ScopeChangeStatus, McplFeatureSet, McplCapability, McplScopePolicy } from '@deprecated-claude/shared';
import { expandWildcards, matchesPattern } from '../services/mcpl-wildcard.js';

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

const pendingScopeChanges = new Map<string, PendingScopeChange>();

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
  requestedCapabilities: McplCapability[];
  reason: string;
  userId: string;
  timeout: ReturnType<typeof setTimeout>;
}

/** Pending scope elevations keyed by dedupKey (delegateId::featureSet::label) */
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

/**
 * Evaluate scope policy for a request.
 * Blacklist checked first (deny takes priority over whitelist).
 * Blacklist uses some() — ANY matching capability → deny.
 * Whitelist uses every() — ALL requested must be covered → approve.
 */
function evaluateScopePolicy(
  userId: string,
  delegateId: string,
  featureSet: string,
  label: string,
  requestedCapabilities: McplCapability[]
): 'approve' | 'deny' | 'ask_user' {
  const policy = getScopePolicy(userId, delegateId);
  if (!policy) return 'ask_user';

  // Blacklist checked first (deny takes priority)
  for (const rule of policy.blacklist) {
    if (matchesPattern(rule.featureSet, featureSet)
        && rule.capabilities.some(c => requestedCapabilities.includes(c))
        && (!rule.label || rule.label === label)) {
      return 'deny';
    }
  }

  // Whitelist
  for (const rule of policy.whitelist) {
    if (matchesPattern(rule.featureSet, featureSet)
        && requestedCapabilities.every(c => rule.capabilities.includes(c))
        && (!rule.label || rule.label === label)) {
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

  // Send result to delegate (using latest requestId)
  const delegate = delegateManager.findDelegate(pending.userId, pending.delegateId);
  if (delegate) {
    const resultMsg: Record<string, unknown> = {
      type: 'mcpl/scope_elevate_result',
      requestId: pending.requestId,
      approved,
    };
    if (approved) {
      resultMsg.newCapabilities = pending.requestedCapabilities;
    }

    const transport = (delegate.ws as DelegateWebSocket).mcplTransport;
    if (transport) {
      transport.send(resultMsg);
    } else {
      delegate.ws.send(JSON.stringify(resultMsg));
    }
  }

  // "Remember this choice" → persist to scope policy
  if (remember) {
    const policy = getScopePolicy(pending.userId, pending.delegateId) || { whitelist: [], blacklist: [] };
    const rule = {
      featureSet: pending.featureSet,
      capabilities: pending.requestedCapabilities,
      label: pending.label,
    };

    if (approved) {
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
  mcplTransport?: McplTransport; // ReliableChannel after mcpl/hello
}

export async function delegateWebsocketHandler(
  ws: DelegateWebSocket,
  req: IncomingMessage,
  db: Database
): Promise<void> {
  // Parse query parameters
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const apiKey = url.searchParams.get('apiKey');

  // Strict delegateId validation
  const delegateIdResult = validateDelegateId(url.searchParams.get('delegateId'));
  if (!delegateIdResult.valid) {
    console.warn(`[DelegateHandler] Invalid delegateId: ${delegateIdResult.reason}`);
    ws.close(1008, delegateIdResult.reason);
    return;
  }
  const delegateId = delegateIdResult.delegateId;  // trimmed, validated

  if (!token && !apiKey) {
    console.warn('[DelegateHandler] Missing token or apiKey');
    ws.close(1008, 'Missing authentication (token or apiKey required)');
    return;
  }

  let userId: string;

  // Try API Key auth first (preferred)
  if (apiKey) {
    const keyResult = await db.validateDelegateApiKey(apiKey);
    if (!keyResult) {
      console.warn('[DelegateHandler] Invalid API key');
      ws.close(1008, 'Invalid API key (expired, revoked, or invalid)');
      return;
    }
    userId = keyResult.userId;
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
    console.warn(`[DelegateHandler] Name collision: "${delegateId}" already connected for user ${userId}`);
    ws.send(JSON.stringify({
      type: 'delegate_auth_result',
      success: false,
      error: `Delegate "${delegateId}" already connected. Use a different --delegate-id or disconnect the other.`,
    }));
    setTimeout(() => ws.close(4001, 'name_collision'), 150);
    return;
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

  // Single message path — ALL messages through transport.
  // NOTE: When ReliableChannel is created in handleMcplHello, RC constructor calls
  // transport.onMessage(handleIncoming), replacing this handler. After that:
  // messages flow: transport → RC.handleIncoming → RC.messageHandler → handleDelegateMessage
  transport.onMessage((msg) => {
    handleDelegateMessage(ws, transport, msg, userId, delegateId, sessionId, db);
  });

  // Handle disconnect — save RC state for resume
  transport.onClose((code, reason) => {
    console.log(`[DelegateHandler] Delegate "${delegateId}" disconnected (code: ${code}, reason: ${reason})`);

    // Save ReliableChannel state for session resume
    if (ws.mcplTransport && ws.mcplSessionId) {
      const rc = ws.mcplTransport as ReliableChannel;
      mcplSessionManager.saveReliableState(ws.mcplSessionId, rc.getState());
    }

    // Unregister MCPL services
    if (ws.mcplSessionId) {
      mcplHookManager.unregisterServer(sessionId);
    }

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

function handleDelegateMessage(
  ws: DelegateWebSocket,
  transport: McplTransport,
  msg: Record<string, unknown>,
  userId: string,
  delegateId: string,
  sessionId: string,
  db: Database
): void {
  const type = msg.type as string;
  if (!type) return;

  switch (type) {
    // Legacy messages
    case 'tool_manifest':
      handleToolManifest(ws, msg as unknown as ToolManifestMessage, userId, delegateId, sessionId);
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
    case 'mcpl/hello':
      handleMcplHello(ws, transport, msg as unknown as McplHelloMessage, userId, delegateId, sessionId, db);
      break;

    case 'mcpl/beforeInference_response':
      mcplHookManager.handleBeforeInferenceResponse(
        (msg as any).requestId,
        (msg as any).injections
      );
      break;

    case 'mcpl/afterInference_ack':
      // Acknowledged — no action needed for MVP
      break;

    case 'mcpl/push_event': {
      const pushMsg = msg as any;
      mcplEventQueue.push({
        id: pushMsg.id,
        source: pushMsg.source,
        conversationId: pushMsg.conversationId,
        eventType: pushMsg.eventType,
        payload: pushMsg.payload,
        systemMessage: pushMsg.systemMessage,
        idempotencyKey: pushMsg.idempotencyKey,
        timestamp: pushMsg.timestamp,
        delegateId,
        userId,
      });
      break;
    }

    case 'mcpl/inference_request': {
      const infMsg = msg as any;
      mcplInferenceBroker.handleInferenceRequest({
        requestId: infMsg.requestId,
        serverId: infMsg.serverId,
        conversationId: infMsg.conversationId,
        systemMessage: infMsg.systemMessage,
        userMessage: infMsg.userMessage,
        maxTokens: infMsg.maxTokens,
        stream: infMsg.stream,
        delegateId,
        userId,
        transport: ws.mcplTransport || transport,
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
      // Phase 7 Batch 2b: set conversation state (fire-and-forget)
      const stateMsg = msg as any;
      mcplStateManager.setUserId(stateMsg.conversationId, userId);
      mcplStateManager.setState(stateMsg.conversationId, stateMsg.state);
      break;
    }

    case 'mcpl/state_patch': {
      // Phase 7 Batch 2b: apply JSON Patch to conversation state
      const patchMsg = msg as any;
      mcplStateManager.setUserId(patchMsg.conversationId, userId);
      const patchResult = mcplStateManager.applyPatch(patchMsg.conversationId, patchMsg.patch);
      const patchResponse = {
        type: 'mcpl/state_patch_result',
        requestId: patchMsg.requestId,
        success: patchResult.success,
        ...(patchResult.error ? { error: patchResult.error } : {}),
      };
      const patchTransport = ws.mcplTransport || transport;
      patchTransport.send(patchResponse);
      break;
    }

    case 'mcpl/state_rollback': {
      const rollbackMsg = msg as any;
      const rollbackTransport = ws.mcplTransport || transport;
      mcplStateManager.setUserId(rollbackMsg.conversationId, userId);

      // Phase 1: can we roll back?
      const check = mcplStateManager.canRollback(
        rollbackMsg.conversationId,
        rollbackMsg.checkpointId,
      );

      if (!check.exists) {
        rollbackTransport.send({
          type: 'mcpl/state_response',
          requestId: rollbackMsg.requestId,
          state: null,
          rolledBack: false,
          error: check.error === 'expired' ? 'checkpoint_expired'
               : check.error === 'unknown' ? 'checkpoint_unknown'
               : 'no_checkpoints',
        });
        break;
      }

      // Phase 2: commit (host-managed -> always succeeds if node exists)
      const result = mcplStateManager.commitRollback(
        rollbackMsg.conversationId,
        check.checkpointId,
      );

      if (result.success) {
        rollbackTransport.send({
          type: 'mcpl/state_response',
          requestId: rollbackMsg.requestId,
          state: mcplStateManager.getState(rollbackMsg.conversationId) ?? null,
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
      // Phase 7 Batch 2b: get current state
      const getMsg = msg as any;
      const currentState = mcplStateManager.getState(getMsg.conversationId) ?? null;
      const getResponse = {
        type: 'mcpl/state_response',
        requestId: getMsg.requestId,
        state: currentState,
      };
      const getTransport = ws.mcplTransport || transport;
      getTransport.send(getResponse);
      break;
    }

    case 'mcpl/checkpoint_list': {
      const listMsg = msg as any;
      const listTransport = ws.mcplTransport || transport;
      const checkpointResult = mcplStateManager.getCheckpoints(listMsg.conversationId);

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
  sessionId: string
): void {
  // NOTE: msg.delegateId is IGNORED — handshake delegateId is canonical.
  // Prevents delegate from "renaming" itself inside a manifest message.
  const delegateName = delegateId.toLowerCase();  // normalize for namespacing

  console.log(`[DelegateHandler] Tool manifest from "${delegateId}" (namespace: ${delegateName}): ${msg.tools.length} tools`);

  // Update tools in delegate manager (uses original delegateId for WS routing)
  delegateManager.updateTools(sessionId, msg.tools as any);

  // Clean old tools before registering new ones (handles re-manifest with changed tool set)
  toolRegistry.unregisterDelegateTools(userId, delegateName);

  // Resolve serverId for each tool based on its serverName.
  // Tools without serverName get a default serverId for the delegate.
  const toolsWithServerId = msg.tools.map(t => ({
    ...t,
    serverId: delegateManager.getOrCreateServerId(
      delegateId,
      (t as any).serverName || '_default'
    ),
  }));

  // Register tools in tool registry with prefixed names
  toolRegistry.registerDelegateTools(
    userId,
    delegateName,     // normalized (lowercase) for registry keys
    delegateId,       // original case for display
    toolsWithServerId as any,
    async (originalToolName: string, input: Record<string, unknown>) => {
      // Phase 7 Batch 4c: Resolve scopeContext from tool's serverId → session featureSets
      let scopeCtx: { featureSet: string; activeCapabilities: string[] } | undefined;
      const tool = toolsWithServerId.find(t => t.name === originalToolName);
      if (tool?.serverId) {
        const session = mcplSessionManager.getSessionForDelegate(userId, delegateId);
        if (session?.featureSets) {
          const featureSet = Object.keys(session.featureSets).find(
            key => key === tool.serverId || matchesPattern(key, tool.serverId!)
          );
          if (featureSet) {
            const fs = session.featureSets[featureSet];
            scopeCtx = {
              featureSet,
              activeCapabilities: Object.entries(fs)
                .filter(([, v]) => v === true)
                .map(([k]) => k),
            };
          }
        }
      }

      // No timeout here — timeout is controlled by executeWithTimeout() in ToolRegistry
      // which reads toolConfig.toolTimeout. DelegateManager has its own large safety-net timeout.
      return delegateManager.executeToolOnDelegate(
        delegateId,   // original delegateId for WS routing
        userId,
        { id: '', name: originalToolName, input },
        undefined,    // timeoutMs (default)
        scopeCtx,     // Phase 7 Batch 4c — scope tagging
      );
    }
  );

  // Acknowledge manifest receipt — include prefixed names so delegate knows what LLM sees
  ws.send(JSON.stringify({
    type: 'tool_manifest_ack',
    toolCount: msg.tools.length,
    tools: msg.tools.map(t => `${delegateName}__${t.name}`),
  }));
}

function handleToolCallResponse(msg: ToolCallResponseMessage): void {
  delegateManager.handleToolCallResponse(msg);
}

function handleMcplHello(
  ws: DelegateWebSocket,
  transport: McplTransport,
  msg: McplHelloMessage,
  userId: string,
  delegateId: string,
  _legacySessionId: string,
  db: Database
): void {
  console.log(`[DelegateHandler] MCPL hello from "${delegateId}" (protocol: ${msg.protocolVersion}, capabilities: ${msg.capabilities.join(', ')})`);

  // Try session resume if delegate sends a sessionId
  let session = msg.sessionId
    ? mcplSessionManager.resumeSession(msg.sessionId, userId)
    : null;

  const isResume = !!session;

  if (!session) {
    // Create new MCPL session
    const negotiated = mcplSessionManager.negotiateCapabilities(msg.capabilities);
    session = mcplSessionManager.createSession(delegateId, userId, negotiated, msg.protocolVersion);
  }

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

  ws.mcplTransport = reliable;

  // IMPORTANT: Set message handler BEFORE sending ack or resending buffered frames.
  // Otherwise responses to resent frames would be dropped (no handler).
  reliable.onMessage((innerMsg) => {
    handleDelegateMessage(ws, reliable, innerMsg, userId, delegateId, _legacySessionId, db);
  });

  // Send mcpl/ack (first framed message)
  const ackMsg: Record<string, unknown> = {
    type: 'mcpl/ack',
    sessionId: session.sessionId,
    negotiatedCapabilities: session.capabilities,
    featureSets: session.featureSets,
  };
  if (isResume && typeof (msg as any).lastReceivedSeq === 'number') {
    ackMsg.resumedFromSeq = (msg as any).lastReceivedSeq;
  }
  reliable.send(ackMsg);

  // Resend buffered frames on resume
  if (isResume && typeof (msg as any).lastReceivedSeq === 'number') {
    reliable.resendBufferedAfter((msg as any).lastReceivedSeq);
  }

  // Register hook servers if delegate supports context_hooks
  if (session.capabilities.includes('context_hooks')) {
    // Collect serverIds from featureSets where contextHooks is enabled
    const hookServerIds = Object.entries(session.featureSets)
      .filter(([, fs]) => fs.contextHooks)
      .map(([serverId]) => serverId);

    if (hookServerIds.length > 0) {
      mcplHookManager.registerServer(
        _legacySessionId, delegateId, userId, reliable, hookServerIds
      );
    }
  }

  console.log(`[DelegateHandler] MCPL ${isResume ? 'resumed' : 'new'} session for "${delegateId}" (session: ${session.sessionId}, capabilities: ${session.capabilities.join(', ')})`);
}

/**
 * Handle scope_elevate_request — MCP server requests capability elevation mid-operation.
 * Dedup by (delegateId, featureSet, label) — NOT by requestId.
 * Policy evaluation first: auto-approve/deny if policy exists, otherwise ask user.
 */
function handleScopeElevateRequest(
  ws: DelegateWebSocket,
  msg: {
    requestId: string;
    delegateId: string;
    serverId: string;
    conversationId: string;
    featureSet: string;
    label: string;
    requestedCapabilities: McplCapability[];
    reason: string;
    timeoutMs?: number;
  },
  userId: string,
  delegateId: string,
  db: Database
): void {
  const timeoutMs = msg.timeoutMs || 60_000;
  const dedupKey = makeScopeElevateDedupKey(delegateId, msg.featureSet, msg.label);

  // 1. Policy check first
  const policyResult = evaluateScopePolicy(userId, delegateId, msg.featureSet, msg.label, msg.requestedCapabilities);

  if (policyResult === 'approve') {
    // Auto-approve — send result immediately (no UI dialog)
    const transport = ws.mcplTransport;
    const response = {
      type: 'mcpl/scope_elevate_result',
      requestId: msg.requestId,
      approved: true,
      newCapabilities: msg.requestedCapabilities,
    };
    if (transport) {
      transport.send(response);
    } else {
      ws.send(JSON.stringify(response));
    }
    console.log(`[DelegateHandler] Scope elevate auto-approved (policy) for ${delegateId}:${msg.featureSet}:${msg.label}`);
    return;
  }

  if (policyResult === 'deny') {
    // Auto-deny — send result immediately (no UI dialog)
    const transport = ws.mcplTransport;
    const response = {
      type: 'mcpl/scope_elevate_result',
      requestId: msg.requestId,
      approved: false,
    };
    if (transport) {
      transport.send(response);
    } else {
      ws.send(JSON.stringify(response));
    }
    console.log(`[DelegateHandler] Scope elevate auto-denied (policy) for ${delegateId}:${msg.featureSet}:${msg.label}`);
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
    label: msg.label,
    requestedCapabilities: msg.requestedCapabilities,
    reason: msg.reason,
    userId,
    timeout,
  });

  // Broadcast approval dialog to user's UI
  roomManager.broadcastToUser(userId, {
    type: 'mcpl/scope_elevate_approval_needed',
    requestId: msg.requestId,
    conversationId: msg.conversationId,
    delegateId,
    delegateName: delegateId,
    featureSet: msg.featureSet,
    label: msg.label,
    requestedCapabilities: msg.requestedCapabilities,
    reason: msg.reason,
    timeout: Math.round(timeoutMs / 1000),
  });

  console.log(`[DelegateHandler] Scope elevate requested by ${delegateId}: ${msg.featureSet}/${msg.label} → ${msg.requestedCapabilities.join(', ')}`);
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
 * Handle featureSets/changed — delegate reports updated featureSets (full replacement).
 * Server computes diff, auto-disables removed servers, updates session + hook manager.
 */
function handleFeatureSetsChanged(
  ws: DelegateWebSocket,
  msg: { featureSets: Record<string, McplFeatureSet> },
  userId: string,
  delegateId: string,
  sessionId: string,
  db: Database
): void {
  // Session guard: if no MCPL session exists (message arrived before hello), ignore
  if (!ws.mcplSessionId) {
    console.warn(`[DelegateHandler] featureSets_changed before mcpl/hello from "${delegateId}", ignoring`);
    return;
  }

  const session = mcplSessionManager.getSession(ws.mcplSessionId);
  if (!session) {
    console.warn(`[DelegateHandler] featureSets_changed for unknown session ${ws.mcplSessionId}, ignoring`);
    return;
  }

  // Collect known serverIds from delegate's tools (for wildcard expansion)
  const delegate = delegateManager.findDelegate(userId, delegateId);
  const knownServerIds: string[] = [];
  if (delegate) {
    const serverNameSet = new Set<string>();
    for (const tool of delegate.tools) {
      serverNameSet.add((tool as any).serverName || '_default');
    }
    for (const serverName of serverNameSet) {
      knownServerIds.push(delegateManager.getOrCreateServerId(delegateId, serverName));
    }
  }

  // Expand wildcards in new featureSets
  const newFeatureSets = knownServerIds.length > 0
    ? expandWildcards(msg.featureSets, knownServerIds)
    : msg.featureSets;

  // Diff: find removed serverIds
  const oldKeys = new Set(Object.keys(session.featureSets));
  const newKeys = new Set(Object.keys(newFeatureSets));
  const removedIds = [...oldKeys].filter(k => !newKeys.has(k));

  // Auto-disable removed servers
  if (removedIds.length > 0) {
    console.log(`[DelegateHandler] featureSets_changed: auto-disabling removed servers: ${removedIds.join(', ')}`);
    // Note: we don't have conversationId here (featureSets apply across conversations).
    // For now, log the removal. Per-conversation disable happens when tools are rebuilt.
    // The session update below removes the featureSets entry, so the server's tools
    // won't appear in future tool list computations.
  }

  // Update session featureSets
  mcplSessionManager.updateFeatureSets(ws.mcplSessionId, newFeatureSets);

  // Update hook manager registrations
  if (session.capabilities.includes('context_hooks')) {
    const hookServerIds = Object.entries(newFeatureSets)
      .filter(([, fs]) => fs.contextHooks)
      .map(([serverId]) => serverId);

    if (hookServerIds.length > 0) {
      mcplHookManager.updateServerIds(sessionId, hookServerIds);
    } else {
      mcplHookManager.unregisterServer(sessionId);
    }
  }

  // Rebuild user toolset hash (triggers re-computation of available tools)
  toolRegistry.computeUserToolsetHash(userId);

  console.log(`[DelegateHandler] featureSets_changed for "${delegateId}": ${Object.keys(newFeatureSets).length} server(s) (removed: ${removedIds.length})`);
}

/**
 * Handle model/info request — delegate asks what model is active in conversation.
 * Backend resolves from conversation context, returns capabilities from ModelLoader.
 */
async function handleModelInfoRequest(
  ws: DelegateWebSocket,
  msg: { requestId: string },
  userId: string,
  db: Database
): Promise<void> {
  try {
    // Resolve conversation's model from delegate session
    // For now, use the default model — full conversation context resolution
    // will be added when conversationId is available on the delegate session.
    const { ModelLoader } = await import('../config/model-loader.js');
    const modelLoader = ModelLoader.getInstance();

    // Try to get the conversation model via the delegate session's associated conversation
    // Fallback: use default model from config
    const { ConfigLoader } = await import('../config/loader.js');
    const configLoader = ConfigLoader.getInstance();
    const defaultModelId = await configLoader.getDefaultModel();

    const model = await modelLoader.getModelById(defaultModelId, userId);

    if (!model) {
      const transport = ws.mcplTransport;
      const response = {
        type: 'mcpl/model_info_response',
        requestId: msg.requestId,
        modelId: defaultModelId,
        provider: 'unknown',
        contextWindow: 0,
        outputTokenLimit: 0,
        supportsThinking: false,
        supportsPrefill: false,
        capabilities: {
          imageInput: false,
          pdfInput: false,
          audioInput: false,
          videoInput: false,
          imageOutput: false,
          audioOutput: false,
        },
      };
      if (transport) {
        transport.send(response);
      } else {
        ws.send(JSON.stringify(response));
      }
      return;
    }

    const response = {
      type: 'mcpl/model_info_response',
      requestId: msg.requestId,
      modelId: model.id,
      provider: model.provider,
      contextWindow: model.contextWindow,
      outputTokenLimit: model.outputTokenLimit,
      supportsThinking: model.supportsThinking ?? false,
      supportsPrefill: model.supportsPrefill ?? false,
      capabilities: {
        imageInput: model.capabilities?.imageInput ?? false,
        pdfInput: model.capabilities?.pdfInput ?? false,
        audioInput: model.capabilities?.audioInput ?? false,
        videoInput: model.capabilities?.videoInput ?? false,
        imageOutput: model.capabilities?.imageOutput ?? false,
        audioOutput: model.capabilities?.audioOutput ?? false,
      },
    };

    const transport = ws.mcplTransport;
    if (transport) {
      transport.send(response);
    } else {
      ws.send(JSON.stringify(response));
    }
  } catch (err) {
    console.error('[DelegateHandler] Failed to handle model_info_request:', err);
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
