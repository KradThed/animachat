/**
 * Delegate WebSocket Connection
 *
 * Manages the persistent bidirectional WebSocket connection to the server.
 * Handles authentication, reconnection with backoff, and heartbeat.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ServerMessageSchema, type ServerMessage, type ToolCallRequest } from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface ConnectionOptions {
  serverUrl: string;
  token: string;
  delegateId: string;
  capabilities: string[];
  /** Reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Max reconnection attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

interface ConnectionEvents {
  connected: (sessionId: string, userId: string) => void;
  disconnected: (code: number, reason: string) => void;
  reconnecting: (attempt: number) => void;
  tool_call_request: (request: ToolCallRequest) => void;
  trigger_inference_result: (result: ServerMessage) => void;
  tool_manifest_ack: (data: { toolCount: number; tools: string[] }) => void;
  error: (error: Error) => void;
  state_change: (state: ConnectionState) => void;
}

// =============================================================================
// DelegateConnection
// =============================================================================

export class DelegateConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<ConnectionOptions>;
  private state: ConnectionState = 'disconnected';
  private sessionId: string | null = null;
  private userId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;

  constructor(options: ConnectionOptions) {
    super();
    this.options = {
      autoReconnect: true,
      heartbeatInterval: 30000,
      maxReconnectAttempts: Infinity,
      ...options,
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  get currentState(): ConnectionState { return this.state; }
  get isConnected(): boolean { return this.state === 'connected'; }

  /**
   * Connect to the server.
   */
  async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this.state}`);
    }

    this.intentionalClose = false;
    return this.doConnect();
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.setState('disconnected');
    console.log('[Connection] Disconnected (intentional)');
  }

  /**
   * Send a message to the server.
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send tool manifest to advertise available tools.
   */
  sendToolManifest(tools: Array<{ name: string; description: string; inputSchema: unknown }>): void {
    this.send({
      type: 'tool_manifest',
      delegateId: this.options.delegateId,
      tools,
    });
    console.log(`[Connection] Sent tool manifest: ${tools.length} tools (${tools.map(t => t.name).join(', ')})`);
  }

  /**
   * Send tool call response back to server.
   */
  sendToolCallResponse(
    requestId: string,
    toolUseId: string,
    content: string | unknown[],
    isError = false
  ): void {
    this.send({
      type: 'tool_call_response',
      requestId,
      toolUseId,
      result: { content, isError },
    });
  }

  /**
   * Send a trigger inference request (for external events/webhooks).
   */
  sendTriggerInference(params: {
    triggerId: string;
    source: string;
    conversationId?: string;
    participantId?: string;
    context: Record<string, unknown>;
    systemMessage?: string;
  }): void {
    this.send({
      type: 'trigger_inference',
      ...params,
    });
    console.log(`[Connection] Sent trigger: ${params.source} (${params.triggerId})`);
  }

  // --------------------------------------------------------------------------
  // Connection Logic
  // --------------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting');

      const { serverUrl, token, delegateId } = this.options;
      const separator = serverUrl.includes('?') ? '&' : '?';
      const url = `${serverUrl}${separator}token=${encodeURIComponent(token)}&role=delegate&delegateId=${encodeURIComponent(delegateId)}`;

      console.log(`[Connection] Connecting to ${serverUrl} as delegate "${delegateId}"...`);

      try {
        this.ws = new WebSocket(url);
      } catch (error) {
        this.setState('disconnected');
        reject(error);
        return;
      }

      const connectionTimeout = setTimeout(() => {
        if (this.state === 'connecting' || this.state === 'authenticating') {
          console.error('[Connection] Connection timeout');
          this.ws?.terminate();
          this.setState('disconnected');
          reject(new Error('Connection timeout'));
        }
      }, 15000);

      this.ws.on('open', () => {
        this.setState('authenticating');
        console.log('[Connection] WebSocket opened, waiting for auth result...');
      });

      this.ws.on('message', (data) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          console.warn('[Connection] Received invalid JSON');
          return;
        }

        // Handle auth result specially during authentication phase
        if (this.state === 'authenticating') {
          const msg = raw as any;
          if (msg.type === 'delegate_auth_result') {
            clearTimeout(connectionTimeout);
            if (msg.success) {
              this.sessionId = msg.sessionId;
              this.userId = msg.userId;
              this.reconnectAttempts = 0;
              this.setState('connected');
              this.startHeartbeat();
              console.log(`[Connection] Authenticated! userId=${msg.userId}, session=${msg.sessionId}`);
              this.emit('connected', msg.sessionId, msg.userId);
              resolve();
            } else {
              const err = new Error(`Authentication failed: ${msg.error || 'unknown'}`);
              this.setState('disconnected');
              this.ws?.close();
              reject(err);
            }
            return;
          }
        }

        // Normal message handling
        this.handleMessage(raw);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        this.stopHeartbeat();
        const reasonStr = reason.toString() || 'unknown';

        if (this.state === 'connecting' || this.state === 'authenticating') {
          this.setState('disconnected');
          reject(new Error(`Connection closed during setup: ${code} ${reasonStr}`));
          return;
        }

        this.setState('disconnected');
        this.emit('disconnected', code, reasonStr);
        console.log(`[Connection] Disconnected: ${code} ${reasonStr}`);

        if (!this.intentionalClose && this.options.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        console.error('[Connection] WebSocket error:', error.message);
        this.emit('error', error);
      });

      this.ws.on('pong', () => {
        // WebSocket-level pong (from ws ping)
      });
    });
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  private handleMessage(raw: unknown): void {
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Unknown message type — log and ignore for forward compatibility
      console.warn('[Connection] Unknown/invalid message:', JSON.stringify(raw).substring(0, 200));
      return;
    }

    const msg = parsed.data;

    switch (msg.type) {
      case 'tool_call_request':
        this.emit('tool_call_request', msg);
        break;

      case 'trigger_inference_result':
        this.emit('trigger_inference_result', msg);
        break;

      case 'tool_manifest_ack':
        console.log(`[Connection] Tool manifest acknowledged: ${msg.toolCount} tools`);
        this.emit('tool_manifest_ack', msg);
        break;

      case 'pong':
        // Heartbeat response — connection is alive
        break;

      case 'delegate_auth_result':
        // Already handled during auth phase
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.send({ type: 'ping', timestamp: Date.now() });
        } catch {
          // Ignore send errors — disconnect handler will take care of it
        }
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Reconnection
  // --------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error(`[Connection] Max reconnect attempts (${this.options.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    console.log(`[Connection] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.doConnect();
        // Re-emit connected so tools can be re-registered
      } catch (error) {
        console.error(`[Connection] Reconnect failed:`, error instanceof Error ? error.message : error);
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('state_change', state);
    }
  }
}
