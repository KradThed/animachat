/**
 * MCPL (Model Context Protocol Live) Type Definitions
 *
 * Shared types for the MCPL extension protocol.
 * These types are mirrored in animachat-delegate/src/mcpl-types.ts
 * (delegate is a separate repo and cannot import from this package).
 *
 * Keep both files in sync manually for MVP.
 * Later: extract to a published @animachat/mcpl-types package.
 */

// =============================================================================
// Capabilities
// =============================================================================

/** Individual capability keys for internal feature set tracking */
export type McplCapability =
  | 'context_hooks'
  | 'push_events'
  | 'inference_requests'
  | 'tool_management';

/** Spec §5.1: Nested capabilities object for hello/ack wire protocol */
export interface McplCapabilities {
  version?: string;
  pushEvents?: boolean;
  contextHooks?: {
    beforeInference?: boolean;
    afterInference?: boolean | { blocking?: boolean };
  };
  inferenceRequest?: {
    streaming?: boolean;
  };
  modelInfo?: boolean;
  featureSets?: boolean;
  toolManagement?: boolean;
}

/** Feature set per serverId — what each MCP server is allowed to do.
 *  §6.2: uses are dotted capability strings (e.g. "pushEvents", "contextHooks.beforeInference"). */
export interface McplFeatureSet {
  description?: string;
  uses: string[];
  scoped?: boolean;
  rollback?: boolean;
  ownerServerId?: string;
}

/** Internal canonical declaration (session manager layer 1) */
export interface DeclaredFeatureSet {
  name: string;
  ownerServerId?: string;
  rawUses: string[];
  description?: string;
  scoped?: boolean;
  rollback?: boolean;
}

/** Scope state per feature set (session manager layer 3) */
export interface FeatureSetScopeState {
  whitelist?: string[];
  blacklist?: string[];
}

/** Wire shape for capabilities.experimental.mcpl in hello/ack only.
 *  featureSets here is the dict of declarations, NOT the boolean capability flag. */
export interface McplHandshakeCapabilities {
  version?: string;
  pushEvents?: boolean;
  contextHooks?: {
    beforeInference?: boolean;
    afterInference?: boolean | { blocking?: boolean };
  };
  inferenceRequest?: { streaming?: boolean };
  modelInfo?: boolean;
  featureSets?: Record<string, McplFeatureSet>;
  toolManagement?: boolean;
}

/** Map dotted uses strings → internal McplCapability flags.
 *  §6.2: uses are spec-defined dotted strings; capabilities are internal 4-value enum. */
const USES_TO_CAPABILITY: Record<string, McplCapability | undefined> = {
  'pushEvents':                   'push_events',
  'push_events':                  'push_events',
  'contextHooks':                 'context_hooks',
  'contextHooks.beforeInference': 'context_hooks',
  'contextHooks.afterInference':  'context_hooks',
  'context_hooks':                'context_hooks',
  'inferenceRequest':             'inference_requests',
  'inferenceRequests':            'inference_requests',
  'inference_requests':           'inference_requests',
  'tools':                        'tool_management',
  'toolManagement':               'tool_management',
  'tool_management':              'tool_management',
};

/**
 * Spec §6.2 declaration values for uses arrays — exhaustive.
 * Reference set for conformance assertions only; NOT used for quarantine.
 * Includes capabilities this host does not implement (channels.*).
 */
export const SPEC_DECLARATION_USES = new Set([
  'pushEvents',
  'contextHooks.beforeInference',
  'contextHooks.afterInference',
  'inferenceRequest',
  'tools',
  'channels.publish',
  'channels.observe',
]);

/**
 * Host-supported declaration uses — the subset of SPEC_DECLARATION_USES
 * that this host actually implements.
 * Quarantine is based on this set.
 *
 * - Does NOT include `toolManagement` — stays in USES_TO_CAPABILITY only
 *   (runtime compatibility, not a declaration value).
 * - Strict subset of SPEC_DECLARATION_USES.
 * - Separate from USES_TO_CAPABILITY — that is a runtime compatibility map
 *   that also accepts legacy aliases (push_events, context_hooks, etc.).
 */
export const HOST_SUPPORTED_DECLARATION_USES = new Set([
  'pushEvents',
  'contextHooks.beforeInference',
  'contextHooks.afterInference',
  'inferenceRequest',
  'tools',
]);

/**
 * Validate uses strings against host-supported declarations.
 * Returns { supported, unsupported } partitions.
 * - Spec-valid but unsupported by host (channels.publish) → unsupported
 * - Not spec-valid at all (foo.bar) → unsupported
 * - Legacy aliases (push_events) → unsupported (strict declaration only)
 */
export function validateDeclarationUses(uses: string[]): {
  supported: string[];
  unsupported: string[];
} {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const u of uses) {
    if (HOST_SUPPORTED_DECLARATION_USES.has(u)) {
      supported.push(u);
    } else {
      unsupported.push(u);
    }
  }
  return { supported, unsupported };
}

/** Resolve dotted uses strings to internal McplCapability flags. */
export function resolveCapabilities(uses: string[]): McplCapability[] {
  const caps = new Set<McplCapability>();
  for (const u of uses) {
    const cap = USES_TO_CAPABILITY[u];
    if (cap) caps.add(cap);
  }
  return [...caps];
}

// =============================================================================
// Handshake
// =============================================================================

/** H5: MCP initialize request with experimental.mcpl (spec §3.1, §5.1) */
export interface McplHello {
  type: 'initialize';
  protocolVersion: string;       // e.g. "2024-11-05"
  clientInfo?: { name: string; version?: string };
  capabilities?: {
    experimental?: { mcpl?: McplHandshakeCapabilities };
  };
  _mcpl?: {
    delegateId?: string;
    sessionId?: string;          // for session resume on reconnect
    lastReceivedSeq?: number;    // RC resume
  };
}

/** H5: MCP initializeResult with experimental.mcpl (spec §5.2) */
export interface McplAck {
  type: 'mcpl/ack';
  protocolVersion: string;
  serverInfo?: { name: string; version?: string };
  capabilities?: {
    experimental?: { mcpl?: McplHandshakeCapabilities };
  };
  _mcpl?: {
    sessionId: string;
    resumedFromSeq?: number;
  };
}

// =============================================================================
// Context Hooks
// =============================================================================

/** Model metadata per spec Section 10.1 */
export interface McplModelInfo {
  id: string;
  vendor: string;
  contextWindow: number;
  capabilities: string[];        // e.g. ["vision", "tools", "computer_use"]
}

/** Server → Delegate: request context injections before inference (spec Section 10.1) */
export interface McplBeforeInferenceRequest {
  type: 'mcpl/beforeInference';
  requestId: string;
  // Spec fields (top-level):
  inferenceId: string;           // unique identifier for this inference
  conversationId: string;        // persistent across turns
  turnIndex?: number;            // 0-indexed turn number
  userMessage?: string | null;   // user input (null for continued generation)
  model?: McplModelInfo;         // current model metadata
  // Extensions:
  messagesSummary?: string;      // optional summary for context-aware injections
  userId?: string;
  isSubAgent?: boolean;
}

/** Delegate → Server: injections from a server (spec Section 10.2) */
export interface McplBeforeInferenceResponse {
  type: 'mcpl/beforeInference_response';
  requestId: string;
  featureSet?: string;                       // spec: declaring feature set
  contextInjections: McplContextInjection[]; // spec: was 'injections'
  abort?: boolean;        // Gap 3: if true, host should NOT run inference
  abortReason?: string;   // Gap 3: human-readable reason for abort
}

/** Content block for multimodal injections (Spec Section 10.3) */
export interface McplContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource';
  text?: string;               // for type: 'text'
  data?: string;               // base64 for type: 'image' or 'audio'
  mimeType?: string;           // e.g. 'image/png', 'audio/wav'
  uri?: string;                // for type: 'audio' (alt source) or 'resource'
}

/** A single context injection (spec Section 10.4) */
export interface McplContextInjection {
  namespace: string;             // spec: server-defined namespace (was: serverId)
  position: 'system' | 'beforeUser' | 'afterUser';
  content: string | McplContentBlock[];  // spec: string or ContentBlock[]
  metadata?: Record<string, unknown>;    // spec: arbitrary metadata
}

/**
 * F4 fix: Normalize injection content to string.
 * Handles both string content and McplContentBlock[] (multimodal).
 * Without this, .join('\n') on McplContentBlock[] produces "[object Object]".
 */
export function normalizeInjectionContent(content: string | McplContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');
}

/**
 * F5 fix: Get the byte size of injection content for budget enforcement.
 * For string: character count. For McplContentBlock[]: serialized JSON length
 * (accounts for base64 image data that would trivially pass a char-count budget).
 */
export function getInjectionContentSize(content: string | McplContentBlock[]): number {
  if (typeof content === 'string') return content.length;
  return JSON.stringify(content).length;
}

/** Server → Delegate: notify after inference completes (spec Section 10.5) */
export interface McplAfterInferenceNotify {
  type: 'mcpl/afterInference';
  requestId: string;
  // Spec fields (top-level):
  inferenceId?: string;          // unique identifier for this inference
  conversationId: string;        // persistent across turns
  turnIndex?: number;            // 0-indexed turn number
  userMessage?: string;          // user input that triggered inference
  assistantMessage?: string;     // the assistant's response content
  model?: McplModelInfo;         // model metadata (spec: object, was: string)
  usage?: {                      // token usage from inference
    inputTokens?: number;
    outputTokens?: number;
  };
  // Extensions:
  responseSummary?: string;      // optional summary of the response
  userId?: string;
  isSubAgent?: boolean;
}

/** Delegate → Server: acknowledgement (legacy, kept for backward compat) */
export interface McplAfterInferenceAck {
  type: 'mcpl/afterInference_ack';
  requestId: string;
}

/** Delegate → Server: afterInference response (spec Section 10.5, blocking) */
export interface McplAfterInferenceResponse {
  type: 'mcpl/afterInference_response';
  requestId: string;
  featureSet?: string;                       // spec: declaring feature set
  modifiedResponse?: string;                 // if set, host should use this instead of original response
  metadata?: Record<string, unknown>;        // spec: arbitrary metadata
}

// =============================================================================
// Push Events
// =============================================================================

/** Delegate → Server: external event that should trigger inference */
export interface McplPushEvent {
  type: 'mcpl/push_event';
  eventId: string;                         // spec: unique event identifier (was: id)
  featureSet: string;                      // spec: declaring feature set
  timestamp: string;                       // spec: ISO 8601
  origin?: Record<string, unknown>;        // spec: provenance metadata object (was: string)
  payload: unknown;                        // spec: { content: ContentBlock[] }; we accept any shape as extension
  // Extensions beyond spec:
  conversationId: string;
  eventType: string;             // e.g. "push", "issue_opened"
  systemMessage: string;         // context message for the model
  idempotencyKey: string;        // deliveryId ?? sha256(eventType + payload + timeBucket5min)
}

/** Server → Delegate: push event response (spec Section 9.3) */
export interface McplPushEventResponse {
  type: 'mcpl/push_event_response';
  requestId: string;
  accepted: boolean;
  inferenceId?: string;          // spec: ID of inference triggered by this event
  reason?: string;               // spec: rejection reason
}

/** Server → Client: queue update notification */
export interface McplQueueUpdate {
  type: 'mcpl/queue_update';
  conversationId: string;
  queue: McplQueueEntry[];
  totalCount: number;
}

/** A single entry in the push event queue */
export interface McplQueueEntry {
  id: string;
  featureSet: string;  // F8a: was 'source'
  eventType: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'rate_limited' | 'duplicate_ignored';
  timestamp: string;
  systemMessage: string;
}

// =============================================================================
// Queue Control (Client → Server)
// =============================================================================

export interface McplPauseQueue {
  type: 'mcpl/pause_queue';
  conversationId: string;
}

export interface McplResumeQueue {
  type: 'mcpl/resume_queue';
  conversationId: string;
}

// =============================================================================
// Inference Requests (Phase 6)
// =============================================================================

/** Delegate → Server: MCP server requests inference from host */
export interface McplInferenceRequest {
  type: 'mcpl/inference_request';
  requestId: string;
  featureSet: string;            // spec: declaring feature set (was: serverId)
  conversationId?: string;       // spec: optional
  stream?: boolean;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;  // F17: multi-turn context
  preferences?: {                // spec Section 11.2: generation preferences
    maxTokens?: number;
    temperature?: number;
  };
  // Extensions beyond spec:
  systemMessage?: string;
  userMessage?: string;          // F17: optional (legacy, use messages[] instead)
  parentChainId?: string;        // chain tracking for recursion prevention
  parentFrameId?: string;        // frame tracking for recursion prevention
}

/** Server → Delegate: inference result (also serves as stream completion signal) */
export interface McplInferenceResponse {
  type: 'mcpl/inference_response';
  requestId: string;
  content?: string;            // full text (for non-streaming, or verification for streaming)
  model?: string;              // model ID used for inference (e.g. "claude-sonnet-4-20250514")
  finishReason?: 'end_turn' | 'max_tokens' | 'stop_sequence';  // spec enum (no 'error')
  usage?: {                    // token usage counters
    inputTokens: number;
    outputTokens: number;
  };
}

/** Server → Delegate: streaming inference chunk (Phase 7 — Batch 5).
 *  NO done field — completion is signaled by mcpl/inference_response. */
export interface McplInferenceChunk {
  type: 'mcpl/inference_chunk';
  requestId: string;
  index: number;             // spec: sequential chunk index from 0 (was: chunkIndex)
  delta: string;             // text delta
}

// =============================================================================
// Scope Change (Phase 6)
// =============================================================================

/** Delegate → Server: request to change capabilities */
export interface McplScopeChangeRequest {
  type: 'mcpl/scope_change_request';
  requestId: string;
  serverId: string;
  conversationId: string;
  url: string;
  serverName: string;
  requestedCapabilities: McplCapability[];
  reason: string;
  payload?: Record<string, unknown>;  // F12: arbitrary data for UI display
}

/** Server → Client: approval needed */
export interface McplScopeChangeApprovalNeeded {
  type: 'mcpl/scope_change_approval_needed';
  requestId: string;
  conversationId: string;
  delegateId: string;
  delegateName: string;
  requestedCapabilities: {
    servers: Array<{ url: string; name: string; reason: string }>;
  };
  timeout: number;
}

/** Client → Server: approval decision */
export interface McplScopeChangeDecision {
  type: 'mcpl/scope_change_approved' | 'mcpl/scope_change_denied';
  requestId: string;
}

/** Server → Delegate: scope change result */
export interface McplScopeChangeResult {
  type: 'mcpl/scope_change_result';
  requestId: string;
  approved: boolean;
  newCapabilities?: McplCapability[];
  scoped?: boolean;  // F12: true = scoped operation per spec
}

// =============================================================================
// Connect Server (Phase R1 — message type only, NOT a tool)
// =============================================================================

/** Server → Delegate: request to connect a new MCP server */
export interface McplConnectServer {
  type: 'mcpl/connect_server';
  url: string;
  serverName?: string;
}

// =============================================================================
// Connect Server Result (Phase 6d)
// =============================================================================

/** Delegate → Server: outcome of addServer() after scope change approval */
export interface McplConnectServerResult {
  type: 'mcpl/connect_server_result';
  requestId: string;
  url: string;
  success: boolean;
  serverId?: string;
  tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  error?: string;
}

/** Terminal statuses for scope change requests */
export type ScopeChangeStatus =
  | 'denied_by_user'
  | 'denied_by_timeout'
  | 'approved_connected'
  | 'approved_failed';

// =============================================================================
// Event Store Types (schema-free JSONL — these are the contract)
// =============================================================================

export interface McplServerEnabledChangedEvent {
  serverId: string;
  delegateId: string;
  enabled: boolean;
  source: 'agent' | 'user';
}

export interface McplPushEventReceivedEvent {
  id: string;
  source: string;
  eventType: string;
  status: string;
}

export interface McplPushEventProcessedEvent {
  id: string;
  success: boolean;
  error?: string;
}

export interface McplInferenceRequestCompletedEvent {
  requestId: string;
  serverId: string;
  timestamp: string;
}

export interface McplScopeChangeResolvedEvent {
  requestId: string;
  delegateId: string;
  serverId: string;
  status: ScopeChangeStatus;
  url?: string;
  error?: string;
}

// =============================================================================
// Feature Sets Changed (Phase 7 — Batch 2a)
// =============================================================================

/** Delegate → Server: dynamic featureSet update (delta semantics).
 *  Use case: delegate adds/removes MCP servers at runtime.
 *  F15: delta format with legacy fallback. */
export interface McplFeatureSetsChanged {
  type: 'mcpl/featureSets_changed';
  added?: Record<string, McplFeatureSet>;     // new or updated featureSets
  removed?: string[];                          // feature set names to remove
  featureSets?: Record<string, McplFeatureSet>;  // legacy: full replacement fallback
}

// =============================================================================
// Feature Sets Update (F16 — Server→Delegate notification)
// =============================================================================

/** Server → Delegate: notify about capability changes the server made.
 *  Sent after scope elevation approval, admin action, etc.
 *  Spec Section 5.3, 6.7: enabled/disabled are featureSet name lists. */
export interface McplFeatureSetsUpdate {
  type: 'mcpl/featureSets_update';
  enabled?: string[];                          // featureSet names that were enabled
  disabled?: string[];                         // featureSet names that were disabled
  scopes?: Record<string, { whitelist: string[]; blacklist: string[] }>;  // per-featureSet scope rules
}

// =============================================================================
// Scope Policy (Phase 7 — Batch 4a)
// =============================================================================

/** Per-user, per-delegate scope policy (whitelist/blacklist rules) */
export interface McplScopePolicy {
  whitelist: McplScopePolicyRule[];   // auto-approve matching requests
  blacklist: McplScopePolicyRule[];   // auto-deny matching requests
}

export interface McplScopePolicyRule {
  featureSet: string;         // supports wildcards via matchesFeatureSetRule() in policy layer only
  uses: string[];             // §6.2 dotted uses strings
  label?: string;             // optional: only match specific label
  /** S-1 fix: feature set names that were known when this wildcard rule was approved.
   *  New names matching the wildcard require re-approval. */
  approvedFeatureSetNames?: string[];
  /** S-3 fix: timestamp when this rule was created (ms since epoch).
   *  Rules older than TTL are ignored. */
  createdAt?: number;
}

// =============================================================================
// Scope Elevate (Phase 7 — Batch 4b)
// =============================================================================

/** Delegate → Server: MCP server requests capability elevation mid-operation */
export interface McplScopeElevateRequest {
  type: 'mcpl/scope_elevate_request';
  requestId: string;
  featureSet: string;
  scope: {                     // spec Section 7.4: nested scope object
    label: string;
    payload?: Record<string, unknown>;
  };
  // Extensions beyond spec:
  delegateId: string;
  serverId: string;
  conversationId: string;
  requestedUses: string[];     // §6.2 dotted uses strings
  reason: string;
  timeoutMs?: number;
}

/** Server → Delegate: scope elevate result (spec Section 7.5) */
export interface McplScopeElevateResult {
  type: 'mcpl/scope_elevate_result';
  requestId: string;
  approved: boolean;
  payload?: Record<string, unknown>;  // spec: echo back payload
  reason?: string;                    // spec: denial reason
  // Extensions beyond spec:
  newUses?: string[];                 // §6.2 dotted uses strings
  scoped?: boolean;
}

/** Server → Client: scope elevate approval needed (sent to user's UI) */
export interface McplScopeElevateApprovalNeeded {
  type: 'mcpl/scope_elevate_approval_needed';
  requestId: string;
  conversationId: string;
  delegateId: string;
  delegateName: string;
  featureSet: string;
  label: string;
  requestedUses: string[];     // §6.2 dotted uses strings
  reason: string;
  timeout: number;
}

/** Client → Server: scope elevate decision from user */
export interface McplScopeElevateDecision {
  type: 'mcpl/scope_elevate_approved' | 'mcpl/scope_elevate_denied';
  requestId: string;
  remember?: boolean;  // true → persist to scope policy
}

// =============================================================================
// Scope Context (Phase 7 — Batch 4c — Scope Tagging)
// =============================================================================

/** Scope context attached to tool calls for MCP server awareness */
export interface McplScopeContext {
  featureSet: string;
  activeCapabilities: string[];  // §6.2 dotted uses strings
}

// =============================================================================
// State Management (Phase 7 — Batch 2b)
// =============================================================================

/** Delegate → Server: set (replace) conversation state */
export interface McplStateSet {
  type: 'mcpl/state_set';
  requestId: string;             // for consistency + future ack, costs 0 effort
  conversationId: string;
  state: Record<string, unknown>;
}

/** Delegate → Server: apply JSON Patch (RFC 6902) to conversation state */
export interface McplStatePatch {
  type: 'mcpl/state_patch';
  requestId: string;
  conversationId: string;
  patch: unknown[];  // JSON Patch operations array
}

/** Server → Delegate: result of state_patch */
export interface McplStatePatchResult {
  type: 'mcpl/state_patch_result';
  requestId: string;
  success: boolean;
  error?: string;
}

/** Delegate → Server: rollback to checkpoint (Phase 8: optional target) */
export interface McplStateRollback {
  type: 'mcpl/state_rollback';
  requestId: string;
  conversationId: string;
  checkpointId?: string;    // Phase 8: target checkpoint (omit = parent of current)
}

/** Delegate → Server: get current state */
export interface McplStateGet {
  type: 'mcpl/state_get';
  requestId: string;
  conversationId: string;
}

/** Server → Delegate: current state response (for state_get and state_rollback) */
export interface McplStateResponse {
  type: 'mcpl/state_response';
  requestId: string;
  state: Record<string, unknown> | null;
  rolledBack?: boolean;  // true if this is a rollback result
  checkpointId?: string;    // Phase 8: which checkpoint was rolled back to
  error?: 'checkpoint_expired' | 'checkpoint_unknown' | 'no_checkpoints' | 'rollback_failed' | 'rollback_denied';
  // rollback_denied reserved for 8b (server-managed state refuses rollback)
}

// =============================================================================
// Checkpoint List (Phase 8)
// =============================================================================

/** Delegate → Server: query checkpoint tree */
export interface McplCheckpointList {
  type: 'mcpl/checkpoint_list';
  requestId: string;
  conversationId: string;
}

/** Server → Delegate: checkpoint tree structure */
export interface McplCheckpointListResponse {
  type: 'mcpl/checkpoint_list_response';
  requestId: string;
  current: string;
  checkpoints: Array<{
    id: string;
    parent: string | null;
    children: string[];
    createdAt: number;
    isCurrent: boolean;
    label?: string;           // human-readable checkpoint description
    mutationCount?: number;   // patches since parent checkpoint
  }>;
}

// =============================================================================
// Model Info (Phase 7 — Batch 1b)
// =============================================================================

/** Maps to spec's model/info (Section 12) JSON-RPC method.
 *  Uses MCPL message framing for consistency with other delegate↔backend messages. */
export interface McplModelInfoRequest {
  type: 'mcpl/model_info_request';
  requestId: string;
  conversationId?: string;  // optional: resolve conversation's active model
}

export interface McplModelInfoResponse {
  type: 'mcpl/model_info_response';
  requestId: string;
  id: string;                        // spec: model ID (was: modelId)
  vendor: string;                    // spec: model vendor (was: provider)
  contextWindow: number;
  capabilities: string[];            // spec: string array e.g. ['vision','pdf','audio'] (was: object)
  // Extensions beyond spec:
  outputTokenLimit?: number;
  supportsThinking?: boolean;
  supportsPrefill?: boolean;
}
