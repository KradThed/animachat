/**
 * MCPL Transport Abstraction
 *
 * Decouples MCPL services from raw WebSocket.
 * WebSocketTransport is the default implementation.
 * ReliableChannel wraps any McplTransport with seq/ack, out-of-order
 * reordering, backpressure, and session resume.
 */

import { WebSocket } from 'ws';

// =============================================================================
// Interface
// =============================================================================

export interface McplTransport {
  send(message: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (msg: Record<string, unknown>) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  readonly isOpen: boolean;
}

// =============================================================================
// WebSocket Implementation
// =============================================================================

export class WebSocketTransport implements McplTransport {
  private handler: ((msg: Record<string, unknown>) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;

  constructor(private ws: WebSocket) {
    // Auto-listen — messages arrive as soon as ws is open.
    // handler is set immediately after construction in delegate-handler,
    // so messages received before handler is set are silently dropped.
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handler?.(msg);
      } catch {
        // Malformed JSON — skip
      }
    });
    ws.on('close', (code, reason) => {
      this.closeHandler?.(code, reason?.toString() ?? '');
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(message: Record<string, unknown>): void {
    if (!this.isOpen) throw new Error('Transport not open');
    this.ws.send(JSON.stringify(message));
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this.handler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }
}

// =============================================================================
// ReliableChannel — seq/ack, reorder, backpressure, resume
// =============================================================================

export interface ReliableChannelState {
  outSeq: number;
  inSeq: number;
  lastAckedSeq: number;
  buffer: Map<number, Record<string, unknown>>;
}

export class ReliableChannel implements McplTransport {
  private outSeq = 0;
  private inSeq = 0;
  private lastAckedSeq = 0;
  /** Outbound buffer: seq → frame (for resend on resume) */
  private buffer = new Map<number, Record<string, unknown>>();
  /** Out-of-order inbound payloads waiting for gaps to fill */
  private pending = new Map<number, Record<string, unknown>>();
  private messageHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private bareAckTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly MAX_UNACKED = 64;
  private static readonly BARE_ACK_DELAY_MS = 50;

  constructor(private transport: McplTransport) {
    this.transport.onMessage((raw) => this.handleIncoming(raw));
    this.transport.onClose((code, reason) => this.closeHandler?.(code, reason));
  }

  get isOpen(): boolean {
    return this.transport.isOpen;
  }

  send(message: Record<string, unknown>): void {
    const unacked = this.outSeq - this.lastAckedSeq;
    if (unacked >= ReliableChannel.MAX_UNACKED) {
      this.close(1008, 'backpressure: too many unacked frames');
      return;
    }

    const seq = ++this.outSeq;
    const frame = { seq, ack: this.inSeq, payload: message };
    this.buffer.set(seq, frame);
    this.transport.send(frame as Record<string, unknown>);

    // Piggybacked ack — cancel pending bare ack
    if (this.bareAckTimer) {
      clearTimeout(this.bareAckTimer);
      this.bareAckTimer = null;
    }
  }

  close(code?: number, reason?: string): void {
    if (this.bareAckTimer) {
      clearTimeout(this.bareAckTimer);
      this.bareAckTimer = null;
    }
    this.transport.close(code, reason);
  }

  onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Incoming frame handling
  // --------------------------------------------------------------------------

  private handleIncoming(raw: Record<string, unknown>): void {
    // Non-frame message → pass through (legacy messages)
    if (typeof raw.seq !== 'number') {
      this.messageHandler?.(raw);
      return;
    }

    const frame = raw as unknown as { seq: number; ack: number; payload?: Record<string, unknown> };

    // Process ack — free confirmed outbound frames
    if (frame.ack > this.lastAckedSeq) {
      for (let i = this.lastAckedSeq + 1; i <= frame.ack; i++) {
        this.buffer.delete(i);
      }
      this.lastAckedSeq = frame.ack;
    }

    // Bare ack (seq=0) or no payload → done
    if (frame.seq === 0 || !frame.payload) return;

    // Duplicate → ignore
    if (frame.seq <= this.inSeq) return;

    // Out-of-order → buffer for later
    if (frame.seq > this.inSeq + 1) {
      this.pending.set(frame.seq, frame.payload);
      return;
    }

    // In-order delivery + drain any buffered successors
    this.inSeq = frame.seq;
    this.messageHandler?.(frame.payload);

    while (this.pending.has(this.inSeq + 1)) {
      this.inSeq++;
      this.messageHandler?.(this.pending.get(this.inSeq)!);
      this.pending.delete(this.inSeq);
    }

    this.scheduleBareAck();
  }

  private scheduleBareAck(): void {
    if (this.bareAckTimer) return; // already scheduled
    this.bareAckTimer = setTimeout(() => {
      this.bareAckTimer = null;
      try {
        this.transport.send({ seq: 0, ack: this.inSeq } as Record<string, unknown>);
      } catch {
        // Transport closing — ignore
      }
    }, ReliableChannel.BARE_ACK_DELAY_MS);
  }

  // --------------------------------------------------------------------------
  // Session resume
  // --------------------------------------------------------------------------

  /** Get state to save on McplSession for resume across reconnects. */
  getState(): ReliableChannelState {
    return {
      outSeq: this.outSeq,
      inSeq: this.inSeq,
      lastAckedSeq: this.lastAckedSeq,
      buffer: new Map(this.buffer),
    };
  }

  /** Restore state from a previous session (call before setting onMessage handler). */
  restoreState(state: ReliableChannelState): void {
    this.outSeq = state.outSeq;
    this.inSeq = state.inSeq;
    this.lastAckedSeq = state.lastAckedSeq;
    this.buffer = new Map(state.buffer);
  }

  /** Resend all buffered frames with seq > afterSeq (for resume). */
  resendBufferedAfter(afterSeq: number): void {
    const toResend = [...this.buffer.entries()]
      .filter(([seq]) => seq > afterSeq)
      .sort(([a], [b]) => a - b);
    for (const [, frame] of toResend) {
      try {
        this.transport.send(frame);
      } catch {
        break; // Transport failed — stop resending
      }
    }
  }
}
