/**
 * MCPL State Manager
 *
 * Conversation-scoped mutable state with checkpoint tree and two-phase rollback.
 *
 * Phase 8: Checkpoint tree replaces Phase 7's linear stack.
 *   - Monotonic counter for node IDs (++nextSeq, not .size)
 *   - Dual mode: linear (chain) → tree (branch). Auto-upgrade on first named rollback.
 *   - Linear mode: trimChain eviction (oldest ancestor), no tombstones.
 *   - Tree mode: evictTree (protect root→current, evict oldest off-branch leaves), tombstones.
 *   - Two-phase rollback: canRollback() + commitRollback(). No immediate pointer move.
 *   - removeNode() on corrupt state prevents infinite canRollback→commitRollback loop.
 *   - State cap: MAX_STATE_BYTES=256KB, skip checkpoint if state larger.
 *   - Event persistence: fire-and-forget after state change, not gatekeeper.
 *   - hostManaged flag: true = host stores snapshots, false = lineage only (server-managed).
 */

// NOTE: import from index.mjs explicitly — tsx resolves the package's index.ts
// (a source file with require('./src/core')) instead of the compiled index.js/index.mjs.
import { applyPatch as fjpApplyPatch } from 'fast-json-patch/index.mjs';
import type { Operation } from 'fast-json-patch';
import type { Database } from '../database/index.js';

// =============================================================================
// Types
// =============================================================================

interface CheckpointNode {
  id: string;              // "chk_1", "chk_2", ... monotonic
  parent: string | null;   // parent node ID (null = root)
  children: string[];      // child node IDs
  state: string | null;    // JSON-serialized snapshot (null for server-managed)
  createdAt: number;       // Date.now() for eviction ordering
  label: string;           // human-readable: "After 10 mutations"
  mutationCount: number;   // patches since parent checkpoint
}

interface ConversationTree {
  nodes: Map<string, CheckpointNode>;
  current: string;         // active node ID ('' if no checkpoints yet)
  nextSeq: number;         // monotonic counter per conversation, starts 0
  evictedIds: Set<string>; // tombstones: IDs of evicted nodes (tree mode only)
  hostManaged: boolean;    // true = host stores state snapshots; false = only lineage (server-managed)
  mode: 'linear' | 'tree'; // linear = chain eviction, tree = branch eviction + tombstones
}

// =============================================================================
// McplStateManager
// =============================================================================

export class McplStateManager {
  /** H8+L2: State keyed by compound key `${featureSet}:${conversationId}` (spec §8) */
  private states: Map<string, Record<string, unknown>> = new Map();

  /** S-6 fix: Monotonic version counter per compound key for CAS checks. */
  private stateVersions: Map<string, number> = new Map();

  /** Checkpoint trees per compound key (Phase 8: replaces linear stack) */
  private trees: Map<string, ConversationTree> = new Map();

  /** Mutation count per compound key (for auto-checkpointing) */
  private mutationCounts: Map<string, number> = new Map();

  /** userId per compound key (for event persistence) */
  private userIds: Map<string, string> = new Map();

  /** H8+L2: Build compound key from featureSet + conversationId (spec §8) */
  private compoundKey(featureSet: string, conversationId: string): string {
    return featureSet ? `${featureSet}:${conversationId}` : conversationId;
  }

  /** Extract featureSet and conversationId from compound key */
  private parseCompoundKey(key: string): { featureSet: string; conversationId: string } {
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) return { featureSet: '', conversationId: key };
    return { featureSet: key.slice(0, colonIdx), conversationId: key.slice(colonIdx + 1) };
  }

  /** Database reference for event persistence */
  private db: Database | null = null;

  private static readonly MAX_NODES = 50;
  private static readonly MAX_TOMBSTONES = 200;
  private static readonly MAX_STATE_BYTES = 256 * 1024;  // 256KB
  private static readonly CHECKPOINT_INTERVAL = 10;

  // --------------------------------------------------------------------------
  // Database wiring
  // --------------------------------------------------------------------------

  setDatabase(db: Database): void {
    this.db = db;
  }

  // --------------------------------------------------------------------------
  // Public API — state operations (unchanged signatures)
  // --------------------------------------------------------------------------

  /**
   * Set the userId for a conversation (for event persistence).
   * Must be called from delegate-handler before every state operation.
   */
  setUserId(featureSet: string, conversationId: string, userId: string): void {
    this.userIds.set(this.compoundKey(featureSet, conversationId), userId);
  }

  /**
   * Get current state for a conversation.
   */
  getState(featureSet: string, conversationId: string): Record<string, unknown> | undefined {
    return this.states.get(this.compoundKey(featureSet, conversationId));
  }

  /**
   * S-6 fix: Get the current state version for CAS checks.
   * Tools should read this before executing, then pass it as expectedVersion
   * to setState/applyPatch to detect concurrent modifications.
   */
  getStateVersion(featureSet: string, conversationId: string): number {
    return this.stateVersions.get(this.compoundKey(featureSet, conversationId)) ?? 0;
  }

  /**
   * Set (replace) state for a conversation.
   * Triggers auto-checkpoint.
   *
   * @param expectedVersion  S-6 fix: If provided, rejects the write when the
   *   current version doesn't match (compare-and-swap). Prevents stale writes
   *   that could cause irreversible side effects on effectful tools.
   */
  setState(
    featureSet: string,
    conversationId: string,
    state: Record<string, unknown>,
    expectedVersion?: number
  ): { success: boolean; error?: string } {
    const key = this.compoundKey(featureSet, conversationId);
    if (expectedVersion !== undefined) {
      const current = this.stateVersions.get(key) ?? 0;
      if (current !== expectedVersion) {
        return {
          success: false,
          error: `State version conflict: expected ${expectedVersion}, current ${current}. Re-read state before retrying.`,
        };
      }
    }

    this.states.set(key, state);
    this.stateVersions.set(key, (this.stateVersions.get(key) ?? 0) + 1);
    this.incrementMutations(key);
    console.log(`[McplStateManager] State set for ${key} (v${this.stateVersions.get(key)})`);
    return { success: true };
  }

  /**
   * Apply JSON Patch (RFC 6902) to conversation state.
   * Returns { success: true } or { success: false, error }.
   * Invalid patch or missing state → error, never crash.
   *
   * @param expectedVersion  S-6 fix: Optional CAS guard (same as setState).
   */
  applyPatch(
    featureSet: string,
    conversationId: string,
    patch: unknown[],
    expectedVersion?: number
  ): { success: boolean; error?: string } {
    const key = this.compoundKey(featureSet, conversationId);
    if (expectedVersion !== undefined) {
      const current = this.stateVersions.get(key) ?? 0;
      if (current !== expectedVersion) {
        return {
          success: false,
          error: `State version conflict: expected ${expectedVersion}, current ${current}. Re-read state before retrying.`,
        };
      }
    }

    const state = this.states.get(key);
    if (!state) {
      return { success: false, error: `No state for ${key}` };
    }

    try {
      const result = fjpApplyPatch(state, patch as Operation[], true, true);

      for (const op of result) {
        if (op && typeof op === 'object' && 'test' in op && !(op as any).test) {
          return { success: false, error: 'JSON Patch test operation failed' };
        }
      }

      this.stateVersions.set(key, (this.stateVersions.get(key) ?? 0) + 1);
      this.incrementMutations(key);
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[McplStateManager] Patch failed for ${key}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  // --------------------------------------------------------------------------
  // Public API — two-phase rollback (Phase 8)
  // --------------------------------------------------------------------------

  /**
   * Phase 1: Check if rollback is possible.
   * Named rollback (checkpointId provided) triggers one-way upgrade to tree mode.
   */
  canRollback(
    featureSet: string,
    conversationId: string,
    checkpointId?: string,
  ): { exists: true; checkpointId: string } | { exists: false; error: 'expired' | 'unknown' | 'no_checkpoints' } {
    const key = this.compoundKey(featureSet, conversationId);
    const tree = this.trees.get(key);
    if (!tree || tree.nodes.size === 0) {
      return { exists: false, error: 'no_checkpoints' };
    }

    // Named rollback → upgrade to tree mode (one-way, persisted)
    if (checkpointId) {
      this.ensureTreeMode(key);
    }

    // If no checkpointId, resolve to parent of current
    const targetId = checkpointId ?? this.resolveParent(tree);
    if (!targetId) {
      return { exists: false, error: 'no_checkpoints' };
    }

    const node = tree.nodes.get(targetId);
    if (!node) {
      // Use tombstones for reliable expired/unknown distinction (tree mode)
      // In linear mode (no tombstones), unknown IDs all return 'unknown'
      if (tree.evictedIds.has(targetId)) {
        return { exists: false, error: 'expired' };
      }
      return { exists: false, error: 'unknown' };
    }

    // Host-managed: verify state snapshot exists (could be null after restart with old events)
    if (tree.hostManaged && node.state === null) {
      return { exists: false, error: 'expired' };
    }

    return { exists: true, checkpointId: targetId };
  }

  /**
   * Phase 2: Commit the rollback (move tree pointer, restore state).
   * For host-managed: immediate. For server-managed (8b): caller waits for server first.
   */
  commitRollback(
    featureSet: string,
    conversationId: string,
    checkpointId: string,
  ): { success: true } | { success: false; error: 'rollback_failed' | 'checkpoint_expired' } {
    const key = this.compoundKey(featureSet, conversationId);
    const tree = this.trees.get(key);
    if (!tree) return { success: false, error: 'rollback_failed' };

    const node = tree.nodes.get(checkpointId);
    if (!node) return { success: false, error: 'checkpoint_expired' };

    // Host-managed: restore state from snapshot
    if (tree.hostManaged) {
      if (!node.state) return { success: false, error: 'rollback_failed' };
      try {
        const restored = JSON.parse(node.state);
        this.states.set(key, restored);
      } catch (err) {
        console.error(`[McplStateManager] Corrupt state in ${checkpointId}:`, err);
        this.removeNode(tree, checkpointId, key);
        return { success: false, error: 'rollback_failed' };
      }
    }

    tree.current = checkpointId;
    this.mutationCounts.set(key, 0);
    console.log(`[McplStateManager] Rolled back ${key} to ${checkpointId}`);

    const userId = this.userIds.get(key);
    if (userId) {
      this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
        _compoundKey: key,
        _conversationId: conversationId,
        _featureSet: featureSet,
        action: 'rollback',
        checkpointId,
      } as Record<string, unknown>).catch(err =>
        console.warn('[McplStateManager] Failed to persist rollback event:', err)
      );
    }

    return { success: true };
  }

  /**
   * Backward compat wrapper — Phase 7 API.
   * Rolls back to parent of current (no named checkpoint).
   */
  rollback(featureSet: string, conversationId: string): boolean {
    const check = this.canRollback(featureSet, conversationId);
    if (!check.exists) return false;
    return this.commitRollback(featureSet, conversationId, check.checkpointId).success;
  }

  /**
   * Atomic can+commit — eliminates TOCTOU window between canRollback/commitRollback.
   * Used by WS handler for checkpoint_rollback messages.
   */
  tryRollback(
    featureSet: string,
    conversationId: string,
    checkpointId?: string,
  ): { success: true; checkpointId: string } | { success: false; error: 'expired' | 'unknown' | 'no_checkpoints' | 'rollback_failed' } {
    const check = this.canRollback(featureSet, conversationId, checkpointId);
    if (!check.exists) {
      return { success: false, error: check.error };
    }
    const result = this.commitRollback(featureSet, conversationId, check.checkpointId);
    if (result.success) {
      return { success: true, checkpointId: check.checkpointId };
    }
    // commitRollback failed — map error
    return {
      success: false,
      error: result.error === 'checkpoint_expired' ? 'expired' : 'rollback_failed',
    };
  }

  // --------------------------------------------------------------------------
  // Public API — checkpoint list (Phase 8)
  // --------------------------------------------------------------------------

  /**
   * Get checkpoint tree for a conversation (for mcpl/checkpoint_list response).
   */
  getCheckpoints(featureSet: string, conversationId: string): {
    current: string;
    checkpoints: Array<{
      id: string; parent: string | null; children: string[];
      createdAt: number; isCurrent: boolean;
      label: string; mutationCount: number;
    }>;
  } | null {
    const tree = this.trees.get(this.compoundKey(featureSet, conversationId));
    if (!tree || tree.nodes.size === 0) return null;

    const checkpoints = [];
    for (const node of tree.nodes.values()) {
      checkpoints.push({
        id: node.id,
        parent: node.parent,
        children: [...node.children],
        createdAt: node.createdAt,
        isCurrent: node.id === tree.current,
        label: node.label,
        mutationCount: node.mutationCount,
      });
    }
    return { current: tree.current, checkpoints };
  }

  /**
   * Get state snapshot at a specific checkpoint (read-only, no rollback).
   * V1 limitation: featureSet defaults to '' in frontend — only queries default featureSet.
   */
  getStateAtCheckpoint(
    featureSet: string, conversationId: string, checkpointId: string
  ): { state: Record<string, unknown> } | { error: 'no_checkpoints' | 'unknown' | 'expired' | 'no_snapshot' } {
    const key = this.compoundKey(featureSet, conversationId);
    const tree = this.trees.get(key);
    if (!tree || tree.nodes.size === 0) return { error: 'no_checkpoints' };

    const node = tree.nodes.get(checkpointId);
    if (!node) {
      return { error: tree.evictedIds.has(checkpointId) ? 'expired' : 'unknown' };
    }
    if (node.state === null) return { error: 'no_snapshot' };

    try {
      return { state: JSON.parse(node.state) };
    } catch {
      return { error: 'no_snapshot' };
    }
  }

  // --------------------------------------------------------------------------
  // Public API — lifecycle
  // --------------------------------------------------------------------------

  /**
   * Cleanup on conversation close.
   */
  cleanup(featureSet: string, conversationId: string): void {
    const key = this.compoundKey(featureSet, conversationId);
    this.states.delete(key);
    this.trees.delete(key);
    this.mutationCounts.delete(key);
    this.userIds.delete(key);
    console.log(`[McplStateManager] Cleaned up state for ${key}`);
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): {
    totalConversations: number;
    totalNodes: number;
    maxTreeDepth: number;
  } {
    let totalNodes = 0;
    let maxTreeDepth = 0;

    for (const tree of this.trees.values()) {
      totalNodes += tree.nodes.size;
      let depth = 0;
      let nodeId: string | null = tree.current;
      while (nodeId) {
        depth++;
        nodeId = tree.nodes.get(nodeId)?.parent ?? null;
      }
      maxTreeDepth = Math.max(maxTreeDepth, depth);
    }

    return { totalConversations: this.states.size, totalNodes, maxTreeDepth };
  }

  // --------------------------------------------------------------------------
  // Public API — event replay (Phase 8 persistence)
  // --------------------------------------------------------------------------

  /**
   * Replay a checkpoint tree event from the event store.
   * Called from index.ts via db.onReplayEvent('checkpoint_tree_updated').
   */
  replayCheckpointEvent(data: Record<string, unknown>): void {
    // Compound key resolution: _compoundKey > _featureSet:_conversationId > _conversationId (legacy)
    let key: string;
    if (data._compoundKey) {
      key = data._compoundKey as string;
    } else if (data._featureSet != null && data._conversationId) {
      key = this.compoundKey(data._featureSet as string, data._conversationId as string);
    } else if (data._conversationId) {
      key = this.compoundKey('', data._conversationId as string); // legacy: empty featureSet
    } else {
      return;
    }

    if (data.action === 'checkpoint') {
      let tree = this.trees.get(key);
      if (!tree) {
        tree = {
          nodes: new Map(), current: '', nextSeq: 0,
          evictedIds: new Set(), hostManaged: (data.hostManaged as boolean) ?? true,
          mode: 'linear',
        };
        this.trees.set(key, tree);
      }

      const id = data.checkpointId as string;
      const parentId = (data.parentId as string) || null;
      const seq = this.parseSeqFromId(id);
      if (seq !== null && seq >= tree.nextSeq) tree.nextSeq = seq;

      // First-write-wins: skip duplicate checkpoint IDs (corrupted JSONL)
      if (tree.nodes.has(id)) {
        console.warn(`[McplStateManager] Replay skipping duplicate checkpoint ${id}`);
        return;
      }

      // Approach (a): restore state snapshot from event
      const stateSnapshot = (data.state as string) ?? null;

      const node: CheckpointNode = {
        id, parent: parentId, children: [], state: stateSnapshot,
        createdAt: (data.createdAt as number) ?? 0,
        label: (data.label as string) ?? `Checkpoint ${id}`,
        mutationCount: (data.mutationCount as number) ?? 0,
      };
      tree.nodes.set(id, node);
      if (parentId) {
        const parent = tree.nodes.get(parentId);
        if (parent && !parent.children.includes(id)) parent.children.push(id);
      }
      tree.current = id;

      // Also restore live state from latest checkpoint
      if (stateSnapshot && tree.hostManaged) {
        try {
          this.states.set(key, JSON.parse(stateSnapshot));
        } catch { /* corrupted — skip */ }
      }

      // Apply eviction after replay (trim old nodes)
      this.evict(tree);

    } else if (data.action === 'rollback') {
      const tree = this.trees.get(key);
      if (tree && data.checkpointId) {
        const id = data.checkpointId as string;
        // Guard: skip if node doesn't exist (corrupted JSONL, partial write)
        if (!tree.nodes.has(id)) {
          console.warn(`[McplStateManager] Replay rollback references unknown ${id}, skipping`);
          return;
        }
        tree.current = id;
        // Restore live state from rolled-back-to node
        const node = tree.nodes.get(id);
        if (node?.state && tree.hostManaged) {
          try {
            this.states.set(key, JSON.parse(node.state));
          } catch { /* corrupted — skip */ }
        }
      }

    } else if (data.action === 'remove_node') {
      const tree = this.trees.get(key);
      if (tree) {
        const nodeId = data.nodeId as string;
        if (nodeId && tree.nodes.has(nodeId)) {
          this.removeNode(tree, nodeId, key, false);  // persist=false: event already in log
        }
      }

    } else if (data.action === 'mode_upgrade') {
      const tree = this.trees.get(key);
      if (tree) tree.mode = (data.mode as 'linear' | 'tree') ?? 'tree';
    }
  }

  // --------------------------------------------------------------------------
  // Internal — mutation tracking
  // --------------------------------------------------------------------------

  private incrementMutations(key: string): void {
    const count = (this.mutationCounts.get(key) || 0) + 1;
    this.mutationCounts.set(key, count);

    if (count % McplStateManager.CHECKPOINT_INTERVAL === 0) {
      this.checkpoint(key, count);
    }
  }

  // --------------------------------------------------------------------------
  // Internal — checkpoint creation
  // --------------------------------------------------------------------------

  private checkpoint(key: string, seq: number): void {
    const state = this.states.get(key);
    if (!state) return;

    let tree = this.trees.get(key);
    if (!tree) {
      tree = {
        nodes: new Map(),
        current: '',
        nextSeq: 0,
        evictedIds: new Set(),
        hostManaged: true,
        mode: 'linear',
      };
      this.trees.set(key, tree);
    }

    try {
      const snapshot = tree.hostManaged ? JSON.stringify(state) : null;

      if (snapshot && snapshot.length > McplStateManager.MAX_STATE_BYTES) {
        console.warn(`[McplStateManager] State too large (${snapshot.length}B), skipping checkpoint for ${key}`);
        return;
      }

      const id = this.allocateId(tree);
      const parentId = tree.current || null;

      const mutCount = this.mutationCounts.get(key) ?? 0;
      const node: CheckpointNode = {
        id,
        parent: parentId,
        children: [],
        state: snapshot,
        createdAt: Date.now(),
        label: `After ${mutCount} mutations`,
        mutationCount: mutCount,
      };

      tree.nodes.set(id, node);

      if (parentId) {
        const parentNode = tree.nodes.get(parentId);
        if (parentNode) parentNode.children.push(id);
      }

      tree.current = id;
      this.evict(tree);

      console.log(`[McplStateManager] Checkpoint ${id} for ${key} (nodes=${tree.nodes.size})`);

      const userId = this.userIds.get(key);
      if (userId) {
        const { featureSet: _fs, conversationId: _cid } = this.parseCompoundKey(key);
        this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
          _compoundKey: key,
          _conversationId: _cid,
          _featureSet: _fs,
          action: 'checkpoint',
          checkpointId: id,
          parentId: parentId,
          hostManaged: tree.hostManaged,
          state: snapshot,
          label: node.label,
          mutationCount: node.mutationCount,
          createdAt: node.createdAt,
        } as Record<string, unknown>).catch(err =>
          console.warn('[McplStateManager] Failed to persist checkpoint event:', err)
        );
      }
    } catch (err) {
      console.warn(`[McplStateManager] Failed to create checkpoint for ${key}:`, err);
    }
  }

  private allocateId(tree: ConversationTree): string {
    return `chk_${++tree.nextSeq}`;
  }

  // --------------------------------------------------------------------------
  // Internal — eviction
  // --------------------------------------------------------------------------

  private evict(tree: ConversationTree): void {
    if (tree.mode === 'linear') {
      this.trimChain(tree);
    } else {
      this.evictTree(tree);
    }
  }

  /**
   * Linear mode: evict oldest ancestor (root of chain).
   * No tombstones — linear mode doesn't use named rollback.
   * Reparent children to null (they become new roots).
   */
  private trimChain(tree: ConversationTree): void {
    // Walk from current to root, build chain
    const chain: string[] = [];
    let walk: string | null = tree.current;
    while (walk) {
      chain.push(walk);
      walk = tree.nodes.get(walk)?.parent ?? null;
    }
    // chain[0] = current, chain[last] = root

    while (chain.length > McplStateManager.MAX_NODES) {
      const oldest = chain.pop()!;
      const node = tree.nodes.get(oldest);
      if (node) {
        // Reparent children to null
        for (const childId of node.children) {
          const child = tree.nodes.get(childId);
          if (child) child.parent = null;
        }
        tree.nodes.delete(oldest);
        // NO tombstone — linear mode, nobody will ask for this ID
      }
    }
  }

  /**
   * Tree mode: protect root→current branch, evict oldest off-branch leaves.
   * Add tombstones for evicted nodes (reliable expired/unknown).
   * Note: O(n²) due to per-iteration candidate recomputation. Conscious choice
   * for MAX_NODES=50 (negligible). Single-pass optimization deferred.
   */
  private evictTree(tree: ConversationTree): void {
    if (tree.nodes.size <= McplStateManager.MAX_NODES) return;

    // Build active branch set: root → current
    const activeBranch = new Set<string>();
    let walk: string | null = tree.current;
    while (walk) {
      activeBranch.add(walk);
      const node = tree.nodes.get(walk);
      walk = node?.parent ?? null;
    }

    // Evict oldest off-branch leaves until within limit
    while (tree.nodes.size > McplStateManager.MAX_NODES) {
      const candidates: CheckpointNode[] = [];
      for (const node of tree.nodes.values()) {
        if (node.children.length === 0 && !activeBranch.has(node.id)) {
          candidates.push(node);
        }
      }

      // All leaves on active branch → stop (allow exceeding MAX_NODES)
      if (candidates.length === 0) break;

      candidates.sort((a, b) => a.createdAt - b.createdAt);
      const victim = candidates[0];

      // Unlink from parent
      if (victim.parent) {
        const parent = tree.nodes.get(victim.parent);
        if (parent) {
          parent.children = parent.children.filter(c => c !== victim.id);
        }
      }

      tree.nodes.delete(victim.id);

      // Add tombstone (cap size to prevent unbounded growth)
      tree.evictedIds.add(victim.id);
      if (tree.evictedIds.size > McplStateManager.MAX_TOMBSTONES) {
        const oldest = tree.evictedIds.values().next().value;
        if (oldest) tree.evictedIds.delete(oldest);
      }

      console.log(`[McplStateManager] Evicted ${victim.id}`);
    }
  }

  // --------------------------------------------------------------------------
  // Internal — mode management
  // --------------------------------------------------------------------------

  /**
   * One-way upgrade from linear to tree mode.
   * Triggered on first named rollback (checkpointId provided).
   * Persisted so upgrade survives restart.
   */
  private ensureTreeMode(key: string): void {
    const tree = this.trees.get(key);
    if (!tree || tree.mode === 'tree') return;

    tree.mode = 'tree';
    const userId = this.userIds.get(key);
    if (userId) {
      const { featureSet: _fs, conversationId: _cid } = this.parseCompoundKey(key);
      this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
        _compoundKey: key,
        _conversationId: _cid,
        _featureSet: _fs,
        action: 'mode_upgrade',
        mode: 'tree',
      } as Record<string, unknown>).catch(err =>
        console.warn('[McplStateManager] Failed to persist mode upgrade:', err)
      );
    }
    console.log(`[McplStateManager] ${key} upgraded to tree mode`);
  }

  // --------------------------------------------------------------------------
  // Internal — node removal (corrupt state cleanup)
  // --------------------------------------------------------------------------

  /**
   * Remove a node from tree (corrupt state, etc).
   * Reparents children to node's parent, adds tombstone in tree mode.
   * Prevents infinite canRollback→commitRollback loop on corrupt nodes.
   *
   * @param persist — if true, persist a remove_node event so the removal survives restart.
   *                  Set to false during replay (the event already exists in the log).
   */
  private removeNode(tree: ConversationTree, nodeId: string, key?: string, persist = true): void {
    const node = tree.nodes.get(nodeId);
    if (!node) return;

    for (const childId of node.children) {
      const child = tree.nodes.get(childId);
      if (child) child.parent = node.parent;
    }

    if (node.parent) {
      const parent = tree.nodes.get(node.parent);
      if (parent) {
        parent.children = parent.children.filter(c => c !== nodeId);
        parent.children.push(...node.children);
      }
    }

    tree.nodes.delete(nodeId);

    if (tree.mode === 'tree') {
      tree.evictedIds.add(nodeId);
      if (tree.evictedIds.size > McplStateManager.MAX_TOMBSTONES) {
        const oldest = tree.evictedIds.values().next().value;
        if (oldest) tree.evictedIds.delete(oldest);
      }
    }

    if (tree.current === nodeId) {
      tree.current = node.parent ?? '';
    }

    if (persist && key) {
      const userId = this.userIds.get(key);
      if (userId) {
        const { featureSet: _fs, conversationId: _cid } = this.parseCompoundKey(key);
        this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
          _compoundKey: key,
          _conversationId: _cid,
          _featureSet: _fs,
          action: 'remove_node',
          nodeId,
        } as Record<string, unknown>).catch(err =>
          console.warn('[McplStateManager] Failed to persist remove_node event:', err)
        );
      }
    }

    console.warn(`[McplStateManager] Removed corrupt node ${nodeId}`);
  }

  // --------------------------------------------------------------------------
  // Internal — helpers
  // --------------------------------------------------------------------------

  private resolveParent(tree: ConversationTree): string | null {
    if (!tree.current) return null;
    return tree.nodes.get(tree.current)?.parent ?? null;
  }

  private parseSeqFromId(id: string): number | null {
    const match = id.match(/^chk_(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
}

export const mcplStateManager = new McplStateManager();
