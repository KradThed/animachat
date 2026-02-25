// Vendored from @deprecated-claude/backend
// Original location: node_modules/@deprecated-claude/backend/src/delegate/delegate-manager.ts

/**
 * Delegate Manager
 *
 * Tracks connected delegate apps and manages tool call routing to them.
 * Each delegate is a WebSocket client that provides remote tool execution.
 */

import { WebSocket } from 'ws';
import { randomUUID, createHash } from 'crypto';
import type { ToolCallRequestMessage, ToolCallResponseMessage } from './protocol.js';
import type { ToolDefinition, ToolResult } from '../tools/tool-registry.js';
import { roomManager } from '../websocket/room-manager.js';

// =============================================================================
// Types
// =============================================================================

export interface ToolManifestSnapshot {
  timestamp: string;
  toolCount: number;
  tools: Array<{ name: string; serverName?: string }>;
}

export interface ConnectedDelegate {
  delegateId: string;
  userId: string;
  ws: WebSocket;
  tools: ToolDefinition[];
  toolHistory: ToolManifestSnapshot[];
  capabilities: string[];
  connectedAt: Date;
  sessionId: string;
}

interface PendingToolCall {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  delegateId: string;
  toolName: string;
}

// =============================================================================
// DelegateManager
// =============================================================================

export class DelegateManager {
  /** Connected delegates keyed by sessionId */
  private delegates: Map<string, ConnectedDelegate> = new Map();

  /** Pending tool calls keyed by requestId */
  private pendingCalls: Map<string, PendingToolCall> = new Map();

  /**
   * Stable serverId mapping: `{delegateId}:{serverName}` → deterministic hash.
   * Deterministic: same (delegateId, serverName) always produces the same serverId,
   * even across server restarts. This ensures event store references (disabledServers,
   * server_enabled_changed) survive restarts without persistence layer.
   */
  private serverIdMap: Map<string, string> = new Map();

  /**
   * Get or create a stable serverId for a (delegateId, serverName) pair.
   * Uses deterministic sha256 hash — same input always produces the same ID,
   * even across server restarts (no persistence needed).
   */
  getOrCreateServerId(delegateId: string, serverName: string): string {
    const key = `${delegateId}:${serverName}`;
    let serverId = this.serverIdMap.get(key);
    if (!serverId) {
      serverId = createHash('sha256').update(key).digest('hex').slice(0, 32);
      this.serverIdMap.set(key, serverId);
      console.log(`[DelegateManager] serverId for ${key}: ${serverId}`);
    }
    return serverId;
  }

  // --------------------------------------------------------------------------
  // Delegate Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Register a new delegate connection.
   * @returns sessionId for this connection
   */
  registerDelegate(
    ws: WebSocket,
    userId: string,
    delegateId: string,
    capabilities: string[] = []
  ): string {
    const sessionId = randomUUID();

    const delegate: ConnectedDelegate = {
      delegateId,
      userId,
      ws,
      tools: [],
      toolHistory: [],
      capabilities,
      connectedAt: new Date(),
      sessionId,
    };

    this.delegates.set(sessionId, delegate);
    console.log(`[DelegateManager] Delegate "${delegateId}" registered for user ${userId} (session: ${sessionId})`);

    // Notify user's frontend connections about delegate connection
    this.notifyDelegateStatusChange(userId, 'connected', delegate);

    return sessionId;
  }

  /**
   * Unregister a delegate and fail any pending tool calls.
   */
  unregisterDelegate(sessionId: string): void {
    const delegate = this.delegates.get(sessionId);
    if (!delegate) return;

    const { userId, delegateId } = delegate;
    console.log(`[DelegateManager] Delegate "${delegateId}" disconnected (session: ${sessionId})`);

    // Fail any pending tool calls for this delegate
    this.failPendingCalls(delegateId);

    this.delegates.delete(sessionId);

    // Notify user's frontend connections about delegate disconnection
    this.notifyDelegateStatusChange(userId, 'disconnected', { delegateId });
  }

  /**
   * Notify all user's frontend connections about delegate status change.
   */
  private notifyDelegateStatusChange(
    userId: string,
    status: 'connected' | 'disconnected' | 'tools_updated',
    delegate: Partial<ConnectedDelegate> & { delegateId: string }
  ): void {
    const allDelegates = this.getDelegatesForUser(userId);

    roomManager.broadcastToUser(userId, {
      type: 'delegate_status_changed',
      status,
      delegateId: delegate.delegateId,
      toolCount: delegate.tools?.length ?? 0,
      // Send full list of connected delegates
      delegates: allDelegates.map(d => ({
        delegateId: d.delegateId,
        toolCount: d.tools.length,
        capabilities: d.capabilities,
        connectedAt: d.connectedAt.toISOString(),
      })),
    });

    console.log(`[DelegateManager] Notified user ${userId} about delegate ${status}: ${delegate.delegateId}`);
  }

  /**
   * Update the tool manifest for a delegate.
   */
  updateTools(sessionId: string, tools: ToolDefinition[], timestamp?: string): void {
    const delegate = this.delegates.get(sessionId);
    if (!delegate) {
      console.warn(`[DelegateManager] Cannot update tools: session ${sessionId} not found`);
      return;
    }

    delegate.tools = tools;

    // Append snapshot to in-memory history
    const snapshot: ToolManifestSnapshot = {
      timestamp: timestamp || new Date().toISOString(),
      toolCount: tools.length,
      tools: tools.map(t => ({ name: t.name, serverName: (t as any).serverName })),
    };
    delegate.toolHistory.push(snapshot);

    console.log(`[DelegateManager] Delegate "${delegate.delegateId}" updated tools: ${tools.map(t => t.name).join(', ')} (snapshot #${delegate.toolHistory.length})`);

    // Notify user about tools update
    this.notifyDelegateStatusChange(delegate.userId, 'tools_updated', delegate);
  }

  /**
   * Get a delegate by session ID.
   */
  getDelegate(sessionId: string): ConnectedDelegate | undefined {
    return this.delegates.get(sessionId);
  }

  /**
   * Get all delegates for a user.
   */
  getDelegatesForUser(userId: string): ConnectedDelegate[] {
    const result: ConnectedDelegate[] = [];
    for (const delegate of this.delegates.values()) {
      if (delegate.userId === userId) {
        result.push(delegate);
      }
    }
    return result;
  }

  /**
   * Find a specific delegate by userId and delegateId.
   */
  findDelegate(userId: string, delegateId: string): ConnectedDelegate | undefined {
    for (const delegate of this.delegates.values()) {
      if (delegate.userId === userId && delegate.delegateId === delegateId) {
        return delegate;
      }
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Tool Execution
  // --------------------------------------------------------------------------

  /**
   * Execute a tool call on a delegate.
   * Sends the request via WebSocket and waits for the response (with timeout).
   */
  async executeToolOnDelegate(
    delegateId: string,
    userId: string,
    call: { id: string; name: string; input: Record<string, unknown> },
    timeoutMs: number = 300_000,  // 5min safety net — real timeout in ToolRegistry.executeWithTimeout()
    scopeContext?: { featureSet: string; activeCapabilities: string[] },  // Phase 7 Batch 4c — scope tagging
    inferenceContext?: { chainId: string; frameId: string },  // BUG 9 — chain/frame tracking for _mcpl injection
  ): Promise<ToolResult> {
    const delegate = this.findDelegate(userId, delegateId);
    if (!delegate) {
      return {
        toolUseId: call.id,
        content: `Delegate "${delegateId}" is not connected.`,
        isError: true,
      };
    }

    if (delegate.ws.readyState !== WebSocket.OPEN) {
      return {
        toolUseId: call.id,
        content: `Delegate "${delegateId}" connection is not open.`,
        isError: true,
      };
    }

    const requestId = randomUUID();

    // Send tool call request to delegate
    const request: ToolCallRequestMessage = {
      type: 'tool_call_request',
      requestId,
      conversationId: '', // Will be set by caller if needed
      tool: {
        id: call.id,
        name: call.name,
        input: call.input,
      },
      timeout: timeoutMs,
      ...(scopeContext ? { scopeContext } : {}),  // Phase 7 Batch 4c — scope tagging
      ...(inferenceContext ? { inferenceContext } : {}),  // BUG 9 — chain/frame for _mcpl injection
    };

    return new Promise<ToolResult>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(requestId);
        resolve({
          toolUseId: call.id,
          content: `Tool call timed out after ${timeoutMs}ms (delegate: ${delegateId}, tool: ${call.name})`,
          isError: true,
        });
      }, timeoutMs);

      // Store pending call
      this.pendingCalls.set(requestId, {
        resolve,
        reject,
        timeout,
        delegateId,
        toolName: call.name,
      });

      // Send request to delegate
      try {
        delegate.ws.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCalls.delete(requestId);
        resolve({
          toolUseId: call.id,
          content: `Failed to send tool call to delegate "${delegateId}": ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        });
      }
    });
  }

  /**
   * Handle a tool call response from a delegate.
   */
  handleToolCallResponse(msg: ToolCallResponseMessage): void {
    const pending = this.pendingCalls.get(msg.requestId);
    if (!pending) {
      console.warn(`[DelegateManager] Received response for unknown requestId: ${msg.requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCalls.delete(msg.requestId);

    pending.resolve({
      toolUseId: msg.toolUseId,
      content: msg.result.content,
      isError: msg.result.isError,
    });
  }

  /**
   * Fail all pending tool calls for a delegate (e.g., on disconnect).
   */
  private failPendingCalls(delegateId: string): void {
    for (const [requestId, pending] of this.pendingCalls) {
      if (pending.delegateId === delegateId) {
        clearTimeout(pending.timeout);
        this.pendingCalls.delete(requestId);
        pending.resolve({
          toolUseId: '',
          content: `Delegate "${delegateId}" disconnected during tool execution (tool: ${pending.toolName})`,
          isError: true,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(): {
    totalDelegates: number;
    pendingCalls: number;
    delegates: Array<{ delegateId: string; userId: string; toolCount: number; connectedAt: Date }>;
  } {
    return {
      totalDelegates: this.delegates.size,
      pendingCalls: this.pendingCalls.size,
      delegates: Array.from(this.delegates.values()).map(d => ({
        delegateId: d.delegateId,
        userId: d.userId,
        toolCount: d.tools.length,
        connectedAt: d.connectedAt,
      })),
    };
  }
}

export const delegateManager = new DelegateManager();
