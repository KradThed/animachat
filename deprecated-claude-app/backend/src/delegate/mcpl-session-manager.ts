/**
 * MCPL Session Manager
 *
 * Manages MCPL protocol sessions. Handles session creation, resumption,
 * and capability negotiation.
 *
 * Sessions survive WebSocket disconnects — on reconnect, the delegate
 * sends its sessionId in mcpl/hello to resume.
 */

import { randomUUID } from 'crypto';
import type { McplCapability, McplFeatureSet } from '@deprecated-claude/shared';
import type { ReliableChannelState } from './mcpl-transport.js';
import { expandWildcards } from '../services/mcpl-wildcard.js';

// =============================================================================
// Types
// =============================================================================

export interface McplSession {
  sessionId: string;
  delegateId: string;
  userId: string;
  capabilities: McplCapability[];
  featureSets: Record<string, McplFeatureSet>;  // keyed by serverId
  protocolVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  reliableState?: ReliableChannelState;
}

// =============================================================================
// McplSessionManager
// =============================================================================

export class McplSessionManager {
  /** Active sessions keyed by sessionId */
  private sessions: Map<string, McplSession> = new Map();

  /** Index: delegateId → sessionId (for lookup by delegate) */
  private delegateIndex: Map<string, string> = new Map();

  /**
   * Create a new MCPL session.
   */
  createSession(
    delegateId: string,
    userId: string,
    capabilities: McplCapability[],
    protocolVersion: string
  ): McplSession {
    const sessionId = randomUUID();
    const session: McplSession = {
      sessionId,
      delegateId,
      userId,
      capabilities,
      featureSets: {},
      protocolVersion,
      createdAt: new Date(),
      lastSeenAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    this.delegateIndex.set(`${userId}:${delegateId}`, sessionId);

    console.log(`[McplSessionManager] Created session ${sessionId} for delegate "${delegateId}" (user: ${userId})`);
    return session;
  }

  /**
   * Resume an existing session by sessionId.
   * Returns null if session doesn't exist or belongs to a different user.
   */
  resumeSession(sessionId: string, userId: string): McplSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`[McplSessionManager] Session ${sessionId} not found for resume`);
      return null;
    }

    if (session.userId !== userId) {
      console.warn(`[McplSessionManager] Session ${sessionId} belongs to user ${session.userId}, not ${userId}`);
      return null;
    }

    session.lastSeenAt = new Date();
    console.log(`[McplSessionManager] Resumed session ${sessionId} for delegate "${session.delegateId}"`);
    return session;
  }

  /**
   * Update feature sets for a session (called after tool manifest with serverIds).
   * If serverIds is provided, wildcards in featureSets keys are expanded.
   */
  updateFeatureSets(
    sessionId: string,
    featureSets: Record<string, McplFeatureSet>,
    serverIds?: string[]
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.featureSets = serverIds
        ? expandWildcards(featureSets, serverIds)
        : featureSets;
    }
  }

  /**
   * Get session by ID.
   */
  getSession(sessionId: string): McplSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session for a specific delegate.
   */
  getSessionForDelegate(userId: string, delegateId: string): McplSession | undefined {
    const sessionId = this.delegateIndex.get(`${userId}:${delegateId}`);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /**
   * Remove a session (e.g., on intentional disconnect).
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.delegateIndex.delete(`${session.userId}:${session.delegateId}`);
      this.sessions.delete(sessionId);
      console.log(`[McplSessionManager] Removed session ${sessionId}`);
    }
  }

  /**
   * Negotiate capabilities between delegate-advertised and server-supported.
   */
  negotiateCapabilities(requested: McplCapability[]): McplCapability[] {
    // For MVP, accept all known capabilities
    const supported: Set<McplCapability> = new Set([
      'context_hooks',
      'push_events',
      'inference_requests',
      'tool_management',
    ]);
    return requested.filter(c => supported.has(c));
  }

  /**
   * Get default feature set for a server (all disabled).
   */
  static defaultFeatureSet(): McplFeatureSet {
    return {
      contextHooks: false,
      pushEvents: false,
      inferenceRequests: false,
      toolManagement: false,
    };
  }

  /**
   * Save ReliableChannel state on session (for resume across reconnects).
   */
  saveReliableState(sessionId: string, state: ReliableChannelState): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.reliableState = state;
    }
  }

  /**
   * Get saved ReliableChannel state for resume.
   */
  getReliableState(sessionId: string): ReliableChannelState | undefined {
    return this.sessions.get(sessionId)?.reliableState;
  }

  getStats(): { totalSessions: number } {
    return { totalSessions: this.sessions.size };
  }
}

export const mcplSessionManager = new McplSessionManager();
