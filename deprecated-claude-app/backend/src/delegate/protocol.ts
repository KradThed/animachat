// Vendored from @deprecated-claude/backend
// Original location: node_modules/@deprecated-claude/backend/src/delegate/protocol.ts

/**
 * Delegate Protocol Types
 *
 * Defines the WebSocket message protocol between the server and delegate apps.
 * All messages are JSON with a discriminated 'type' field.
 */

import { z } from 'zod';

// =============================================================================
// Tool Definition Schema (Membrane-compatible)
// =============================================================================

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  }),
  serverName: z.string().optional(),
  featureSet: z.string().optional(),  // explicit featureSet from delegate
});

// =============================================================================
// Delegate → Server Messages
// =============================================================================

export const DelegateAuthMessageSchema = z.object({
  type: z.literal('delegate_auth'),
  version: z.string().default('1.0'),
  token: z.string(),
  delegateId: z.string(),
  capabilities: z.array(z.string()).default([]),
});

export const ToolManifestMessageSchema = z.object({
  type: z.literal('tool_manifest'),
  delegateId: z.string(),
  tools: z.array(ToolDefinitionSchema),
  timestamp: z.string().optional(),
});

export const ToolCallResponseMessageSchema = z.object({
  type: z.literal('tool_call_response'),
  requestId: z.string(),
  toolUseId: z.string(),
  result: z.object({
    content: z.union([z.string(), z.array(z.any())]),
    isError: z.boolean().default(false),
  }),
});

export const TriggerInferenceMessageSchema = z.object({
  type: z.literal('trigger_inference'),
  triggerId: z.string(),
  source: z.string(),
  conversationId: z.string().optional(),
  participantId: z.string().optional(),
  context: z.record(z.unknown()).default({}),
  systemMessage: z.string().optional(),
});

export const DelegatePingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp: z.number(),
});

// =============================================================================
// Server → Delegate Messages
// =============================================================================

export const DelegateAuthResultMessageSchema = z.object({
  type: z.literal('delegate_auth_result'),
  success: z.boolean(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
});

export const ToolCallRequestMessageSchema = z.object({
  type: z.literal('tool_call_request'),
  requestId: z.string(),
  conversationId: z.string(),
  messageId: z.string().optional(),
  tool: z.object({
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
  timeout: z.number().default(300_000),
  scopeContext: z.object({                    // Phase 7 Batch 4c — scope tagging
    featureSet: z.string(),
    activeCapabilities: z.array(z.string()),
  }).optional(),
  inferenceContext: z.object({               // Fix #5 — chain/frame tracking for recursion prevention
    chainId: z.string(),
    frameId: z.string(),
  }).optional(),
  // H7: Spec §8.4 — state/checkpoint at params top level (not in mcplState wrapper)
  state: z.record(z.unknown()).nullable().optional(),
  checkpoint: z.string().optional(),           // H7: was mcplState.checkpointId
  stateVersion: z.number().optional(),         // S-6: CAS version for conflict detection
});

export const TriggerInferenceResultMessageSchema = z.object({
  type: z.literal('trigger_inference_result'),
  triggerId: z.string(),
  success: z.boolean(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  response: z.string().optional(),
  error: z.string().optional(),
});

export const DelegatePongMessageSchema = z.object({
  type: z.literal('pong'),
  timestamp: z.number(),
});

// =============================================================================
// MCPL Protocol Messages
// =============================================================================

const McplCapabilitySchema = z.enum(['context_hooks', 'push_events', 'inference_requests', 'tool_management']);

/** Spec §5.1: Nested capabilities object for hello/ack wire protocol */
const McplCapabilitiesSchema = z.object({
  version: z.string().optional(),
  pushEvents: z.boolean().optional(),
  contextHooks: z.object({
    beforeInference: z.boolean().optional(),
    afterInference: z.union([z.boolean(), z.object({ blocking: z.boolean().optional() })]).optional(),
  }).optional(),
  inferenceRequest: z.object({
    streaming: z.boolean().optional(),
  }).optional(),
  modelInfo: z.boolean().optional(),
  featureSets: z.boolean().optional(),
  toolManagement: z.boolean().optional(),
}).passthrough();

const McplFeatureSetSchema = z.object({
  description: z.string().optional(),
  uses: z.array(z.string()),  // §6.2: dotted uses strings
  scoped: z.boolean().optional(),
  rollback: z.boolean().optional(),
  ownerServerId: z.string().optional(),
});

/** Wire shape for capabilities.experimental.mcpl in hello/ack.
 *  featureSets here is dict of declarations, NOT boolean. */
const McplHandshakeCapabilitiesSchema = z.object({
  version: z.string().optional(),
  pushEvents: z.boolean().optional(),
  contextHooks: z.object({
    beforeInference: z.boolean().optional(),
    afterInference: z.union([z.boolean(), z.object({ blocking: z.boolean().optional() })]).optional(),
  }).optional(),
  inferenceRequest: z.object({
    streaming: z.boolean().optional(),
  }).optional(),
  modelInfo: z.boolean().optional(),
  featureSets: z.record(McplFeatureSetSchema).optional(),  // dict, not boolean
  toolManagement: z.boolean().optional(),
}).passthrough();

/** H5: MCP initialize request with experimental.mcpl (spec §3.1, §5.1) */
export const McplHelloMessageSchema = z.object({
  type: z.literal('initialize'),
  protocolVersion: z.string(),
  clientInfo: z.object({
    name: z.string(),
    version: z.string().optional(),
  }).optional(),
  capabilities: z.object({
    experimental: z.object({
      mcpl: McplHandshakeCapabilitiesSchema.optional(),
    }).optional(),
  }).optional(),
  _mcpl: z.object({
    delegateId: z.string().optional(),
    sessionId: z.string().optional(),
    lastReceivedSeq: z.number().optional(),
  }).optional(),
});

/** H5: MCP initializeResult with experimental.mcpl (spec §5.2) */
export const McplAckMessageSchema = z.object({
  type: z.literal('mcpl/ack'),
  protocolVersion: z.string(),
  serverInfo: z.object({
    name: z.string(),
    version: z.string().optional(),
  }).optional(),
  capabilities: z.object({
    experimental: z.object({
      mcpl: McplHandshakeCapabilitiesSchema.optional(),
    }).optional(),
  }).optional(),
  _mcpl: z.object({
    sessionId: z.string(),
    resumedFromSeq: z.number().optional(),
  }).optional(),
});

/** Spec Section 10.3: content block for multimodal injections */
export const McplContentBlockSchema = z.object({
  type: z.enum(['text', 'image', 'audio', 'resource']),
  text: z.string().optional(),
  data: z.string().optional(),       // base64 for image or audio
  mimeType: z.string().optional(),
  uri: z.string().optional(),        // for audio (alt source) or resource
});

/** Delegate → Server: context hook response (spec Section 10.2) */
export const McplBeforeInferenceResponseSchema = z.object({
  type: z.literal('mcpl/beforeInference_response'),
  requestId: z.string(),
  featureSet: z.string().optional(),           // spec: declaring feature set
  contextInjections: z.array(z.object({        // spec: was 'injections'
    namespace: z.string(),                     // spec: was 'serverId'
    position: z.enum(['system', 'beforeUser', 'afterUser']),
    content: z.union([z.string(), z.array(McplContentBlockSchema)]),
    metadata: z.record(z.unknown()).optional(), // spec: arbitrary metadata
  })),
});

/** Delegate → Server: after inference ack */
export const McplAfterInferenceAckSchema = z.object({
  type: z.literal('mcpl/afterInference_ack'),
  requestId: z.string(),
});

/** Delegate → Server: after inference response (spec Section 10.5) */
export const McplAfterInferenceResponseSchema = z.object({
  type: z.literal('mcpl/afterInference_response'),
  requestId: z.string(),
  featureSet: z.string().optional(),
  modifiedResponse: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Delegate → Server: push event from external trigger */
export const McplPushEventMessageSchema = z.object({
  type: z.literal('mcpl/push_event'),
  requestId: z.string(),                     // F8c: push_event is a request (expects push_event_response)
  eventId: z.string(),                       // spec: unique event identifier (was: id)
  featureSet: z.string(),                    // spec: declaring feature set
  timestamp: z.string(),                     // spec: ISO 8601
  origin: z.record(z.unknown()).optional(),  // spec: provenance metadata object
  payload: z.unknown(),                      // spec: { content: ContentBlock[] }; accept any shape
  // Extensions:
  conversationId: z.string(),
  eventType: z.string(),
  systemMessage: z.string(),
  idempotencyKey: z.string(),
});

/** Delegate → Server: MCP server requests inference from host */
export const McplInferenceRequestMessageSchema = z.object({
  type: z.literal('mcpl/inference_request'),
  requestId: z.string(),
  featureSet: z.string(),                  // spec: declaring feature set (was: serverId)
  conversationId: z.string().optional(),   // spec: optional
  stream: z.boolean().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
  preferences: z.object({                  // spec Section 11.2: generation preferences
    maxTokens: z.number().optional(),
    temperature: z.number().optional(),
  }).optional(),
  systemMessage: z.string().optional(),
  userMessage: z.string().optional(),
  parentChainId: z.string().optional(),
  parentFrameId: z.string().optional()
});

/** Server → Delegate: inference result */
export const McplInferenceResponseMessageSchema = z.object({
  type: z.literal('mcpl/inference_response'),
  requestId: z.string(),
  content: z.string().optional(),
  model: z.string().optional(),
  finishReason: z.enum(['end_turn', 'max_tokens', 'stop_sequence']).optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }).optional(),
});

/** Server → Delegate: streaming inference chunk (Phase 7 — Batch 5) */
export const McplInferenceChunkMessageSchema = z.object({
  type: z.literal('mcpl/inference_chunk'),
  requestId: z.string(),
  index: z.number(),                         // spec: sequential chunk index (was: chunkIndex)
  delta: z.string(),
});

/** Delegate → Server: scope change request */
export const McplScopeChangeRequestMessageSchema = z.object({
  type: z.literal('mcpl/scope_change_request'),
  requestId: z.string(),
  serverId: z.string(),
  requestedCapabilities: z.array(z.string()),
  reason: z.string(),
  conversationId: z.string().optional(),
  url: z.string().optional(),
  serverName: z.string().optional(),
  payload: z.record(z.unknown()).optional(),  // F12: arbitrary data for UI display
});

/** Server → Delegate: scope change result */
export const McplScopeChangeResultMessageSchema = z.object({
  type: z.literal('mcpl/scope_change_result'),
  requestId: z.string(),
  approved: z.boolean(),
  scoped: z.boolean().optional(),  // F12: per spec Section 7
});

/** Model metadata per spec Section 10.1 */
export const McplModelInfoSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  contextWindow: z.number(),
  capabilities: z.array(z.string()),
});

/** Server → Delegate: before-inference hook (spec Section 10.1, flat params) */
export const McplBeforeInferenceMessageSchema = z.object({
  type: z.literal('mcpl/beforeInference'),
  requestId: z.string(),
  // Spec fields (top-level):
  inferenceId: z.string(),
  conversationId: z.string(),
  turnIndex: z.number().optional(),
  userMessage: z.string().nullable().optional(),
  model: McplModelInfoSchema.optional(),
  // Extensions:
  messagesSummary: z.string().optional(),
  userId: z.string().optional(),
  isSubAgent: z.boolean().optional(),
});

/** Server → Delegate: after-inference hook (spec Section 10.5, flat params) */
export const McplAfterInferenceMessageSchema = z.object({
  type: z.literal('mcpl/afterInference'),
  requestId: z.string(),
  // Spec fields (top-level):
  inferenceId: z.string().optional(),
  conversationId: z.string(),
  turnIndex: z.number().optional(),
  userMessage: z.string().optional(),
  assistantMessage: z.string().optional(),
  model: McplModelInfoSchema.optional(),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
  }).optional(),
  // Extensions:
  responseSummary: z.string().optional(),
  userId: z.string().optional(),
  isSubAgent: z.boolean().optional(),
});

/** Server → Delegate: connect a new MCP server */
export const McplConnectServerMessageSchema = z.object({
  type: z.literal('mcpl/connect_server'),
  url: z.string(),
  serverName: z.string().optional(),
});

/** Delegate → Server: scope elevate request (spec Section 7.4) */
export const McplScopeElevateRequestMessageSchema = z.object({
  type: z.literal('mcpl/scope_elevate_request'),
  requestId: z.string(),
  featureSet: z.string(),
  scope: z.object({                              // spec: nested scope object
    label: z.string(),
    payload: z.record(z.unknown()).optional(),
  }),
  // Extensions:
  delegateId: z.string(),
  serverId: z.string(),
  conversationId: z.string(),
  requestedUses: z.array(z.string()),            // §6.2 dotted uses strings
  reason: z.string(),
  timeoutMs: z.number().optional(),
});

/** Server → Delegate: scope elevate result (spec Section 7.5) */
export const McplScopeElevateResultMessageSchema = z.object({
  type: z.literal('mcpl/scope_elevate_result'),
  requestId: z.string(),
  approved: z.boolean(),
  payload: z.record(z.unknown()).optional(),     // spec: echo back payload
  reason: z.string().optional(),                 // spec: denial reason
  // Extensions:
  scoped: z.boolean().optional(),
  newUses: z.array(z.string()).optional(),        // §6.2 dotted uses strings
});

/** Delegate → Server: dynamic featureSet update (F15: delta semantics + legacy fallback) */
export const McplFeatureSetsChangedMessageSchema = z.object({
  type: z.literal('mcpl/featureSets_changed'),
  added: z.record(McplFeatureSetSchema).optional(),
  removed: z.array(z.string()).optional(),
  featureSets: z.record(McplFeatureSetSchema).optional(),  // legacy: full replacement
});

/** F16: Server → Delegate: notify about capability changes the server made (Spec Section 5.3, 6.7) */
export const McplFeatureSetsUpdateMessageSchema = z.object({
  type: z.literal('mcpl/featureSets_update'),
  enabled: z.array(z.string()).optional(),   // featureSet names that were enabled
  disabled: z.array(z.string()).optional(),  // featureSet names that were disabled
  scopes: z.record(z.object({               // per-featureSet scope rules
    whitelist: z.array(z.string()),
    blacklist: z.array(z.string()),
  })).optional(),
});

/** Delegate → Server: set conversation state (Phase 7 — Batch 2b) */
export const McplStateSetMessageSchema = z.object({
  type: z.literal('mcpl/state_set'),
  requestId: z.string(),
  conversationId: z.string(),
  state: z.record(z.unknown()),
});

/** Delegate → Server: apply JSON Patch to conversation state */
export const McplStatePatchMessageSchema = z.object({
  type: z.literal('mcpl/state_patch'),
  requestId: z.string(),
  conversationId: z.string(),
  patch: z.array(z.unknown()),
});

/** Server → Delegate: result of state_patch */
export const McplStatePatchResultMessageSchema = z.object({
  type: z.literal('mcpl/state_patch_result'),
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

/** Delegate → Server: rollback to checkpoint (Phase 8: optional target) */
export const McplStateRollbackMessageSchema = z.object({
  type: z.literal('mcpl/state_rollback'),
  requestId: z.string(),
  conversationId: z.string(),
  checkpointId: z.string().optional(),  // Phase 8: target checkpoint (omit = parent of current)
});

/** Delegate → Server: get current state */
export const McplStateGetMessageSchema = z.object({
  type: z.literal('mcpl/state_get'),
  requestId: z.string(),
  conversationId: z.string(),
});

/** Server → Delegate: state response (for state_get and state_rollback) */
export const McplStateResponseMessageSchema = z.object({
  type: z.literal('mcpl/state_response'),
  requestId: z.string(),
  state: z.record(z.unknown()).nullable(),
  rolledBack: z.boolean().optional(),
  checkpointId: z.string().optional(),  // Phase 8: which checkpoint was rolled back to
  error: z.enum(['checkpoint_expired', 'checkpoint_unknown', 'no_checkpoints', 'rollback_failed', 'rollback_denied']).optional(),
});

/** Delegate → Server: request model capabilities (Phase 7 — maps to spec model/info) */
export const McplModelInfoRequestMessageSchema = z.object({
  type: z.literal('mcpl/model_info_request'),
  requestId: z.string(),
  conversationId: z.string().optional(),
});

/** Server → Delegate: model capabilities response (spec Section 12.2) */
export const McplModelInfoResponseMessageSchema = z.object({
  type: z.literal('mcpl/model_info_response'),
  requestId: z.string(),
  id: z.string(),                              // spec (was: modelId)
  vendor: z.string(),                          // spec (was: provider)
  contextWindow: z.number(),
  capabilities: z.array(z.string()),           // spec: string[] (was: object)
  // Extensions:
  outputTokenLimit: z.number().optional(),
  supportsThinking: z.boolean().optional(),
  supportsPrefill: z.boolean().optional(),
});

/** Delegate → Server: query checkpoint tree (Phase 8) */
export const McplCheckpointListMessageSchema = z.object({
  type: z.literal('mcpl/checkpoint_list'),
  requestId: z.string(),
  conversationId: z.string(),
});

/** Server → Delegate: checkpoint tree structure (Phase 8) */
export const McplCheckpointListResponseMessageSchema = z.object({
  type: z.literal('mcpl/checkpoint_list_response'),
  requestId: z.string(),
  current: z.string(),
  checkpoints: z.array(z.object({
    id: z.string(),
    parent: z.string().nullable(),
    children: z.array(z.string()),
    createdAt: z.number(),
    isCurrent: z.boolean(),
    label: z.string().optional(),
    mutationCount: z.number().optional(),
  })),
});

/** Delegate → Server: outcome of addServer() after scope change approval */
export const McplConnectServerResultMessageSchema = z.object({
  type: z.literal('mcpl/connect_server_result'),
  requestId: z.string(),
  url: z.string(),
  success: z.boolean(),
  serverId: z.string().optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.unknown(),
  })).optional(),
  error: z.string().optional(),
});

/** Server → Delegate: MCPL error (access denied, rate limited, etc.) */
export const McplErrorMessageSchema = z.object({
  type: z.literal('mcpl/error'),
  code: z.number(),                    // JSON-RPC numeric error codes (-32001..-32005, -32700..-32603)
  message: z.string(),                 // "Conversation not found or access denied" (never reveal existence)
  retryAfterMs: z.number().optional(), // present when code === -32002 (rate limited) — delegate uses for backoff
  inReplyTo: z.object({                // correlation — otherwise error is orphaned in logs
    type: z.string(),                  // original message type
    requestId: z.string().optional(),
    seq: z.number().optional(),
  }),
});

// =============================================================================
// JSON-RPC 2.0 Envelope Schemas (used by McplCodec for wire validation)
// =============================================================================

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});

// =============================================================================
// Union Types
// =============================================================================

/** All messages that a delegate can send to the server */
export const DelegateToServerMessageSchema = z.discriminatedUnion('type', [
  DelegateAuthMessageSchema,
  ToolManifestMessageSchema,
  ToolCallResponseMessageSchema,
  TriggerInferenceMessageSchema,
  DelegatePingMessageSchema,
  // MCPL messages
  McplHelloMessageSchema,
  McplBeforeInferenceResponseSchema,
  McplAfterInferenceAckSchema,
  McplAfterInferenceResponseSchema,
  McplPushEventMessageSchema,
  McplInferenceRequestMessageSchema,
  McplScopeChangeRequestMessageSchema,
  McplConnectServerResultMessageSchema,
  McplModelInfoRequestMessageSchema,
  McplFeatureSetsChangedMessageSchema,
  McplStateSetMessageSchema,
  McplStatePatchMessageSchema,
  McplStateRollbackMessageSchema,
  McplStateGetMessageSchema,
  McplScopeElevateRequestMessageSchema,
  McplCheckpointListMessageSchema,
]);

/** All messages that the server can send to a delegate */
export const ServerToDelegateMessageSchema = z.discriminatedUnion('type', [
  DelegateAuthResultMessageSchema,
  ToolCallRequestMessageSchema,
  TriggerInferenceResultMessageSchema,
  DelegatePongMessageSchema,
  // MCPL messages
  McplAckMessageSchema,
  McplModelInfoResponseMessageSchema,
  McplStatePatchResultMessageSchema,
  McplStateResponseMessageSchema,
  McplScopeElevateResultMessageSchema,
  McplInferenceChunkMessageSchema,
  McplCheckpointListResponseMessageSchema,
  McplErrorMessageSchema,
  McplBeforeInferenceMessageSchema,
  McplAfterInferenceMessageSchema,
  McplConnectServerMessageSchema,
  McplFeatureSetsUpdateMessageSchema,
]);

// =============================================================================
// Inferred Types
// =============================================================================

export type DelegateAuthMessage = z.infer<typeof DelegateAuthMessageSchema>;
export type ToolManifestMessage = z.infer<typeof ToolManifestMessageSchema>;
export type ToolCallResponseMessage = z.infer<typeof ToolCallResponseMessageSchema>;
export type TriggerInferenceMessage = z.infer<typeof TriggerInferenceMessageSchema>;
export type DelegatePingMessage = z.infer<typeof DelegatePingMessageSchema>;

export type DelegateAuthResultMessage = z.infer<typeof DelegateAuthResultMessageSchema>;
export type ToolCallRequestMessage = z.infer<typeof ToolCallRequestMessageSchema>;
export type TriggerInferenceResultMessage = z.infer<typeof TriggerInferenceResultMessageSchema>;
export type DelegatePongMessage = z.infer<typeof DelegatePongMessageSchema>;

// MCPL types
export type McplHelloMessage = z.infer<typeof McplHelloMessageSchema>;
export type McplAckMessage = z.infer<typeof McplAckMessageSchema>;
export type McplBeforeInferenceResponse = z.infer<typeof McplBeforeInferenceResponseSchema>;
export type McplAfterInferenceAckMessage = z.infer<typeof McplAfterInferenceAckSchema>;
export type McplPushEventMessage = z.infer<typeof McplPushEventMessageSchema>;
export type McplInferenceRequestMessage = z.infer<typeof McplInferenceRequestMessageSchema>;
export type McplScopeChangeRequestMessage = z.infer<typeof McplScopeChangeRequestMessageSchema>;
export type McplConnectServerMessage = z.infer<typeof McplConnectServerMessageSchema>;
export type McplConnectServerResultMessage = z.infer<typeof McplConnectServerResultMessageSchema>;
export type McplModelInfoRequestMessage = z.infer<typeof McplModelInfoRequestMessageSchema>;
export type McplModelInfoResponseMessage = z.infer<typeof McplModelInfoResponseMessageSchema>;
export type McplFeatureSetsChangedMessage = z.infer<typeof McplFeatureSetsChangedMessageSchema>;
export type McplFeatureSetsUpdateMessage = z.infer<typeof McplFeatureSetsUpdateMessageSchema>;
export type McplStateSetMessage = z.infer<typeof McplStateSetMessageSchema>;
export type McplStatePatchMessage = z.infer<typeof McplStatePatchMessageSchema>;
export type McplStatePatchResultMessage = z.infer<typeof McplStatePatchResultMessageSchema>;
export type McplStateRollbackMessage = z.infer<typeof McplStateRollbackMessageSchema>;
export type McplStateGetMessage = z.infer<typeof McplStateGetMessageSchema>;
export type McplStateResponseMessage = z.infer<typeof McplStateResponseMessageSchema>;
export type McplScopeElevateRequestMessage = z.infer<typeof McplScopeElevateRequestMessageSchema>;
export type McplScopeElevateResultMessage = z.infer<typeof McplScopeElevateResultMessageSchema>;
export type McplInferenceChunkMessage = z.infer<typeof McplInferenceChunkMessageSchema>;
export type McplCheckpointListMessage = z.infer<typeof McplCheckpointListMessageSchema>;
export type McplCheckpointListResponseMessage = z.infer<typeof McplCheckpointListResponseMessageSchema>;
export type McplErrorMessage = z.infer<typeof McplErrorMessageSchema>;
export type McplModelInfo = z.infer<typeof McplModelInfoSchema>;
export type McplBeforeInferenceMessage = z.infer<typeof McplBeforeInferenceMessageSchema>;
export type McplAfterInferenceMessage = z.infer<typeof McplAfterInferenceMessageSchema>;

export type DelegateToServerMessage = z.infer<typeof DelegateToServerMessageSchema>;
export type ServerToDelegateMessage = z.infer<typeof ServerToDelegateMessageSchema>;
