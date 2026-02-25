import { describe, it, expect } from 'vitest';
import {
  RESPONSE_TYPE_MAP,
  REQUEST_TO_RESPONSE_TYPE,
  NOTIFICATION_TYPES,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
} from '../../../../shared/src/mcpl-jsonrpc.js';

// =============================================================================
// Tests: Maps consistency
// =============================================================================

describe('mcpl-jsonrpc maps', () => {
  // ---------------------------------------------------------------------------
  // RESPONSE_TYPE_MAP
  // ---------------------------------------------------------------------------

  describe('RESPONSE_TYPE_MAP', () => {
    it('contains expected response types', () => {
      expect(RESPONSE_TYPE_MAP['mcpl/ack']).toBe('mcpl/hello');
      expect(RESPONSE_TYPE_MAP['mcpl/beforeInference_response']).toBe('mcpl/beforeInference');
      expect(RESPONSE_TYPE_MAP['mcpl/afterInference_response']).toBe('mcpl/afterInference');
      expect(RESPONSE_TYPE_MAP['mcpl/afterInference_ack']).toBe('mcpl/afterInference');
      expect(RESPONSE_TYPE_MAP['mcpl/inference_response']).toBe('mcpl/inference_request');
      expect(RESPONSE_TYPE_MAP['mcpl/state_response']).toBe('mcpl/state_get');
      expect(RESPONSE_TYPE_MAP['mcpl/model_info_response']).toBe('mcpl/model_info_request');
    });

    it('does NOT contain connect_server_result (BUG 1 fix — it is a notification)', () => {
      expect(RESPONSE_TYPE_MAP['mcpl/connect_server_result']).toBeUndefined();
    });

    it('has no entries mapping to notification types', () => {
      for (const [responseType, requestType] of Object.entries(RESPONSE_TYPE_MAP)) {
        expect(NOTIFICATION_TYPES.has(responseType)).toBe(false);
        expect(NOTIFICATION_TYPES.has(requestType)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // REQUEST_TO_RESPONSE_TYPE
  // ---------------------------------------------------------------------------

  describe('REQUEST_TO_RESPONSE_TYPE', () => {
    it('is inverse of RESPONSE_TYPE_MAP (first match wins)', () => {
      // Every request type in RESPONSE_TYPE_MAP should have an entry in REQUEST_TO_RESPONSE_TYPE
      const requestTypes = new Set(Object.values(RESPONSE_TYPE_MAP));
      for (const reqType of requestTypes) {
        expect(REQUEST_TO_RESPONSE_TYPE[reqType]).toBeDefined();
      }
    });

    it('mcpl/hello → mcpl/ack', () => {
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/hello']).toBe('mcpl/ack');
    });

    it('mcpl/beforeInference → mcpl/beforeInference_response', () => {
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/beforeInference']).toBe('mcpl/beforeInference_response');
    });

    it('mcpl/afterInference → mcpl/afterInference_response (first match, not ack)', () => {
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/afterInference']).toBe('mcpl/afterInference_response');
    });

    it('mcpl/state_rollback → mcpl/state_response (BUG 3 fix)', () => {
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/state_rollback']).toBe('mcpl/state_response');
    });

    it('mcpl/state_get → mcpl/state_response', () => {
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/state_get']).toBe('mcpl/state_response');
    });

    it('mcpl/inference_request → mcpl/inference_response', () => {
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/inference_request']).toBe('mcpl/inference_response');
    });
  });

  // ---------------------------------------------------------------------------
  // NOTIFICATION_TYPES
  // ---------------------------------------------------------------------------

  describe('NOTIFICATION_TYPES', () => {
    it('contains expected notification types', () => {
      expect(NOTIFICATION_TYPES.has('mcpl/push_event')).toBe(true);
      expect(NOTIFICATION_TYPES.has('mcpl/featureSets_changed')).toBe(true);
      expect(NOTIFICATION_TYPES.has('mcpl/inference_chunk')).toBe(true);
      expect(NOTIFICATION_TYPES.has('mcpl/connect_server')).toBe(true);
      expect(NOTIFICATION_TYPES.has('mcpl/connect_server_result')).toBe(true);
    });

    it('has exactly 5 entries', () => {
      expect(NOTIFICATION_TYPES.size).toBe(5);
    });

    it('does NOT contain any request or response types', () => {
      // No response type should be a notification
      for (const responseType of Object.keys(RESPONSE_TYPE_MAP)) {
        expect(NOTIFICATION_TYPES.has(responseType)).toBe(false);
      }
      // No request type should be a notification (except connect_server which is special)
      const requestTypes = Object.values(RESPONSE_TYPE_MAP).filter(t => t !== 'mcpl/connect_server');
      for (const reqType of requestTypes) {
        expect(NOTIFICATION_TYPES.has(reqType)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-map consistency
  // ---------------------------------------------------------------------------

  describe('cross-map consistency', () => {
    it('no type appears in both RESPONSE_TYPE_MAP and NOTIFICATION_TYPES', () => {
      for (const responseType of Object.keys(RESPONSE_TYPE_MAP)) {
        expect(NOTIFICATION_TYPES.has(responseType)).toBe(false);
      }
    });

    it('REQUEST_TO_RESPONSE_TYPE covers all unique request methods from RESPONSE_TYPE_MAP', () => {
      const uniqueRequests = new Set(Object.values(RESPONSE_TYPE_MAP));
      for (const req of uniqueRequests) {
        expect(REQUEST_TO_RESPONSE_TYPE).toHaveProperty(req);
      }
    });

    it('REQUEST_TO_RESPONSE_TYPE includes state_rollback (manual addition)', () => {
      // state_rollback is NOT in RESPONSE_TYPE_MAP values, it is manually added
      expect(REQUEST_TO_RESPONSE_TYPE['mcpl/state_rollback']).toBeDefined();
    });
  });
});

// =============================================================================
// Tests: Type Guards
// =============================================================================

describe('mcpl-jsonrpc type guards', () => {
  // ---------------------------------------------------------------------------
  // isJsonRpcRequest
  // ---------------------------------------------------------------------------

  describe('isJsonRpcRequest', () => {
    it('returns true for valid request (has jsonrpc, method, id)', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(true);
    });

    it('returns true for request with string id', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'test' })).toBe(true);
    });

    it('returns false when missing id (notification)', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false);
    });

    it('returns false when missing method (response)', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    });

    it('returns false for wrong jsonrpc version', () => {
      expect(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'test' })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // isJsonRpcNotification
  // ---------------------------------------------------------------------------

  describe('isJsonRpcNotification', () => {
    it('returns true for notification (method, no id)', () => {
      expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'test' })).toBe(true);
    });

    it('returns true for notification with params', () => {
      expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'test', params: { a: 1 } })).toBe(true);
    });

    it('returns false when id is present (request)', () => {
      expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(false);
    });

    it('returns false when method is missing', () => {
      expect(isJsonRpcNotification({ jsonrpc: '2.0', result: {} })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // isJsonRpcResponse
  // ---------------------------------------------------------------------------

  describe('isJsonRpcResponse', () => {
    it('returns true for success response (id + result)', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    });

    it('returns true for error response (id + error)', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(true);
    });

    it('returns true with null id', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: null, result: {} })).toBe(true);
    });

    it('returns false when missing id', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', result: {} })).toBe(false);
    });

    it('returns false for request (has method)', () => {
      // Note: a message with id + method is a request, not response.
      // But isJsonRpcResponse only checks id + result/error, not method absence.
      // This means a message with all three would match both — codec checks order matters.
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // isJsonRpcErrorResponse
  // ---------------------------------------------------------------------------

  describe('isJsonRpcErrorResponse', () => {
    it('returns true for error response', () => {
      expect(isJsonRpcErrorResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(true);
    });

    it('returns false for success response', () => {
      expect(isJsonRpcErrorResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    });

    it('returns false when missing id', () => {
      expect(isJsonRpcErrorResponse({ jsonrpc: '2.0', error: { code: -1, message: 'err' } })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Guard priority (codec decode order depends on these)
  // ---------------------------------------------------------------------------

  describe('guard priority — codec decode order', () => {
    it('error response: isJsonRpcErrorResponse = true, isJsonRpcResponse = true', () => {
      const msg = { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } };
      expect(isJsonRpcErrorResponse(msg)).toBe(true);
      expect(isJsonRpcResponse(msg)).toBe(true);
      // Codec checks error first — this is correct
    });

    it('success response: isJsonRpcErrorResponse = false, isJsonRpcResponse = true', () => {
      const msg = { jsonrpc: '2.0', id: 1, result: 'ok' };
      expect(isJsonRpcErrorResponse(msg)).toBe(false);
      expect(isJsonRpcResponse(msg)).toBe(true);
    });

    it('request: isJsonRpcRequest = true, isJsonRpcResponse = false', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'test', params: {} };
      expect(isJsonRpcRequest(msg)).toBe(true);
      expect(isJsonRpcResponse(msg)).toBe(false);
    });

    it('notification: isJsonRpcNotification = true, isJsonRpcRequest = false', () => {
      const msg = { jsonrpc: '2.0', method: 'test' };
      expect(isJsonRpcNotification(msg)).toBe(true);
      expect(isJsonRpcRequest(msg)).toBe(false);
    });
  });
});
