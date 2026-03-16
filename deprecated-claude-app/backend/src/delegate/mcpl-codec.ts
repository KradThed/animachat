/**
 * MCPL JSON-RPC 2.0 Codec
 *
 * Transparent adapter that converts between internal message format
 * ({ type: 'mcpl/...', requestId, ...fields }) and JSON-RPC 2.0 wire format.
 *
 * Implements McplTransport — sits between application code and ReliableChannel.
 * Application code sees internal format; the wire sees JSON-RPC 2.0.
 *
 * Layer order:
 *   App code → McplCodec → ReliableChannel → WebSocketTransport → WebSocket
 */

import type { McplTransport } from './mcpl-transport.js';
import {
  RESPONSE_TYPE_MAP,
  REQUEST_TO_RESPONSE_TYPE,
  NOTIFICATION_TYPES,
  INTERNAL_TO_WIRE,
  WIRE_TO_INTERNAL,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
} from '../../../shared/src/mcpl-jsonrpc.js';

// =============================================================================
// McplCodec
// =============================================================================

/** Serializable snapshot of pending requests for session resume. */
export type PendingRequestsState = Array<[string | number, { method: string; ts: number }]>;

/** Default TTL for pending requests (5 minutes). */
const PENDING_TTL_MS = 5 * 60 * 1000;

export class McplCodec implements McplTransport {
  /**
   * Tracks outgoing requests: id → { method, ts }.
   * Populated on send (request), consumed on receive (response).
   * Used to map JSON-RPC responses (which have no `method`) back to
   * the correct internal response type via REQUEST_TO_RESPONSE_TYPE.
   *
   * Entries include a timestamp for TTL-based cleanup — if a response
   * never arrives, stale entries are evicted instead of leaking forever.
   */
  private pendingRequests = new Map<string | number, { method: string; ts: number }>();

  private messageHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;

  constructor(private inner: McplTransport) {
    // Wire up incoming messages from inner transport
    this.inner.onMessage((raw) => this.handleIncoming(raw));
    this.inner.onClose((code, reason) => this.closeHandler?.(code, reason));
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  // ---------------------------------------------------------------------------
  // send: internal format → JSON-RPC 2.0
  // ---------------------------------------------------------------------------

  send(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    const requestId = msg.requestId as string | number | undefined;

    // 1. Response — type is in RESPONSE_TYPE_MAP
    if (RESPONSE_TYPE_MAP[type]) {
      const { type: _, requestId: __, ...rest } = msg;
      this.inner.send({
        jsonrpc: '2.0',
        id: requestId ?? null,
        result: rest,
      });
      return;
    }

    // 2. Error — special handling for mcpl/error
    if (type === 'mcpl/error') {
      const data: Record<string, unknown> = {};
      if (msg.retryAfterMs !== undefined) data.retryAfterMs = msg.retryAfterMs;
      if (msg.inReplyTo !== undefined) data.inReplyTo = msg.inReplyTo;

      this.inner.send({
        jsonrpc: '2.0',
        id: requestId ?? null,
        error: {
          code: msg.code as number,
          message: msg.message as string,
          ...(Object.keys(data).length > 0 ? { data } : {}),
        },
      });
      return;
    }

    // F1 fix: Translate internal method name → spec wire name
    const wireMethod = INTERNAL_TO_WIRE[type] ?? type;

    // 3. Notification — fire-and-forget, no id
    if (NOTIFICATION_TYPES.has(type)) {
      const { type: _, ...rest } = msg;
      this.inner.send({
        jsonrpc: '2.0',
        method: wireMethod,
        params: rest,
      });
      return;
    }

    // 4. Request — expects a response (must have requestId to be a valid JSON-RPC request)
    const { type: _, requestId: __, ...rest } = msg;
    if (requestId === undefined) {
      console.warn(`[McplCodec] Request "${type}" has no requestId — sending as notification`);
      this.inner.send({
        jsonrpc: '2.0',
        method: wireMethod,
        params: rest,
      });
      return;
    }
    this.pendingRequests.set(requestId, { method: type, ts: Date.now() });
    this.inner.send({
      jsonrpc: '2.0',
      id: requestId,
      method: wireMethod,
      params: rest,
    });
  }

  // ---------------------------------------------------------------------------
  // onMessage / onClose: JSON-RPC 2.0 → internal format
  // ---------------------------------------------------------------------------

  onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  // ---------------------------------------------------------------------------
  // Incoming: JSON-RPC 2.0 → internal format
  // ---------------------------------------------------------------------------

  private handleIncoming(raw: Record<string, unknown>): void {
    if (!this.messageHandler) return;

    // Not JSON-RPC? Pass through as-is (e.g. legacy messages during transition)
    if (raw.jsonrpc !== '2.0') {
      this.messageHandler(raw);
      return;
    }

    // 1. Error response
    if (isJsonRpcErrorResponse(raw)) {
      const id = raw.id as string | number | null;
      const error = raw.error as { code: number; message: string; data?: Record<string, unknown> };
      const data = (error.data && typeof error.data === 'object') ? error.data as Record<string, unknown> : {};

      // Clean up pending request
      if (id !== null && id !== undefined) {
        this.pendingRequests.delete(id);
      }

      this.messageHandler({
        type: 'mcpl/error',
        ...(id !== null && id !== undefined ? { requestId: id } : {}),
        code: error.code,
        message: error.message,
        ...data,
      });
      return;
    }

    // 2. Success response (has result + id, no method)
    if (isJsonRpcResponse(raw)) {
      const id = raw.id as string | number;
      const result = raw.result;

      // Look up which method this responds to
      const entry = this.pendingRequests.get(id);
      this.pendingRequests.delete(id);
      const method = entry?.method;

      if (method) {
        // Find the internal response type for this method
        const responseType = REQUEST_TO_RESPONSE_TYPE[method];
        if (responseType) {
          const resultObj = (result && typeof result === 'object' && !Array.isArray(result))
            ? result as Record<string, unknown>
            : {};
          this.messageHandler({
            type: responseType,
            requestId: id,
            ...resultObj,
          });
          return;
        }
      }

      // Fallback: unknown response — pass result with generic type
      console.warn(`[McplCodec] Response for unknown request id=${id}, method=${method ?? 'unknown'}`);
      this.messageHandler({
        type: 'mcpl/unknown_response',
        requestId: id,
        result,
      });
      return;
    }

    // 3. Request (has method + id)
    if (isJsonRpcRequest(raw)) {
      const wireMethod = raw.method as string;
      // F1 fix: Translate spec wire name → internal name
      const internalType = WIRE_TO_INTERNAL[wireMethod] ?? wireMethod;
      const id = raw.id as string | number;
      const params = (raw.params && typeof raw.params === 'object')
        ? raw.params as Record<string, unknown>
        : {};

      this.messageHandler({
        type: internalType,
        requestId: id,
        ...params,
      });
      return;
    }

    // 4. Notification (has method, no id)
    if (isJsonRpcNotification(raw)) {
      const wireMethod = raw.method as string;
      // F1 fix: Translate spec wire name → internal name
      const internalType = WIRE_TO_INTERNAL[wireMethod] ?? wireMethod;
      const params = (raw.params && typeof raw.params === 'object')
        ? raw.params as Record<string, unknown>
        : {};

      this.messageHandler({
        type: internalType,
        ...params,
      });
      return;
    }

    // Unknown format — pass through
    console.warn('[McplCodec] Unrecognized JSON-RPC message:', JSON.stringify(raw).substring(0, 200));
    this.messageHandler(raw);
  }

  // ---------------------------------------------------------------------------
  // pendingRequests persistence (BUG 6+7 fix: survive session resume)
  // ---------------------------------------------------------------------------

  /**
   * Snapshot pending requests for saving alongside ReliableChannel state.
   * Called on disconnect (before codec is destroyed).
   */
  getPendingRequests(): PendingRequestsState {
    this.cleanStalePending();
    return [...this.pendingRequests.entries()];
  }

  /**
   * Restore pending requests from a saved snapshot.
   * Called on session resume (after new codec is created).
   */
  restorePendingRequests(state: PendingRequestsState): void {
    const now = Date.now();
    let restoredCount = 0;
    for (const [id, entry] of state) {
      // Skip entries that have already expired
      if (now - entry.ts > PENDING_TTL_MS) continue;
      this.pendingRequests.set(id, entry);
      restoredCount++;
    }
    if (restoredCount > 0) {
      console.log(`[McplCodec] Restored ${restoredCount} pending request(s) from saved state`);
    }
  }

  /**
   * Evict stale pending requests (TTL expired, response never arrived).
   * Called opportunistically on getPendingRequests() and can be called
   * periodically if desired.
   */
  cleanStalePending(): void {
    const now = Date.now();
    let evictedCount = 0;
    for (const [id, entry] of this.pendingRequests) {
      if (now - entry.ts > PENDING_TTL_MS) {
        this.pendingRequests.delete(id);
        evictedCount++;
      }
    }
    if (evictedCount > 0) {
      console.log(`[McplCodec] Evicted ${evictedCount} stale pending request(s) (TTL > ${PENDING_TTL_MS / 1000}s)`);
    }
  }
}
