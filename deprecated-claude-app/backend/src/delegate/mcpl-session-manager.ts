/**
 * MCPL Session Manager
 *
 * Manages MCPL protocol sessions. Handles session creation, resumption,
 * and capability negotiation.
 *
 * Sessions survive WebSocket disconnects — on reconnect, the delegate
 * sends its sessionId in mcpl/hello to resume.
 *
 * Canonical state model (three layers):
 *   1. declaredFeatureSets  — what the delegate declared
 *   2. enabledFeatureSets   — what the host policy allows
 *   3. scopesByFeatureSet   — host scope rules per feature set
 *
 * session.featureSets is a compat-only projection (never read for decisions).
 */

import { randomUUID } from 'crypto';
import type {
  McplCapability,
  McplCapabilities,
  McplFeatureSet,
  DeclaredFeatureSet,
  FeatureSetScopeState,
} from '@deprecated-claude/shared';
import { resolveCapabilities } from '@deprecated-claude/shared';
import type { ReliableChannelState } from './mcpl-transport.js';
import type { PendingRequestsState } from './mcpl-codec.js';

// =============================================================================
// Types
// =============================================================================

export interface McplSession {
  sessionId: string;
  delegateId: string;
  userId: string;
  capabilities: McplCapabilities;
  // Canonical state (four layers):
  declaredFeatureSets: Record<string, DeclaredFeatureSet>;
  enabledFeatureSets: Set<string>;
  invalidFeatureSets: Set<string>;   // quarantine: declared but blocked due to unsupported uses
  scopesByFeatureSet: Record<string, FeatureSetScopeState>;
  // Compat projection only — never read for decisions:
  featureSets: Record<string, McplFeatureSet>;
  protocolVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  reliableState?: ReliableChannelState;
  pendingRequestsState?: PendingRequestsState;
}

// =============================================================================
// McplSessionManager
// =============================================================================

// C-4 fix: Sessions not resumed within this window are swept.
const SESSION_RESUME_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

export class McplSessionManager {
  /** Active sessions keyed by sessionId */
  private sessions: Map<string, McplSession> = new Map();

  /** Index: delegateId → sessionId (for lookup by delegate) */
  private delegateIndex: Map<string, string> = new Map();

  /** C-4 fix: Periodic sweep timer for stale sessions */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startSweep();
  }

  /**
   * C-4 fix: Start periodic sweep of stale sessions.
   * Sessions that were saved for resume but never resumed get cleaned up.
   */
  private startSweep(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      let swept = 0;
      for (const [sessionId, session] of this.sessions) {
        const age = now - session.lastSeenAt.getTime();
        // Only sweep sessions that have saved resume state (i.e., disconnected)
        // and haven't been seen within the TTL window.
        if (session.reliableState && age > SESSION_RESUME_TTL_MS) {
          this.delegateIndex.delete(`${session.userId}:${session.delegateId}`);
          this.sessions.delete(sessionId);
          swept++;
        }
      }
      if (swept > 0) {
        console.log(`[McplSessionManager] Swept ${swept} stale session(s) (TTL: ${SESSION_RESUME_TTL_MS / 60_000}min)`);
      }
    }, SESSION_SWEEP_INTERVAL_MS);

    // Don't block process exit
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }

  /**
   * Stop the sweep timer (for graceful shutdown / tests).
   */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Create a new MCPL session.
   */
  createSession(
    delegateId: string,
    userId: string,
    capabilities: McplCapabilities,
    protocolVersion: string
  ): McplSession {
    const sessionId = randomUUID();
    const session: McplSession = {
      sessionId,
      delegateId,
      userId,
      capabilities,
      declaredFeatureSets: {},
      enabledFeatureSets: new Set(),
      invalidFeatureSets: new Set(),
      scopesByFeatureSet: {},
      featureSets: {},  // compat projection
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

  // ---------------------------------------------------------------------------
  // Capability update (resume renegotiation)
  // ---------------------------------------------------------------------------

  /** Re-negotiate and update session capabilities (used on resume handshake). */
  updateSessionCapabilities(sessionId: string, negotiated: McplCapabilities): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.capabilities = negotiated;
  }

  // ---------------------------------------------------------------------------
  // Layer 1: Declared Feature Sets
  // ---------------------------------------------------------------------------

  /**
   * Reconcile declared feature sets from delegate hello/full replacement.
   * Preserves enabled/scopes for surviving names, cleans all 3 layers for removed names.
   * Returns { added, removed } name lists.
   */
  reconcileDeclaredFeatureSets(
    sessionId: string,
    declared: Record<string, McplFeatureSet>
  ): { added: string[]; removed: string[] } {
    const session = this.sessions.get(sessionId);
    if (!session) return { added: [], removed: [] };

    const newNames = new Set(Object.keys(declared));
    const oldNames = new Set(Object.keys(session.declaredFeatureSets));

    const added: string[] = [];
    const removed: string[] = [];

    // Remove names no longer in declared set
    for (const name of oldNames) {
      if (!newNames.has(name)) {
        delete session.declaredFeatureSets[name];
        session.enabledFeatureSets.delete(name);
        session.invalidFeatureSets.delete(name);
        delete session.scopesByFeatureSet[name];
        removed.push(name);
      }
    }

    // Add/update declared entries
    for (const [name, fs] of Object.entries(declared)) {
      const isNew = !oldNames.has(name);
      session.declaredFeatureSets[name] = {
        name,
        ownerServerId: fs.ownerServerId,
        rawUses: [...fs.uses],
        description: fs.description,
        scoped: fs.scoped,
        rollback: fs.rollback,
      };
      if (isNew) added.push(name);
    }

    this.rebuildFeatureSetsCompat(session);
    return { added, removed };
  }

  /**
   * Merge new declarations (delta add) without removing existing.
   * Returns list of newly added names (not already present).
   */
  mergeDeclaredFeatureSets(
    sessionId: string,
    added: Record<string, McplFeatureSet>
  ): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const newNames: string[] = [];
    for (const [name, fs] of Object.entries(added)) {
      const isNew = !(name in session.declaredFeatureSets);
      session.declaredFeatureSets[name] = {
        name,
        ownerServerId: fs.ownerServerId,
        rawUses: [...fs.uses],
        description: fs.description,
        scoped: fs.scoped,
        rollback: fs.rollback,
      };
      if (isNew) newNames.push(name);
    }

    this.rebuildFeatureSetsCompat(session);
    return newNames;
  }

  /** Remove declarations — cleans all 3 layers for removed names */
  undeclareFeatureSets(sessionId: string, names: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const name of names) {
      delete session.declaredFeatureSets[name];
      session.enabledFeatureSets.delete(name);
      session.invalidFeatureSets.delete(name);
      delete session.scopesByFeatureSet[name];
    }
    this.rebuildFeatureSetsCompat(session);
  }

  // ---------------------------------------------------------------------------
  // Layer 2: Enable/Disable
  // ---------------------------------------------------------------------------

  enableFeatureSet(sessionId: string, featureSetName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.declaredFeatureSets[featureSetName]) return;
    session.enabledFeatureSets.add(featureSetName);
    this.rebuildFeatureSetsCompat(session);
  }

  disableFeatureSet(sessionId: string, featureSetName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.enabledFeatureSets.delete(featureSetName);
    this.rebuildFeatureSetsCompat(session);
  }

  enableAllDeclaredFeatureSets(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const name of Object.keys(session.declaredFeatureSets)) {
      session.enabledFeatureSets.add(name);
    }
    this.rebuildFeatureSetsCompat(session);
  }

  /**
   * Add uses to a specific feature set (used after scope elevation approval).
   */
  addUsesToFeatureSet(
    userId: string,
    delegateId: string,
    featureSetName: string,
    uses: string[]
  ): void {
    const session = this.getSessionForDelegate(userId, delegateId);
    if (!session) return;

    const decl = session.declaredFeatureSets[featureSetName];
    if (!decl) return;

    for (const u of uses) {
      if (!decl.rawUses.includes(u)) {
        decl.rawUses.push(u);
      }
    }
    this.rebuildFeatureSetsCompat(session);
  }

  // ---------------------------------------------------------------------------
  // Layer 3: Scopes
  // ---------------------------------------------------------------------------

  /**
   * Reconcile all scopes from host policy. Replaces all, prunes stale keys.
   */
  reconcileFeatureSetScopes(
    sessionId: string,
    scopes: Record<string, FeatureSetScopeState>
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Replace all scopes
    session.scopesByFeatureSet = {};
    for (const [name, scopeState] of Object.entries(scopes)) {
      // Only keep scopes for declared feature sets
      if (session.declaredFeatureSets[name]) {
        session.scopesByFeatureSet[name] = scopeState;
      }
    }
  }

  /** Export canonical scope state for featureSets/update message */
  exportScopes(sessionId: string): Record<string, { whitelist: string[]; blacklist: string[] }> {
    const session = this.sessions.get(sessionId);
    if (!session) return {};

    const result: Record<string, { whitelist: string[]; blacklist: string[] }> = {};
    for (const [name, scope] of Object.entries(session.scopesByFeatureSet)) {
      result[name] = {
        whitelist: scope.whitelist || [],
        blacklist: scope.blacklist || [],
      };
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Quarantine layer (Layer 4)
  // ---------------------------------------------------------------------------

  /**
   * Check if a feature set is effectively enabled (enabled AND not quarantined).
   * This is the authoritative check for runtime decisions.
   */
  isFeatureSetEffectivelyEnabled(sessionId: string, featureSetName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.enabledFeatureSets.has(featureSetName) &&
           !session.invalidFeatureSets.has(featureSetName);
  }

  /** Add a feature set to quarantine (blocked due to unsupported uses). */
  quarantineFeatureSet(sessionId: string, featureSetName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.invalidFeatureSets.add(featureSetName);
    this.rebuildFeatureSetsCompat(session);
  }

  /** Remove a feature set from quarantine (auto-recovery when uses become valid). */
  unquarantineFeatureSet(sessionId: string, featureSetName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.invalidFeatureSets.delete(featureSetName);
    this.rebuildFeatureSetsCompat(session);
  }

  /**
   * Get effectively enabled feature set names (enabled AND not quarantined).
   * Used for featureSets_update construction and broadcasts.
   */
  getEffectiveEnabledNames(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Object.keys(session.declaredFeatureSets).filter(
      name => session.enabledFeatureSets.has(name) && !session.invalidFeatureSets.has(name)
    );
  }

  /**
   * Get effectively disabled feature set names (not enabled OR quarantined).
   * Used for featureSets_update construction.
   */
  getEffectiveDisabledNames(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Object.keys(session.declaredFeatureSets).filter(
      name => !session.enabledFeatureSets.has(name) || session.invalidFeatureSets.has(name)
    );
  }

  // ---------------------------------------------------------------------------
  // Compat projection rebuild
  // ---------------------------------------------------------------------------

  /** Rebuild session.featureSets from canonical layers (never read for decisions) */
  private rebuildFeatureSetsCompat(session: McplSession): void {
    const compat: Record<string, McplFeatureSet> = {};
    for (const [name, decl] of Object.entries(session.declaredFeatureSets)) {
      if (session.enabledFeatureSets.has(name) && !session.invalidFeatureSets.has(name)) {
        compat[name] = {
          description: decl.description,
          uses: [...decl.rawUses],
          scoped: decl.scoped,
          rollback: decl.rollback,
          ownerServerId: decl.ownerServerId,
        };
      }
    }
    session.featureSets = compat;
  }

  // ---------------------------------------------------------------------------
  // Legacy compat: updateFeatureSets (used by Gap 7 which will be removed)
  // ---------------------------------------------------------------------------

  /**
   * @deprecated Use reconcileDeclaredFeatureSets instead.
   * Kept temporarily for backward compat during migration.
   */
  updateFeatureSets(
    sessionId: string,
    featureSets: Record<string, McplFeatureSet>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Convert to canonical format
      for (const [name, fs] of Object.entries(featureSets)) {
        session.declaredFeatureSets[name] = {
          name,
          rawUses: [...fs.uses],
          description: fs.description,
          scoped: fs.scoped,
          rollback: fs.rollback,
          ownerServerId: fs.ownerServerId,
        };
        session.enabledFeatureSets.add(name);
      }
      this.rebuildFeatureSetsCompat(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

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
   * Validate that a featureSet name belongs to a delegate's declared feature sets.
   */
  validateServerOwnership(userId: string, delegateId: string, featureSetName: string): boolean {
    const session = this.getSessionForDelegate(userId, delegateId);
    if (!session) return false;
    return featureSetName in session.declaredFeatureSets;
  }

  /**
   * Gap 1: Validate that a specific capability is enabled for a featureSet.
   * Uses resolveCapabilities() to map dotted uses → internal McplCapability.
   * Returns:
   *   'ok'              — capability is enabled, proceed
   *   'no_session'      — no MCPL session for this delegate
   *   'unknown_server'  — featureSet not in declared (spec: -32003)
   *   'disabled'        — capability exists but is not enabled (spec: -32001)
   */
  validateCapability(
    userId: string,
    delegateId: string,
    featureSetName: string,
    capability: McplCapability,
  ): 'ok' | 'no_session' | 'unknown_server' | 'disabled' {
    const session = this.getSessionForDelegate(userId, delegateId);
    if (!session) return 'no_session';

    const decl = session.declaredFeatureSets[featureSetName];
    if (!decl) return 'unknown_server';

    // Check if feature set is effectively enabled (enabled AND not quarantined)
    if (!session.enabledFeatureSets.has(featureSetName)) return 'disabled';
    if (session.invalidFeatureSets.has(featureSetName)) return 'disabled';

    // Check if the uses resolve to the requested capability
    const resolvedCaps = resolveCapabilities(decl.rawUses);
    return resolvedCaps.includes(capability) ? 'ok' : 'disabled';
  }

  /**
   * Get all declared featureSet names for a specific delegate.
   */
  getFeatureSetNamesForDelegate(userId: string, delegateId: string): string[] {
    const session = this.getSessionForDelegate(userId, delegateId);
    if (!session) return [];
    return Object.keys(session.declaredFeatureSets);
  }

  /**
   * Get all (delegateId, featureSet) entries across active delegates for a user.
   * Iterates delegateIndex (not raw sessions) to avoid stale/duplicate entries.
   */
  getFeatureSetEntriesForUser(userId: string): Array<{ delegateId: string; featureSet: string }> {
    const entries: Array<{ delegateId: string; featureSet: string }> = [];
    const prefix = `${userId}:`;
    for (const [indexKey, sessionId] of this.delegateIndex) {
      if (!indexKey.startsWith(prefix)) continue;
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      for (const name of Object.keys(session.declaredFeatureSets)) {
        entries.push({ delegateId: session.delegateId, featureSet: name });
      }
    }
    return entries;
  }

  /**
   * F14 helper: check if a featureSet has a specific capability.
   */
  static hasUse(fs: McplFeatureSet, capability: McplCapability): boolean {
    const resolved = resolveCapabilities(fs.uses);
    return resolved.includes(capability);
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
   * Spec §5.1: intersect nested capability objects.
   */
  negotiateCapabilities(requested: McplCapabilities): McplCapabilities {
    const result: McplCapabilities = {};
    if (requested.version) result.version = requested.version;
    if (requested.pushEvents) result.pushEvents = true;
    if (requested.contextHooks) {
      result.contextHooks = {};
      if (requested.contextHooks.beforeInference) result.contextHooks.beforeInference = true;
      if (requested.contextHooks.afterInference) {
        result.contextHooks.afterInference = true;  // notification-only, no blocking
      }
    }
    if (requested.inferenceRequest) {
      result.inferenceRequest = { ...requested.inferenceRequest };
    }
    if (requested.modelInfo) result.modelInfo = true;
    if (requested.featureSets) result.featureSets = true;
    if (requested.toolManagement) result.toolManagement = true;
    return result;
  }

  /**
   * Check if a nested McplCapabilities object includes a specific flat capability.
   * Used for backward-compatible internal checks.
   */
  static hasCapability(caps: McplCapabilities, capability: McplCapability): boolean {
    switch (capability) {
      case 'context_hooks': return !!(caps.contextHooks);
      case 'push_events': return !!(caps.pushEvents);
      case 'inference_requests': return !!(caps.inferenceRequest);
      case 'tool_management': return !!(caps.toolManagement);
      default: return false;
    }
  }

  /**
   * Get default feature set for a server (all disabled).
   */
  static defaultFeatureSet(): McplFeatureSet {
    return { uses: [] };
  }

  // ---------------------------------------------------------------------------
  // Reliable channel / pending requests state (for resume)
  // ---------------------------------------------------------------------------

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

  /**
   * Save McplCodec pending requests state on session (for resume across reconnects).
   */
  savePendingRequestsState(sessionId: string, state: PendingRequestsState): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingRequestsState = state;
    }
  }

  /**
   * Get saved pending requests state for resume.
   */
  getPendingRequestsState(sessionId: string): PendingRequestsState | undefined {
    return this.sessions.get(sessionId)?.pendingRequestsState;
  }

  getStats(): { totalSessions: number } {
    return { totalSessions: this.sessions.size };
  }
}

export const mcplSessionManager = new McplSessionManager();
