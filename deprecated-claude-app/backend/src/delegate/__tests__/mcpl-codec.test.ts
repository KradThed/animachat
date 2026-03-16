import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McplCodec, type PendingRequestsState } from '../mcpl-codec.js';
import type { McplTransport } from '../mcpl-transport.js';

// =============================================================================
// Mock Transport
// =============================================================================

function createMockTransport(): McplTransport & {
  sentMessages: Record<string, unknown>[];
  fireMessage: (msg: Record<string, unknown>) => void;
  fireClose: (code: number, reason: string) => void;
} {
  let messageHandler: ((msg: Record<string, unknown>) => void) | null = null;
  let closeHandler: ((code: number, reason: string) => void) | null = null;
  const sentMessages: Record<string, unknown>[] = [];

  return {
    sentMessages,
    isOpen: true,
    send(msg: Record<string, unknown>) {
      sentMessages.push(msg);
    },
    close(_code?: number, _reason?: string) {},
    onMessage(handler: (msg: Record<string, unknown>) => void) {
      messageHandler = handler;
    },
    onClose(handler: (code: number, reason: string) => void) {
      closeHandler = handler;
    },
    fireMessage(msg: Record<string, unknown>) {
      messageHandler?.(msg);
    },
    fireClose(code: number, reason: string) {
      closeHandler?.(code, reason);
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function createCodec() {
  const transport = createMockTransport();
  const codec = new McplCodec(transport);
  const received: Record<string, unknown>[] = [];
  codec.onMessage((msg) => received.push(msg));
  return { codec, transport, received };
}

// =============================================================================
// Tests: send — internal → JSON-RPC 2.0
// =============================================================================

describe('McplCodec', () => {
  // ---------------------------------------------------------------------------
  // send: Response
  // ---------------------------------------------------------------------------

  describe('send — Response encoding', () => {
    it('encodes mcpl/ack as JSON-RPC success response', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/ack',
        requestId: 'hello-1',
        sessionId: 'sess-abc',
        negotiatedCapabilities: ['context_hooks'],
      });

      expect(transport.sentMessages).toHaveLength(1);
      const wire = transport.sentMessages[0];
      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('hello-1');
      expect(wire.result).toEqual({
        sessionId: 'sess-abc',
        negotiatedCapabilities: ['context_hooks'],
      });
      expect(wire).not.toHaveProperty('method');
    });

    it('encodes mcpl/beforeInference_response as JSON-RPC success response', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/beforeInference_response',
        requestId: 'req-42',
        injections: [],
      });

      const wire = transport.sentMessages[0];
      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('req-42');
      expect((wire.result as any).injections).toEqual([]);
    });

    it('uses null id when requestId is missing on response', () => {
      const { codec, transport } = createCodec();
      codec.send({ type: 'mcpl/ack', sessionId: 'sess' });

      const wire = transport.sentMessages[0];
      expect(wire.id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // send: Error
  // ---------------------------------------------------------------------------

  describe('send — Error encoding', () => {
    it('encodes mcpl/error as JSON-RPC error response', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/error',
        requestId: 'req-5',
        code: -32001,
        message: 'Capability disabled',
      });

      const wire = transport.sentMessages[0];
      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('req-5');
      expect(wire.error).toEqual({
        code: -32001,
        message: 'Capability disabled',
      });
    });

    it('includes data fields (retryAfterMs, inReplyTo) in error', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/error',
        requestId: 'req-6',
        code: -32004,
        message: 'Rate limited',
        retryAfterMs: 5000,
        inReplyTo: 'mcpl/push_event',
      });

      const wire = transport.sentMessages[0];
      expect((wire.error as any).data).toEqual({
        retryAfterMs: 5000,
        inReplyTo: 'mcpl/push_event',
      });
    });

    it('omits data object when no extra fields', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/error',
        requestId: 'req-7',
        code: -32603,
        message: 'Internal error',
      });

      const wire = transport.sentMessages[0];
      expect(wire.error).toEqual({
        code: -32603,
        message: 'Internal error',
      });
      expect((wire.error as any).data).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // send: Notification
  // ---------------------------------------------------------------------------

  describe('send — Notification encoding', () => {
    it('encodes mcpl/featureSets_changed as JSON-RPC notification (no id)', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/featureSets_changed',
        added: { 'test-fs': { uses: ['pushEvents'], description: 'test' } },
      });

      const wire = transport.sentMessages[0];
      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.method).toBe('featureSets/changed');  // F1: internal → wire
      expect(wire).not.toHaveProperty('id');
      expect(wire.params).toEqual({
        added: { 'test-fs': { uses: ['pushEvents'], description: 'test' } },
      });
    });

    it('encodes mcpl/inference_chunk as notification', () => {
      const { codec, transport } = createCodec();
      codec.send({ type: 'mcpl/inference_chunk', chunk: 'hello' });

      const wire = transport.sentMessages[0];
      expect(wire.method).toBe('inference/chunk');  // F1: internal → wire
      expect(wire).not.toHaveProperty('id');
    });

    it('encodes mcpl/connect_server_result as notification (BUG 1 fix)', () => {
      const { codec, transport } = createCodec();
      codec.send({ type: 'mcpl/connect_server_result', serverId: 'srv-2', success: true });

      const wire = transport.sentMessages[0];
      expect(wire.method).toBe('mcpl/connectServerResult');  // F1: internal → wire
      expect(wire).not.toHaveProperty('id');
    });
  });

  // ---------------------------------------------------------------------------
  // send: Request
  // ---------------------------------------------------------------------------

  describe('send — Request encoding', () => {
    it('encodes mcpl/beforeInference as JSON-RPC request (method + id)', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/beforeInference',
        requestId: 'req-10',
        conversationId: 'conv-1',
      });

      const wire = transport.sentMessages[0];
      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('req-10');
      expect(wire.method).toBe('context/beforeInference');  // F1: internal → wire
      expect(wire.params).toEqual({ conversationId: 'conv-1' });
    });

    it('encodes mcpl/push_event as JSON-RPC request (F8c fix — not notification)', () => {
      const { codec, transport } = createCodec();
      codec.send({
        type: 'mcpl/push_event',
        requestId: 'pe-1',
        serverId: 'srv-1',
        eventType: 'file_changed',
        data: { path: '/foo' },
      });

      const wire = transport.sentMessages[0];
      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('pe-1');
      expect(wire.method).toBe('push/event');  // F1: internal → wire
      expect(wire.params).toEqual({
        serverId: 'srv-1',
        eventType: 'file_changed',
        data: { path: '/foo' },
      });
    });

    it('tracks request in pendingRequests for response correlation', () => {
      const { codec, transport } = createCodec();
      codec.send({ type: 'mcpl/beforeInference', requestId: 'req-11', conversationId: 'c1' });

      const pending = codec.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0][0]).toBe('req-11');
      expect(pending[0][1].method).toBe('mcpl/beforeInference');
    });

    it('sends as notification with warning when requestId is undefined (BUG 5 fix)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { codec, transport } = createCodec();

      codec.send({ type: 'mcpl/scope_change_request', scopes: [] });

      const wire = transport.sentMessages[0];
      expect(wire.method).toBe('scope/request');  // F1: internal → wire
      expect(wire).not.toHaveProperty('id');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no requestId'));

      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // handleIncoming: JSON-RPC 2.0 → internal format
  // ---------------------------------------------------------------------------

  describe('receive — Success response decoding', () => {
    it('decodes JSON-RPC success response using pendingRequests lookup', () => {
      const { codec, transport, received } = createCodec();

      // Send request to populate pendingRequests
      codec.send({ type: 'mcpl/beforeInference', requestId: 'req-20', conversationId: 'c1' });

      // Simulate response from transport
      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'req-20',
        result: { injections: [], abort: false },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/beforeInference_response');
      expect(received[0].requestId).toBe('req-20');
      expect((received[0] as any).injections).toEqual([]);
    });

    it('produces unknown_response when id not in pendingRequests', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { transport, received } = createCodec();

      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'orphan-99',
        result: { data: 'stale' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/unknown_response');
      expect(received[0].requestId).toBe('orphan-99');

      warnSpy.mockRestore();
    });

    it('state_rollback request → state_response (BUG 3 fix)', () => {
      const { codec, transport, received } = createCodec();

      codec.send({ type: 'mcpl/state_rollback', requestId: 'rb-1', checkpointId: 'cp-5' });

      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'rb-1',
        result: { state: {}, checkpointId: 'cp-5' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/state_response');
      expect(received[0].requestId).toBe('rb-1');
    });
  });

  describe('receive — Error response decoding', () => {
    it('decodes JSON-RPC error response to mcpl/error', () => {
      const { codec, transport, received } = createCodec();

      codec.send({ type: 'mcpl/push_event', requestId: 'req-30' });

      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'req-30',
        error: { code: -32001, message: 'Capability disabled' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/error');
      expect(received[0].code).toBe(-32001);
      expect(received[0].message).toBe('Capability disabled');
      expect(received[0].requestId).toBe('req-30');
    });

    it('includes error data fields', () => {
      const { transport, received } = createCodec();

      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'req-31',
        error: {
          code: -32004,
          message: 'Rate limited',
          data: { retryAfterMs: 3000 },
        },
      });

      expect(received[0].retryAfterMs).toBe(3000);
    });

    it('cleans up pendingRequests on error response', () => {
      const { codec, transport } = createCodec();
      codec.send({ type: 'mcpl/state_get', requestId: 'sg-1' });

      expect(codec.getPendingRequests()).toHaveLength(1);

      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'sg-1',
        error: { code: -32603, message: 'Internal' },
      });

      expect(codec.getPendingRequests()).toHaveLength(0);
    });
  });

  describe('receive — Request decoding', () => {
    it('decodes JSON-RPC request to internal format', () => {
      const { transport, received } = createCodec();

      // F1: incoming uses wire method names
      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'srv-req-1',
        method: 'context/beforeInference',
        params: { conversationId: 'conv-5' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/beforeInference');
      expect(received[0].requestId).toBe('srv-req-1');
      expect((received[0] as any).conversationId).toBe('conv-5');
    });
  });

  describe('receive — Notification decoding', () => {
    it('decodes JSON-RPC notification (no id) to internal format', () => {
      const { transport, received } = createCodec();

      // F1: incoming uses wire method names
      transport.fireMessage({
        jsonrpc: '2.0',
        method: 'featureSets/changed',
        params: { added: { 'test-fs': { uses: ['pushEvents'] } } },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/featureSets_changed');  // decoded to internal name
      expect(received[0]).not.toHaveProperty('requestId');
      expect((received[0] as any).added).toEqual({ 'test-fs': { uses: ['pushEvents'] } });
    });
  });

  describe('receive — Legacy / passthrough', () => {
    it('passes through non-JSON-RPC messages as-is', () => {
      const { transport, received } = createCodec();

      transport.fireMessage({ type: 'tool_manifest', tools: [] });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('tool_manifest');
    });

    it('passes through unrecognized JSON-RPC format with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { transport, received } = createCodec();

      transport.fireMessage({ jsonrpc: '2.0', weird: 'field' });

      expect(received).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized'),
        expect.any(String),
      );

      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip: send request → receive response
  // ---------------------------------------------------------------------------

  describe('round-trip', () => {
    it('request → response preserves correlation and fields', () => {
      const { codec, transport, received } = createCodec();

      // Send request
      codec.send({
        type: 'mcpl/inference_request',
        requestId: 'inf-1',
        conversationId: 'conv-99',
        messages: ['hello'],
      });

      // Simulate response
      transport.fireMessage({
        jsonrpc: '2.0',
        id: 'inf-1',
        result: { response: 'world', model: 'gpt-4' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/inference_response');
      expect(received[0].requestId).toBe('inf-1');
      expect((received[0] as any).response).toBe('world');
    });

    it('multiple in-flight requests correlate correctly', () => {
      const { codec, transport, received } = createCodec();

      codec.send({ type: 'mcpl/state_get', requestId: 'sg-1' });
      codec.send({ type: 'mcpl/checkpoint_list', requestId: 'cl-1' });

      // Responses arrive out of order
      transport.fireMessage({ jsonrpc: '2.0', id: 'cl-1', result: { checkpoints: [] } });
      transport.fireMessage({ jsonrpc: '2.0', id: 'sg-1', result: { state: {} } });

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe('mcpl/checkpoint_list_response');
      expect(received[0].requestId).toBe('cl-1');
      expect(received[1].type).toBe('mcpl/state_response');
      expect(received[1].requestId).toBe('sg-1');
    });
  });

  // ---------------------------------------------------------------------------
  // pendingRequests persistence (BUG 6+7 fix)
  // ---------------------------------------------------------------------------

  describe('pendingRequests — save/restore', () => {
    it('getPendingRequests returns snapshot of in-flight requests', () => {
      const { codec } = createCodec();
      codec.send({ type: 'mcpl/state_get', requestId: 'a' });
      codec.send({ type: 'mcpl/checkpoint_list', requestId: 'b' });

      const snapshot = codec.getPendingRequests();
      expect(snapshot).toHaveLength(2);

      const methods = snapshot.map(([, entry]) => entry.method);
      expect(methods).toContain('mcpl/state_get');
      expect(methods).toContain('mcpl/checkpoint_list');
    });

    it('restorePendingRequests enables response correlation on new codec', () => {
      const { codec: codec1 } = createCodec();
      codec1.send({ type: 'mcpl/state_get', requestId: 'restore-1' });
      const snapshot = codec1.getPendingRequests();

      // Create new codec (simulating reconnect)
      const { codec: codec2, transport: transport2, received: received2 } = createCodec();
      codec2.restorePendingRequests(snapshot);

      // Response to old request arrives on new codec
      transport2.fireMessage({
        jsonrpc: '2.0',
        id: 'restore-1',
        result: { state: { foo: 'bar' } },
      });

      expect(received2).toHaveLength(1);
      expect(received2[0].type).toBe('mcpl/state_response');
      expect(received2[0].requestId).toBe('restore-1');
    });

    it('getPendingRequests does not include already-responded entries', () => {
      const { codec, transport } = createCodec();
      codec.send({ type: 'mcpl/state_get', requestId: 'done-1' });
      codec.send({ type: 'mcpl/checkpoint_list', requestId: 'pending-1' });

      // Respond to first request
      transport.fireMessage({ jsonrpc: '2.0', id: 'done-1', result: {} });

      const snapshot = codec.getPendingRequests();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0][0]).toBe('pending-1');
    });
  });

  // ---------------------------------------------------------------------------
  // TTL cleanup
  // ---------------------------------------------------------------------------

  describe('pendingRequests — TTL cleanup', () => {
    it('cleanStalePending evicts entries older than 5 minutes', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { codec } = createCodec();

      codec.send({ type: 'mcpl/state_get', requestId: 'stale-1' });
      codec.send({ type: 'mcpl/checkpoint_list', requestId: 'fresh-1' });

      // Manually age the first entry
      const pending = codec.getPendingRequests();
      const staleEntry = pending.find(([id]) => id === 'stale-1');
      expect(staleEntry).toBeDefined();

      // Restore with artificially old timestamp
      const { codec: codec2 } = createCodec();
      codec2.restorePendingRequests([
        ['stale-1', { method: 'mcpl/state_get', ts: Date.now() - 6 * 60 * 1000 }], // 6 min ago
        ['fresh-1', { method: 'mcpl/checkpoint_list', ts: Date.now() }],              // now
      ]);

      codec2.cleanStalePending();
      const remaining = codec2.getPendingRequests();
      expect(remaining).toHaveLength(1);
      expect(remaining[0][0]).toBe('fresh-1');

      logSpy.mockRestore();
    });

    it('restorePendingRequests skips expired entries', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { codec } = createCodec();

      codec.restorePendingRequests([
        ['expired-1', { method: 'mcpl/state_get', ts: Date.now() - 10 * 60 * 1000 }], // 10 min ago
        ['valid-1', { method: 'mcpl/checkpoint_list', ts: Date.now() }],
      ]);

      const pending = codec.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0][0]).toBe('valid-1');

      logSpy.mockRestore();
    });

    it('getPendingRequests runs cleanup before returning', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { codec } = createCodec();

      codec.restorePendingRequests([
        ['old-1', { method: 'mcpl/state_get', ts: Date.now() - 6 * 60 * 1000 }],
      ]);

      // getPendingRequests calls cleanStalePending internally
      const snapshot = codec.getPendingRequests();
      expect(snapshot).toHaveLength(0);

      logSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('numeric requestId works for request/response correlation', () => {
      const { codec, transport, received } = createCodec();
      codec.send({ type: 'mcpl/state_get', requestId: 42 });

      transport.fireMessage({ jsonrpc: '2.0', id: 42, result: { state: {} } });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('mcpl/state_response');
      expect(received[0].requestId).toBe(42);
    });

    it('close event propagates through codec', () => {
      const { codec, transport } = createCodec();
      let closedCode = 0;
      let closedReason = '';
      codec.onClose((code, reason) => {
        closedCode = code;
        closedReason = reason;
      });

      transport.fireClose(1006, 'abnormal');
      expect(closedCode).toBe(1006);
      expect(closedReason).toBe('abnormal');
    });

    it('no handler set — incoming messages are silently dropped', () => {
      const transport = createMockTransport();
      const codec = new McplCodec(transport);
      // Don't call onMessage — no handler

      expect(() => {
        transport.fireMessage({ jsonrpc: '2.0', method: 'featureSets/changed', params: {} });
      }).not.toThrow();
    });

    it('PendingRequestsState is serializable (JSON round-trip)', () => {
      const { codec } = createCodec();
      codec.send({ type: 'mcpl/state_get', requestId: 'ser-1' });
      codec.send({ type: 'mcpl/checkpoint_list', requestId: 'ser-2' });

      const snapshot = codec.getPendingRequests();
      const json = JSON.stringify(snapshot);
      const restored: PendingRequestsState = JSON.parse(json);

      expect(restored).toHaveLength(2);
      expect(restored[0][1].method).toBe('mcpl/state_get');
      expect(typeof restored[0][1].ts).toBe('number');
    });
  });
});
