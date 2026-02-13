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
  timeout: z.number().default(30000),
  scopeContext: z.object({                    // Phase 7 Batch 4c — scope tagging
    featureSet: z.string(),
    activeCapabilities: z.array(z.string()),
  }).optional(),
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

const McplFeatureSetSchema = z.object({
  contextHooks: z.boolean(),
  pushEvents: z.boolean(),
  inferenceRequests: z.boolean(),
  toolManagement: z.boolean(),
});

/** Delegate → Server: MCPL hello (first message after WS connect) */
export const McplHelloMessageSchema = z.object({
  type: z.literal('mcpl/hello'),
  protocolVersion: z.string(),
  capabilities: z.array(McplCapabilitySchema),
  delegateId: z.string(),
  delegateName: z.string(),
  sessionId: z.string().optional(),
});

/** Server → Delegate: MCPL ack (response to hello) */
export const McplAckMessageSchema = z.object({
  type: z.literal('mcpl/ack'),
  sessionId: z.string(),
  negotiatedCapabilities: z.array(McplCapabilitySchema),
  featureSets: z.record(McplFeatureSetSchema),
});

/** Delegate → Server: context hook response */
export const McplBeforeInferenceResponseSchema = z.object({
  type: z.literal('mcpl/beforeInference_response'),
  requestId: z.string(),
  injections: z.array(z.object({
    serverId: z.string(),
    position: z.enum(['system', 'beforeUser', 'afterUser']),
    content: z.string(),
  })),
});

/** Delegate → Server: after inference ack */
export const McplAfterInferenceAckSchema = z.object({
  type: z.literal('mcpl/afterInference_ack'),
  requestId: z.string(),
});

/** Delegate → Server: push event from external trigger */
export const McplPushEventMessageSchema = z.object({
  type: z.literal('mcpl/push_event'),
  id: z.string(),
  source: z.string(),
  conversationId: z.string(),
  eventType: z.string(),
  payload: z.unknown(),
  systemMessage: z.string(),
  idempotencyKey: z.string(),
  timestamp: z.string(),
});

/** Delegate → Server: MCP server requests inference from host */
export const McplInferenceRequestMessageSchema = z.object({
  type: z.literal('mcpl/inference_request'),
  requestId: z.string(),
  serverId: z.string(),
  conversationId: z.string(),
  systemMessage: z.string().optional(),
  userMessage: z.string(),
  maxTokens: z.number().optional(),
  stream: z.boolean().optional(),
});

/** Server → Delegate: streaming inference chunk (Phase 7 — Batch 5) */
export const McplInferenceChunkMessageSchema = z.object({
  type: z.literal('mcpl/inference_chunk'),
  requestId: z.string(),
  chunkIndex: z.number(),
  delta: z.string(),
});

/** Delegate → Server: scope change request */
export const McplScopeChangeRequestMessageSchema = z.object({
  type: z.literal('mcpl/scope_change_request'),
  requestId: z.string(),
  serverId: z.string(),
  requestedCapabilities: z.array(z.string()),
  reason: z.string(),
});

/** Server → Delegate: connect a new MCP server (type only — NOT in union yet) */
export const McplConnectServerMessageSchema = z.object({
  type: z.literal('mcpl/connect_server'),
  url: z.string(),
  serverName: z.string().optional(),
});

/** Delegate → Server: scope elevate request (Phase 7 — Batch 4) */
export const McplScopeElevateRequestMessageSchema = z.object({
  type: z.literal('mcpl/scope_elevate_request'),
  requestId: z.string(),
  delegateId: z.string(),
  serverId: z.string(),
  conversationId: z.string(),
  featureSet: z.string(),
  label: z.string(),
  requestedCapabilities: z.array(McplCapabilitySchema),
  reason: z.string(),
  timeoutMs: z.number().optional(),
});

/** Server → Delegate: scope elevate result */
export const McplScopeElevateResultMessageSchema = z.object({
  type: z.literal('mcpl/scope_elevate_result'),
  requestId: z.string(),
  approved: z.boolean(),
  newCapabilities: z.array(McplCapabilitySchema).optional(),
});

/** Delegate → Server: dynamic featureSet update (Phase 7 — Batch 2a) */
export const McplFeatureSetsChangedMessageSchema = z.object({
  type: z.literal('mcpl/featureSets_changed'),
  featureSets: z.record(McplFeatureSetSchema),
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
});

/** Server → Delegate: model capabilities response */
export const McplModelInfoResponseMessageSchema = z.object({
  type: z.literal('mcpl/model_info_response'),
  requestId: z.string(),
  modelId: z.string(),
  provider: z.string(),
  contextWindow: z.number(),
  outputTokenLimit: z.number(),
  supportsThinking: z.boolean(),
  supportsPrefill: z.boolean(),
  capabilities: z.object({
    imageInput: z.boolean(),
    pdfInput: z.boolean(),
    audioInput: z.boolean(),
    videoInput: z.boolean(),
    imageOutput: z.boolean(),
    audioOutput: z.boolean(),
  }),
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

export type DelegateToServerMessage = z.infer<typeof DelegateToServerMessageSchema>;
export type ServerToDelegateMessage = z.infer<typeof ServerToDelegateMessageSchema>;
