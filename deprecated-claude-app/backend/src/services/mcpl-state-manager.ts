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
  /** State keyed by conversationId */
  private states: Map<string, Record<string, unknown>> = new Map();

  /** Checkpoint trees per conversation (Phase 8: replaces linear stack) */
  private trees: Map<string, ConversationTree> = new Map();

  /** Mutation count per conversation (for auto-checkpointing) */
  private mutationCounts: Map<string, number> = new Map();

  /** userId per conversation (for event persistence) */
  private userIds: Map<string, string> = new Map();

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
  setUserId(conversationId: string, userId: string): void {
    this.userIds.set(conversationId, userId);
  }

  /**
   * Get current state for a conversation.
   */
  getState(conversationId: string): Record<string, unknown> | undefined {
    return this.states.get(conversationId);
  }

  /**
   * Set (replace) state for a conversation.
   * Triggers auto-checkpoint.
   */
  setState(conversationId: string, state: Record<string, unknown>): void {
    this.states.set(conversationId, state);
    this.incrementMutations(conversationId);
    console.log(`[McplStateManager] State set for conversation ${conversationId}`);
  }

  /**
   * Apply JSON Patch (RFC 6902) to conversation state.
   * Returns { success: true } or { success: false, error }.
   * Invalid patch or missing state → error, never crash.
   */
  applyPatch(
    conversationId: string,
    patch: unknown[]
  ): { success: boolean; error?: string } {
    const state = this.states.get(conversationId);
    if (!state) {
      return { success: false, error: `No state for conversation ${conversationId}` };
    }

    try {
      const result = fjpApplyPatch(state, patch as Operation[], true, true);

      for (const op of result) {
        if (op && typeof op === 'object' && 'test' in op && !(op as any).test) {
          return { success: false, error: 'JSON Patch test operation failed' };
        }
      }

      this.incrementMutations(conversationId);
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[McplStateManager] Patch failed for ${conversationId}: ${errorMsg}`);
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
    conversationId: string,
    checkpointId?: string,
  ): { exists: true; checkpointId: string } | { exists: false; error: 'expired' | 'unknown' | 'no_checkpoints' } {
    const tree = this.trees.get(conversationId);
    if (!tree || tree.nodes.size === 0) {
      return { exists: false, error: 'no_checkpoints' };
    }

    // Named rollback → upgrade to tree mode (one-way, persisted)
    if (checkpointId) {
      this.ensureTreeMode(conversationId);
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
    conversationId: string,
    checkpointId: string,
  ): { success: true } | { success: false; error: 'rollback_failed' | 'checkpoint_expired' } {
    const tree = this.trees.get(conversationId);
    if (!tree) return { success: false, error: 'rollback_failed' };

    const node = tree.nodes.get(checkpointId);
    if (!node) return { success: false, error: 'checkpoint_expired' };

    // Host-managed: restore state from snapshot
    if (tree.hostManaged) {
      if (!node.state) return { success: false, error: 'rollback_failed' };
      try {
        const restored = JSON.parse(node.state);
        this.states.set(conversationId, restored);
      } catch (err) {
        console.error(`[McplStateManager] Corrupt state in ${checkpointId}:`, err);
        this.removeNode(tree, checkpointId);  // prevent infinite canRollback→commitRollback loop
        return { success: false, error: 'rollback_failed' };
      }
    }
    // Server-managed: don't restore state (caller already has server's state)
    // Just move the tree pointer

    tree.current = checkpointId;
    this.mutationCounts.set(conversationId, 0);  // reset mutation count
    console.log(`[McplStateManager] Rolled back ${conversationId} to ${checkpointId}`);

    // Persist rollback event (fire-and-forget, after state change)
    const userId = this.userIds.get(conversationId);
    if (userId) {
      this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
        _conversationId: conversationId,
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
  rollback(conversationId: string): boolean {
    const check = this.canRollback(conversationId);
    if (!check.exists) return false;
    return this.commitRollback(conversationId, check.checkpointId).success;
  }

  // --------------------------------------------------------------------------
  // Public API — checkpoint list (Phase 8)
  // --------------------------------------------------------------------------

  /**
   * Get checkpoint tree for a conversation (for mcpl/checkpoint_list response).
   */
  getCheckpoints(conversationId: string): {
    current: string;
    checkpoints: Array<{
      id: string; parent: string | null; children: string[];
      createdAt: number; isCurrent: boolean;
      label: string; mutationCount: number;
    }>;
  } | null {
    const tree = this.trees.get(conversationId);
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

  // --------------------------------------------------------------------------
  // Public API — lifecycle
  // --------------------------------------------------------------------------

  /**
   * Cleanup on conversation close.
   */
  cleanup(conversationId: string): void {
    this.states.delete(conversationId);
    this.trees.delete(conversationId);  // nodes + tombstones + counter + mode all go
    this.mutationCounts.delete(conversationId);
    this.userIds.delete(conversationId);
    console.log(`[McplStateManager] Cleaned up state for ${conversationId}`);
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
    const conversationId = data._conversationId as string;
    if (!conversationId) return;

    if (data.action === 'checkpoint') {
      let tree = this.trees.get(conversationId);
      if (!tree) {
        tree = {
          nodes: new Map(), current: '', nextSeq: 0,
          evictedIds: new Set(), hostManaged: (data.hostManaged as boolean) ?? true,
          mode: 'linear',
        };
        this.trees.set(conversationId, tree);
      }

      const id = data.checkpointId as string;
      const parentId = (data.parentId as string) || null;
      const seq = this.parseSeqFromId(id);
      if (seq !== null && seq >= tree.nextSeq) tree.nextSeq = seq;

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
          this.states.set(conversationId, JSON.parse(stateSnapshot));
        } catch { /* corrupted — skip */ }
      }

      // Apply eviction after replay (trim old nodes)
      this.evict(tree);

    } else if (data.action === 'rollback') {
      const tree = this.trees.get(conversationId);
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
            this.states.set(conversationId, JSON.parse(node.state));
          } catch { /* corrupted — skip */ }
        }
      }

    } else if (data.action === 'mode_upgrade') {
      const tree = this.trees.get(conversationId);
      if (tree) tree.mode = (data.mode as 'linear' | 'tree') ?? 'tree';
    }
  }

  // --------------------------------------------------------------------------
  // Internal — mutation tracking
  // --------------------------------------------------------------------------

  private incrementMutations(conversationId: string): void {
    const count = (this.mutationCounts.get(conversationId) || 0) + 1;
    this.mutationCounts.set(conversationId, count);

    if (count % McplStateManager.CHECKPOINT_INTERVAL === 0) {
      this.checkpoint(conversationId, count);
    }
  }

  // --------------------------------------------------------------------------
  // Internal — checkpoint creation
  // --------------------------------------------------------------------------

  private checkpoint(conversationId: string, seq: number): void {
    const state = this.states.get(conversationId);
    if (!state) return;

    let tree = this.trees.get(conversationId);
    if (!tree) {
      tree = {
        nodes: new Map(),
        current: '',
        nextSeq: 0,
        evictedIds: new Set(),
        hostManaged: true,
        mode: 'linear',
      };
      this.trees.set(conversationId, tree);
    }

    try {
      const snapshot = tree.hostManaged ? JSON.stringify(state) : null;

      // State cap: skip checkpoint if state too large
      if (snapshot && snapshot.length > McplStateManager.MAX_STATE_BYTES) {
        console.warn(`[McplStateManager] State too large (${snapshot.length}B), skipping checkpoint for ${conversationId}`);
        return;
      }

      const id = this.allocateId(tree);
      const parentId = tree.current || null;

      const mutCount = this.mutationCounts.get(conversationId) ?? 0;
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

      // Link parent → child
      if (parentId) {
        const parentNode = tree.nodes.get(parentId);
        if (parentNode) parentNode.children.push(id);
      }

      tree.current = id;
      this.evict(tree);

      console.log(`[McplStateManager] Checkpoint ${id} for ${conversationId} (nodes=${tree.nodes.size})`);

      // Persist checkpoint event (fire-and-forget, after state change)
      const userId = this.userIds.get(conversationId);
      if (userId) {
        this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
          _conversationId: conversationId,
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
      console.warn(`[McplStateManager] Failed to create checkpoint for ${conversationId}:`, err);
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
  private ensureTreeMode(conversationId: string): void {
    const tree = this.trees.get(conversationId);
    if (!tree || tree.mode === 'tree') return;

    tree.mode = 'tree';
    const userId = this.userIds.get(conversationId);
    if (userId) {
      this.db?.appendMcplUserEvent(userId, 'checkpoint_tree_updated', {
        _conversationId: conversationId,
        action: 'mode_upgrade',
        mode: 'tree',
      } as Record<string, unknown>).catch(err =>
        console.warn('[McplStateManager] Failed to persist mode upgrade:', err)
      );
    }
    console.log(`[McplStateManager] ${conversationId} upgraded to tree mode`);
  }

  // --------------------------------------------------------------------------
  // Internal — node removal (corrupt state cleanup)
  // --------------------------------------------------------------------------

  /**
   * Remove a node from tree (corrupt state, etc).
   * Reparents children to node's parent, adds tombstone in tree mode.
   * Prevents infinite canRollback→commitRollback loop on corrupt nodes.
   */
  private removeNode(tree: ConversationTree, nodeId: string): void {
    const node = tree.nodes.get(nodeId);
    if (!node) return;

    // Reparent children to node's parent
    for (const childId of node.children) {
      const child = tree.nodes.get(childId);
      if (child) child.parent = node.parent;
    }

    // Update parent's children list
    if (node.parent) {
      const parent = tree.nodes.get(node.parent);
      if (parent) {
        parent.children = parent.children.filter(c => c !== nodeId);
        parent.children.push(...node.children);
      }
    }

    tree.nodes.delete(nodeId);

    // Tombstone if tree mode
    if (tree.mode === 'tree') {
      tree.evictedIds.add(nodeId);
      if (tree.evictedIds.size > McplStateManager.MAX_TOMBSTONES) {
        const oldest = tree.evictedIds.values().next().value;
        if (oldest) tree.evictedIds.delete(oldest);
      }
    }

    // If current pointed to removed node, move to parent
    if (tree.current === nodeId) {
      tree.current = node.parent ?? '';
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
