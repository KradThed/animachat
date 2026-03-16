/**
 * MCPL JSON-RPC 2.0 Wire Format Types & Constants
 *
 * Defines the JSON-RPC 2.0 envelope types and metadata maps used by McplCodec
 * to convert between internal message format ({ type, requestId, ...fields })
 * and JSON-RPC 2.0 wire format ({ jsonrpc, method/id/result/error, params }).
 *
 * Shared between backend and delegate (manually synced for delegate repo).
 */

// =============================================================================
// JSON-RPC 2.0 Message Types
// =============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// =============================================================================
// Response Type Mapping
// =============================================================================

/**
 * Maps internal response `type` → the request `type` it responds to.
 *
 * Used by McplCodec to detect that a message is a response (not a request)
 * and wrap it as { jsonrpc, id, result } instead of { jsonrpc, method, params }.
 */
export const RESPONSE_TYPE_MAP: Record<string, string> = {
  // H5: mcpl/ack maps to 'initialize' — hello/ack bypass codec (sent raw), kept for response type detection
  'mcpl/ack':                      'initialize',
  'mcpl/beforeInference_response': 'mcpl/beforeInference',
  // afterInference has two response types (ack = MVP, response = full with modifiedResponse).
  // Both map to the same request. REQUEST_TO_RESPONSE_TYPE takes first match (afterInference_response).
  // At runtime, pendingRequests id-based lookup disambiguates correctly.
  'mcpl/afterInference_response':  'mcpl/afterInference',
  'mcpl/afterInference_ack':       'mcpl/afterInference',
  'mcpl/inference_response':       'mcpl/inference_request',
  'mcpl/scope_change_result':      'mcpl/scope_change_request',
  'mcpl/scope_elevate_result':     'mcpl/scope_elevate_request',
  'mcpl/state_set_result':         'mcpl/state_set',
  'mcpl/state_patch_result':       'mcpl/state_patch',
  // state_response serves both state_get and state_rollback.
  // pendingRequests tracks the original method, so decode uses the correct requestId.
  'mcpl/state_response':           'mcpl/state_get',
  'mcpl/checkpoint_list_response': 'mcpl/checkpoint_list',
  'mcpl/model_info_response':      'mcpl/model_info_request',
  'mcpl/push_event_response':      'mcpl/push_event',  // F8c fix: push_event is a request, not notification
  // NOTE: connect_server_result is NOT here — it's a notification (no correlated request id).
  // connect_server is also a notification. The requestId in connect_server_result
  // refers to the original scope_change_request, not to connect_server.
};

/**
 * Reverse map: request method → response type.
 * Built from RESPONSE_TYPE_MAP at module load.
 */
export const REQUEST_TO_RESPONSE_TYPE: Record<string, string> = {};
for (const [responseType, requestMethod] of Object.entries(RESPONSE_TYPE_MAP)) {
  if (!REQUEST_TO_RESPONSE_TYPE[requestMethod]) {
    REQUEST_TO_RESPONSE_TYPE[requestMethod] = responseType;
  }
}
// BUG 3 fix: state_rollback also produces state_response (same as state_get)
REQUEST_TO_RESPONSE_TYPE['mcpl/state_rollback'] = 'mcpl/state_response';

// =============================================================================
// Notification Types
// =============================================================================

/**
 * Internal message types that are fire-and-forget (no response expected).
 * On the wire: JSON-RPC notification (no `id` field).
 */
export const NOTIFICATION_TYPES = new Set([
  // F8c fix: push_event removed — it's a request (expects push_event_response), not a notification
  'mcpl/featureSets_changed',
  'mcpl/featureSets_update',    // F16: server→delegate capability change notification
  'mcpl/inference_chunk',
  'mcpl/connect_server',
  'mcpl/connect_server_result',  // BUG 1 fix: result is also notification (requestId = scope_change's, not connect_server's)
]);

// =============================================================================
// F1 fix: Wire Method Name Translation (MCPL Spec v0.4.1-draft)
//
// Internal names (mcpl/...) stay unchanged in application code.
// Only the codec translates on encode/decode.
// =============================================================================

/** Standard spec methods (MCPL v0.4.1-draft) */
export const SPEC_INTERNAL_TO_WIRE: Record<string, string> = {
  'mcpl/hello':                    'initialize',
  'mcpl/ack':                      'initializeResult',
  'mcpl/beforeInference':          'context/beforeInference',
  'mcpl/afterInference':           'context/afterInference',
  'mcpl/beforeInference_response': 'context/beforeInferenceResult',
  'mcpl/afterInference_response':  'context/afterInferenceResult',
  'mcpl/afterInference_ack':       'context/afterInferenceAck',
  'mcpl/push_event':               'push/event',
  'mcpl/push_event_response':      'push/eventResult',
  'mcpl/inference_request':        'inference/request',
  'mcpl/inference_response':       'inference/response',
  'mcpl/inference_chunk':          'inference/chunk',
  'mcpl/state_set':                'state/set',
  'mcpl/state_set_result':         'state/setResult',
  'mcpl/state_patch':              'state/patch',
  'mcpl/state_patch_result':       'state/patchResult',
  'mcpl/state_get':                'state/get',
  'mcpl/state_response':           'state/response',
  'mcpl/state_rollback':           'state/rollback',
  'mcpl/checkpoint_list':          'state/checkpoints',
  'mcpl/checkpoint_list_response': 'state/checkpointsResult',
  'mcpl/featureSets_changed':      'featureSets/changed',
  'mcpl/featureSets_update':       'featureSets/update',
  'mcpl/scope_elevate_request':    'scope/elevate',
  'mcpl/scope_elevate_result':     'scope/elevateResult',
  'mcpl/model_info_request':       'model/info',
  'mcpl/model_info_response':      'model/infoResult',
  'mcpl/error':                    'mcpl/error',
};

/** Vendor extensions (not in spec, used by animachat) */
export const EXTENSION_INTERNAL_TO_WIRE: Record<string, string> = {
  'mcpl/scope_change_request':   'scope/request',
  'mcpl/scope_change_result':    'scope/result',
  'mcpl/connect_server':         'mcpl/connectServer',
  'mcpl/connect_server_result':  'mcpl/connectServerResult',
};

/** Combined map: internal type → wire method name */
export const INTERNAL_TO_WIRE: Record<string, string> = {
  ...SPEC_INTERNAL_TO_WIRE,
  ...EXTENSION_INTERNAL_TO_WIRE,
};

export const WIRE_TO_INTERNAL: Record<string, string> =
  Object.fromEntries(Object.entries(INTERNAL_TO_WIRE).map(([k, v]) => [v, k]));

// =============================================================================
// Standard JSON-RPC 2.0 Error Codes
// =============================================================================

export const JSONRPC_ERRORS = {
  PARSE_ERROR:      -32700,
  INVALID_REQUEST:  -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS:   -32602,
  INTERNAL_ERROR:   -32603,
} as const;

// =============================================================================
// Type Guards
// =============================================================================

export function isJsonRpcRequest(msg: Record<string, unknown>): boolean {
  return msg.jsonrpc === '2.0' && typeof msg.method === 'string' && 'id' in msg;
}

export function isJsonRpcNotification(msg: Record<string, unknown>): boolean {
  return msg.jsonrpc === '2.0' && typeof msg.method === 'string' && !('id' in msg);
}

/**
 * INVARIANT: In McplCodec.decode(), check isJsonRpcErrorResponse() BEFORE this guard.
 * This guard returns true for BOTH success AND error responses (per JSON-RPC 2.0 spec).
 * If checked first, error responses would be mishandled as success responses.
 */
export function isJsonRpcResponse(msg: Record<string, unknown>): boolean {
  return msg.jsonrpc === '2.0' && 'id' in msg && ('result' in msg || 'error' in msg);
}

export function isJsonRpcErrorResponse(msg: Record<string, unknown>): boolean {
  return msg.jsonrpc === '2.0' && 'id' in msg && 'error' in msg;
}
