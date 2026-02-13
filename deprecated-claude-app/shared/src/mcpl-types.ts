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

/** MCPL capabilities that servers/delegates can advertise */
export type McplCapability =
  | 'context_hooks'
  | 'push_events'
  | 'inference_requests'
  | 'tool_management';

/** Feature set per serverId — what each MCP server is allowed to do */
export interface McplFeatureSet {
  contextHooks: boolean;
  pushEvents: boolean;
  inferenceRequests: boolean;
  toolManagement: boolean;
}

// =============================================================================
// Handshake
// =============================================================================

/** Sent by delegate after WebSocket connects */
export interface McplHello {
  type: 'mcpl/hello';
  protocolVersion: string;       // e.g. "mcpl-1.0"
  capabilities: McplCapability[];
  delegateId: string;
  delegateName: string;
  sessionId?: string;            // for session resume on reconnect
}

/** Sent by server in response to mcpl/hello */
export interface McplAck {
  type: 'mcpl/ack';
  sessionId: string;
  negotiatedCapabilities: McplCapability[];
  featureSets: Record<string, McplFeatureSet>;  // keyed by serverId
}

// =============================================================================
// Context Hooks
// =============================================================================

/** Server → Delegate: request context injections before inference */
export interface McplBeforeInferenceRequest {
  type: 'mcpl/beforeInference';
  requestId: string;
  conversationId: string;
  messagesSummary?: string;      // optional summary for context-aware injections
}

/** Delegate → Server: injections from a server */
export interface McplBeforeInferenceResponse {
  type: 'mcpl/beforeInference_response';
  requestId: string;
  injections: McplContextInjection[];
}

/** A single context injection from an MCPL server */
export interface McplContextInjection {
  serverId: string;
  position: 'system' | 'beforeUser' | 'afterUser';
  content: string;
}

/** Server → Delegate: notify after inference completes */
export interface McplAfterInferenceNotify {
  type: 'mcpl/afterInference';
  requestId: string;
  conversationId: string;
  responseSummary?: string;      // optional summary of the response
}

/** Delegate → Server: acknowledgement */
export interface McplAfterInferenceAck {
  type: 'mcpl/afterInference_ack';
  requestId: string;
}

// =============================================================================
// Push Events
// =============================================================================

/** Delegate → Server: external event that should trigger inference */
export interface McplPushEvent {
  type: 'mcpl/push_event';
  id: string;
  source: string;                // e.g. "github", "gitlab", "calendar"
  conversationId: string;
  eventType: string;             // e.g. "push", "issue_opened"
  payload: unknown;
  systemMessage: string;         // context message for the model
  idempotencyKey: string;        // deliveryId ?? sha256(eventType + payload + timeBucket5min)
  timestamp: string;             // ISO 8601
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
  source: string;
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
  serverId: string;
  conversationId: string;
  systemMessage?: string;
  userMessage: string;
  maxTokens?: number;
  stream?: boolean;            // Phase 7 Batch 5: request streaming response
}

/** Server → Delegate: inference result (also serves as stream completion signal) */
export interface McplInferenceResponse {
  type: 'mcpl/inference_response';
  requestId: string;
  success: boolean;
  content?: string;            // full text (for non-streaming, or verification for streaming)
  error?: string;
}

/** Server → Delegate: streaming inference chunk (Phase 7 — Batch 5).
 *  NO done field — completion is signaled by mcpl/inference_response. */
export interface McplInferenceChunk {
  type: 'mcpl/inference_chunk';
  requestId: string;
  chunkIndex: number;        // sequential from 0
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

/** Delegate → Server: dynamic featureSet update (full replacement, server computes diff).
 *  Use case: delegate reconnects or changes its MCP servers at runtime.
 *  Server diffs against previous featureSets — removed keys → auto-disable servers. */
export interface McplFeatureSetsChanged {
  type: 'mcpl/featureSets_changed';
  featureSets: Record<string, McplFeatureSet>;  // full replacement, server computes diff
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
  featureSet: string;         // supports wildcards via matchesPattern()
  capabilities: McplCapability[];
  label?: string;             // optional: only match specific label
}

// =============================================================================
// Scope Elevate (Phase 7 — Batch 4b)
// =============================================================================

/** Delegate → Server: MCP server requests capability elevation mid-operation */
export interface McplScopeElevateRequest {
  type: 'mcpl/scope_elevate_request';
  requestId: string;
  delegateId: string;
  serverId: string;
  conversationId: string;
  featureSet: string;          // which feature set label
  label: string;               // human-readable label
  requestedCapabilities: McplCapability[];
  reason: string;
  timeoutMs?: number;          // default 60s
}

/** Server → Delegate: scope elevate result */
export interface McplScopeElevateResult {
  type: 'mcpl/scope_elevate_result';
  requestId: string;
  approved: boolean;
  newCapabilities?: McplCapability[];
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
  requestedCapabilities: McplCapability[];
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
  activeCapabilities: McplCapability[];
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
  // no modelId — backend resolves from conversation context
  // MCP server doesn't know and shouldn't know which model is configured
}

export interface McplModelInfoResponse {
  type: 'mcpl/model_info_response';
  requestId: string;
  modelId: string;
  provider: string;
  contextWindow: number;
  outputTokenLimit: number;
  supportsThinking: boolean;
  supportsPrefill: boolean;
  capabilities: {
    imageInput: boolean;
    pdfInput: boolean;
    audioInput: boolean;
    videoInput: boolean;
    imageOutput: boolean;
    audioOutput: boolean;
  };
}
