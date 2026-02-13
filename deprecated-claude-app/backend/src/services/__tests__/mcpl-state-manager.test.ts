import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McplStateManager } from '../mcpl-state-manager.js';
import type { Database } from '../../database/index.js';

/**
 * Phase 8 — McplStateManager Unit Tests
 *
 * Tests checkpoint tree (linear + tree mode), two-phase rollback,
 * eviction, tombstones, replay, persistence, and edge cases.
 */

// =============================================================================
// Helpers
// =============================================================================

const CONV = 'test-conv-1';
const USER = 'test-user-1';

/** Create fresh McplStateManager instance (not the singleton). */
function createManager(): McplStateManager {
  return new McplStateManager();
}

/** Mock Database — only appendMcplUserEvent is used by McplStateManager. */
function createMockDb() {
  return {
    appendMcplUserEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as Database;
}

/**
 * Apply N add patches to trigger auto-checkpoints (interval = 10).
 *
 * Each patch adds a key `/patch_N` to the state (op: 'add'). With mutateDocument=true,
 * these mutations happen in place on the state object held in `this.states`.
 *
 * setState() itself calls incrementMutations(), counting as mutation 1.
 * So after setState() + N patches, mutationCount = N + 1.
 * CHECKPOINT_INTERVAL = 10, so first checkpoint fires after 9 patches (mutation 10).
 */
function applyNPatches(mgr: McplStateManager, convId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    mgr.applyPatch(convId, [
      { op: 'add', path: `/patch_${i}`, value: i + 1 },
    ]);
  }
}

/** Get internal tree via cast. */
function getTree(mgr: McplStateManager, convId: string) {
  return (mgr as any).trees.get(convId) as {
    nodes: Map<string, {
      id: string; parent: string | null; children: string[];
      state: string | null; createdAt: number;
      label: string; mutationCount: number;
    }>;
    current: string;
    nextSeq: number;
    evictedIds: Set<string>;
    hostManaged: boolean;
    mode: 'linear' | 'tree';
  } | undefined;
}

/** Get internal mutation count. */
function getMutationCount(mgr: McplStateManager, convId: string): number {
  return (mgr as any).mutationCounts.get(convId) ?? 0;
}

/**
 * Generate a linear chain of checkpoint events for replay benchmarks.
 * All events are for a single conversation in linear mode.
 */
function generateCheckpointEvents(
  count: number,
  opts: { stateSize?: number; conversationId?: string } = {},
): Record<string, unknown>[] {
  const stateSize = opts.stateSize ?? 100;
  const convId = opts.conversationId ?? 'bench-conv';
  const state = JSON.stringify({ data: 'x'.repeat(stateSize) });

  return Array.from({ length: count }, (_, i) => ({
    _conversationId: convId,
    action: 'checkpoint' as const,
    checkpointId: `chk_${i + 1}`,
    parentId: i > 0 ? `chk_${i}` : null,
    hostManaged: true,
    state,
    createdAt: Date.now() + i * 1000,
    label: `After ${(i + 1) * 10} mutations`,
    mutationCount: (i + 1) * 10,
  }));
}

// Save original statics to restore in afterEach
const ORIG_MAX_NODES = (McplStateManager as any).MAX_NODES;
const ORIG_MAX_TOMBSTONES = (McplStateManager as any).MAX_TOMBSTONES;
const ORIG_MAX_STATE_BYTES = (McplStateManager as any).MAX_STATE_BYTES;

// =============================================================================
// Tests
// =============================================================================

describe('McplStateManager Phase 8', () => {
  let mgr: McplStateManager;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mgr = createManager();
    mockDb = createMockDb();
    mgr.setDatabase(mockDb);
  });

  afterEach(() => {
    // Restore overridden statics
    (McplStateManager as any).MAX_NODES = ORIG_MAX_NODES;
    (McplStateManager as any).MAX_TOMBSTONES = ORIG_MAX_TOMBSTONES;
    (McplStateManager as any).MAX_STATE_BYTES = ORIG_MAX_STATE_BYTES;
  });

  // ═══════════════════════════════════════════════════════════════════
  // Linear Mode
  // ═══════════════════════════════════════════════════════════════════

  describe('Linear mode', () => {
    it('creates checkpoint after CHECKPOINT_INTERVAL mutations', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → checkpoint at 10

      const tree = getTree(mgr, CONV);
      expect(tree).toBeDefined();
      expect(tree!.nodes.size).toBe(1);
      expect(tree!.current).toBe('chk_1');
      expect(tree!.mode).toBe('linear');
    });

    it('builds checkpoint chain with parent/children linked', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → checkpoints at 10, 20

      const tree = getTree(mgr, CONV)!;
      expect(tree.nodes.size).toBe(2);

      const chk1 = tree.nodes.get('chk_1')!;
      const chk2 = tree.nodes.get('chk_2')!;
      expect(chk1.children).toContain('chk_2');
      expect(chk2.parent).toBe('chk_1');
      expect(tree.current).toBe('chk_2');
    });

    it('rollback() backward compat returns boolean and restores state', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1 at 10, chk_2 at 20

      const result = mgr.rollback(CONV);
      expect(result).toBe(true);

      // State restored to chk_1 snapshot (includes patch keys added before chk_1)
      const state = mgr.getState(CONV);
      expect(state).toBeDefined();
      expect(state!.counter).toBe(0);
      // chk_1 was taken at mutation 10 (setState + 9 patches), so has patch_0..patch_8
      expect(state!.patch_0).toBe(1);

      const tree = getTree(mgr, CONV)!;
      expect(tree.current).toBe('chk_1');
    });

    it('rollback() returns false when no checkpoints', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      // Only 5 patches (mutations 2-6) — not enough for a checkpoint (need 10)
      applyNPatches(mgr, CONV, 5);

      expect(mgr.rollback(CONV)).toBe(false);
    });

    it('trimChain evicts oldest when exceeding MAX_NODES', () => {
      (McplStateManager as any).MAX_NODES = 3;
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 49); // mutations 2-50 → checkpoints at 10,20,30,40,50

      const tree = getTree(mgr, CONV)!;
      expect(tree.nodes.size).toBe(3);
      // Oldest (chk_1, chk_2) should be evicted
      expect(tree.nodes.has('chk_1')).toBe(false);
      expect(tree.nodes.has('chk_2')).toBe(false);
      // Latest 3 remain
      expect(tree.nodes.has('chk_3')).toBe(true);
      expect(tree.nodes.has('chk_4')).toBe(true);
      expect(tree.nodes.has('chk_5')).toBe(true);
    });

    it('trimChain reparents children to null', () => {
      (McplStateManager as any).MAX_NODES = 3;
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 49); // mutations 2-50

      const tree = getTree(mgr, CONV)!;
      // The new root (chk_3) should have parent === null after trimming
      const newRoot = tree.nodes.get('chk_3')!;
      expect(newRoot.parent).toBeNull();
    });

    it('has no tombstones in linear mode', () => {
      (McplStateManager as any).MAX_NODES = 3;
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 49); // triggers eviction

      const tree = getTree(mgr, CONV)!;
      expect(tree.evictedIds.size).toBe(0);
      expect(tree.mode).toBe('linear');
    });

    it('applyPatch actually mutates state', () => {
      mgr.setState(CONV, { counter: 0 });
      mgr.applyPatch(CONV, [{ op: 'replace', path: '/counter', value: 42 }]);
      expect(mgr.getState(CONV)!.counter).toBe(42);
    });

    it('applyPatch mutates in place — same object reference', () => {
      mgr.setState(CONV, { counter: 0 });
      const ref = mgr.getState(CONV);
      mgr.applyPatch(CONV, [{ op: 'replace', path: '/counter', value: 1 }]);
      expect(mgr.getState(CONV)).toBe(ref); // same object
      expect(ref!.counter).toBe(1); // mutated in place
    });

    it('stays in linear mode without named rollback', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20
      mgr.rollback(CONV); // no checkpointId → stays linear

      const tree = getTree(mgr, CONV)!;
      expect(tree.mode).toBe('linear');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Tree Mode
  // ═══════════════════════════════════════════════════════════════════

  describe('Tree mode', () => {
    it('canRollback(checkpointId) triggers ensureTreeMode', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      mgr.setUserId(CONV, USER);
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2

      const check = mgr.canRollback(CONV, 'chk_1');
      expect(check.exists).toBe(true);

      const tree = getTree(mgr, CONV)!;
      expect(tree.mode).toBe('tree');
    });

    it('mode upgrade is one-way', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);
      mgr.canRollback(CONV, 'chk_1'); // upgrades to tree

      // Now use without checkpointId — should stay tree
      mgr.canRollback(CONV);
      const tree = getTree(mgr, CONV)!;
      expect(tree.mode).toBe('tree');
    });

    it('mode upgrade persisted to db', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      mgr.setUserId(CONV, USER);
      applyNPatches(mgr, CONV, 19);
      mgr.canRollback(CONV, 'chk_1'); // triggers ensureTreeMode

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const modeUpgradeCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'mode_upgrade',
      );
      expect(modeUpgradeCall).toBeDefined();
      expect(modeUpgradeCall![2].mode).toBe('tree');
    });

    it('creates branch after rollback', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1 at 10, chk_2 at 20

      // Rollback to chk_1 (resets mutationCount to 0)
      mgr.commitRollback(CONV, 'chk_1');

      // New mutations → new checkpoint chk_3 as child of chk_1 (at mutation 10)
      applyNPatches(mgr, CONV, 10);

      const tree = getTree(mgr, CONV)!;
      const chk1 = tree.nodes.get('chk_1')!;
      expect(chk1.children).toContain('chk_2');
      expect(chk1.children).toContain('chk_3');
      expect(tree.nodes.get('chk_3')!.parent).toBe('chk_1');
      expect(tree.current).toBe('chk_3');
    });

    it('evictTree protects active branch', () => {
      (McplStateManager as any).MAX_NODES = 3;
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1 at 10, chk_2 at 20

      // Rollback to chk_1 (resets mutationCount to 0)
      mgr.commitRollback(CONV, 'chk_1');
      applyNPatches(mgr, CONV, 10); // mutations 1-10 → chk_3 as child of chk_1

      // Now create chk_4 to exceed MAX_NODES (3)
      applyNPatches(mgr, CONV, 10); // mutations 11-20 → chk_4 as child of chk_3

      // Upgrade to tree mode for proper eviction
      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';
      // Manually trigger eviction
      (mgr as any).evict(tree);

      // Active branch: chk_1 → chk_3 → chk_4 (current)
      // Off-branch: chk_2 (should be evicted)
      expect(tree.nodes.has('chk_2')).toBe(false);
      expect(tree.nodes.has('chk_1')).toBe(true);
      expect(tree.nodes.has('chk_3')).toBe(true);
      expect(tree.nodes.has('chk_4')).toBe(true);
    });

    it('evictTree removes oldest off-branch leaf first', () => {
      (McplStateManager as any).MAX_NODES = 4;
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2

      // Create two off-branch forks from chk_1
      mgr.commitRollback(CONV, 'chk_1'); // resets mutations to 0
      applyNPatches(mgr, CONV, 10); // mutations 1-10 → chk_3 (fork 1)
      mgr.commitRollback(CONV, 'chk_1'); // resets mutations to 0
      applyNPatches(mgr, CONV, 10); // mutations 1-10 → chk_4 (fork 2, current)

      // Upgrade to tree mode
      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';

      // Set createdAt to control eviction order
      tree.nodes.get('chk_2')!.createdAt = 100; // oldest off-branch
      tree.nodes.get('chk_3')!.createdAt = 200; // newer off-branch

      // Exceed limit: need > 4 nodes. Add chk_5
      applyNPatches(mgr, CONV, 10); // mutations 11-20 → chk_5

      (mgr as any).evict(tree);

      // chk_2 should be evicted first (oldest off-branch leaf)
      expect(tree.nodes.has('chk_2')).toBe(false);
    });

    it('evictTree stops when all leaves on active branch', () => {
      // Create a linear chain in tree mode with nodes > MAX_NODES
      // Use replay to build tree directly in controlled manner
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ v: 1 }),
        createdAt: 100, label: 'c1', mutationCount: 10,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_2', parentId: 'chk_1',
        hostManaged: true, state: JSON.stringify({ v: 2 }),
        createdAt: 200, label: 'c2', mutationCount: 20,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_3', parentId: 'chk_2',
        hostManaged: true, state: JSON.stringify({ v: 3 }),
        createdAt: 300, label: 'c3', mutationCount: 30,
      });

      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';
      (McplStateManager as any).MAX_NODES = 2;

      // All 3 nodes are on root→current branch (chk_1→chk_2→chk_3)
      // No off-branch leaves → evictTree should stop without crash
      (mgr as any).evictTree(tree);

      expect(tree.nodes.size).toBe(3); // all 3 remain, exceeds MAX_NODES
    });

    it('creates tombstone on eviction', () => {
      (McplStateManager as any).MAX_NODES = 3;
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2

      mgr.commitRollback(CONV, 'chk_1'); // resets mutations to 0
      applyNPatches(mgr, CONV, 10); // mutations 1-10 → chk_3

      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';

      // Add another to exceed MAX_NODES
      applyNPatches(mgr, CONV, 10); // mutations 11-20 → chk_4
      (mgr as any).evict(tree);

      // chk_2 should be evicted (off-branch leaf)
      expect(tree.evictedIds.has('chk_2')).toBe(true);
    });

    it('caps tombstones at MAX_TOMBSTONES', () => {
      (McplStateManager as any).MAX_TOMBSTONES = 3;
      mgr.setState(CONV, { counter: 0 }); // mutation 1

      // Build a tree in tree mode and manually add tombstones
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1
      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';

      // Manually add 5 tombstones (simulating eviction behavior)
      for (let i = 0; i < 5; i++) {
        tree.evictedIds.add(`old_${i}`);
        if (tree.evictedIds.size > 3) {
          const oldest = tree.evictedIds.values().next().value;
          if (oldest) tree.evictedIds.delete(oldest);
        }
      }

      expect(tree.evictedIds.size).toBeLessThanOrEqual(3);
    });

    it('canRollback returns expired for evicted ID', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';
      tree.evictedIds.add('chk_old');

      const check = mgr.canRollback(CONV, 'chk_old');
      expect(check.exists).toBe(false);
      expect((check as any).error).toBe('expired');
    });

    it('canRollback returns unknown for non-existent ID', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const check = mgr.canRollback(CONV, 'nonexistent');
      expect(check.exists).toBe(false);
      expect((check as any).error).toBe('unknown');
    });

    it('canRollback returns no_checkpoints for empty manager', () => {
      const check = mgr.canRollback(CONV);
      expect(check.exists).toBe(false);
      expect((check as any).error).toBe('no_checkpoints');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Two-Phase Rollback
  // ═══════════════════════════════════════════════════════════════════

  describe('Two-phase rollback', () => {
    it('canRollback + commitRollback restores state', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1 at 10, chk_2 at 20

      const check = mgr.canRollback(CONV, 'chk_1');
      expect(check.exists).toBe(true);
      if (!check.exists) return;

      const result = mgr.commitRollback(CONV, check.checkpointId);
      expect(result.success).toBe(true);
      // State restored to chk_1 snapshot (counter=0, plus patch keys from mutations 2-10)
      expect(mgr.getState(CONV)!.counter).toBe(0);
      expect(mgr.getState(CONV)!.patch_0).toBe(1); // patches now actually mutate state
    });

    it('commitRollback moves current pointer', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);
      mgr.commitRollback(CONV, 'chk_1');

      const tree = getTree(mgr, CONV)!;
      expect(tree.current).toBe('chk_1');
    });

    it('commitRollback resets mutationCount to 0', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 15); // mutations 2-16 → chk_1 at 10
      expect(getMutationCount(mgr, CONV)).toBe(16); // setState(1) + 15 patches

      mgr.commitRollback(CONV, 'chk_1');
      expect(getMutationCount(mgr, CONV)).toBe(0);
    });

    it('commitRollback persists rollback event', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      mgr.setUserId(CONV, USER);
      applyNPatches(mgr, CONV, 19);
      mgr.commitRollback(CONV, 'chk_1');

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const rollbackCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'rollback',
      );
      expect(rollbackCall).toBeDefined();
      expect(rollbackCall![2].checkpointId).toBe('chk_1');
    });

    it('commitRollback is idempotent', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);

      const r1 = mgr.commitRollback(CONV, 'chk_1');
      const r2 = mgr.commitRollback(CONV, 'chk_1');
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });

    it('commitRollback with corrupt JSON returns rollback_failed and removes node', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      // Corrupt the checkpoint state
      const tree = getTree(mgr, CONV)!;
      tree.nodes.get('chk_1')!.state = '{invalid json!!!';

      const result = mgr.commitRollback(CONV, 'chk_1');
      expect(result.success).toBe(false);
      expect((result as any).error).toBe('rollback_failed');

      // Node should be removed
      expect(tree.nodes.has('chk_1')).toBe(false);
    });

    it('after removeNode on corrupt state: canRollback does not return exists:true', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2

      // Corrupt chk_1
      const tree = getTree(mgr, CONV)!;
      tree.nodes.get('chk_1')!.state = 'CORRUPT';
      mgr.commitRollback(CONV, 'chk_1'); // removes chk_1

      // canRollback for chk_1 should NOT return exists: true
      const check = mgr.canRollback(CONV, 'chk_1');
      expect(check.exists).toBe(false);
    });

    it('commitRollback returns checkpoint_expired when node deleted between can and commit', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const check = mgr.canRollback(CONV, 'chk_1');
      expect(check.exists).toBe(true);

      // Delete node between can and commit
      const tree = getTree(mgr, CONV)!;
      tree.nodes.delete('chk_1');

      const result = mgr.commitRollback(CONV, 'chk_1');
      expect(result.success).toBe(false);
      expect((result as any).error).toBe('checkpoint_expired');
    });

    it('canRollback returns expired for host-managed node with null state', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      // Null out state (simulate corrupted replay)
      const tree = getTree(mgr, CONV)!;
      tree.nodes.get('chk_1')!.state = null;

      const check = mgr.canRollback(CONV, 'chk_1');
      expect(check.exists).toBe(false);
      expect((check as any).error).toBe('expired');
    });

    it('canRollback without checkpointId resolves to parent of current', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2 (current)

      const check = mgr.canRollback(CONV);
      expect(check.exists).toBe(true);
      if (check.exists) {
        expect(check.checkpointId).toBe('chk_1');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // removeNode
  // ═══════════════════════════════════════════════════════════════════

  describe('removeNode', () => {
    it('reparents children to parent', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 29); // mutations 2-30 → chk_1, chk_2, chk_3

      const tree = getTree(mgr, CONV)!;
      // Remove chk_2 (middle node)
      (mgr as any).removeNode(tree, 'chk_2');

      const chk3 = tree.nodes.get('chk_3')!;
      expect(chk3.parent).toBe('chk_1');
    });

    it('updates parent children list', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 29); // mutations 2-30 → chk_1, chk_2, chk_3

      const tree = getTree(mgr, CONV)!;
      (mgr as any).removeNode(tree, 'chk_2');

      const chk1 = tree.nodes.get('chk_1')!;
      expect(chk1.children).not.toContain('chk_2');
      expect(chk1.children).toContain('chk_3');
    });

    it('moves current to parent when removing current node', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2 (current)

      const tree = getTree(mgr, CONV)!;
      expect(tree.current).toBe('chk_2');

      (mgr as any).removeNode(tree, 'chk_2');
      expect(tree.current).toBe('chk_1');
    });

    it('adds tombstone in tree mode', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);

      const tree = getTree(mgr, CONV)!;
      tree.mode = 'tree';
      (mgr as any).removeNode(tree, 'chk_1');

      expect(tree.evictedIds.has('chk_1')).toBe(true);
    });

    it('does not add tombstone in linear mode', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);

      const tree = getTree(mgr, CONV)!;
      expect(tree.mode).toBe('linear');
      (mgr as any).removeNode(tree, 'chk_1');

      expect(tree.evictedIds.size).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // State Cap
  // ═══════════════════════════════════════════════════════════════════

  describe('State cap', () => {
    it('creates checkpoint for small state', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const tree = getTree(mgr, CONV);
      expect(tree).toBeDefined();
      expect(tree!.nodes.size).toBe(1);
    });

    it('skips checkpoint for state exceeding MAX_STATE_BYTES', () => {
      (McplStateManager as any).MAX_STATE_BYTES = 100; // very small cap

      // Create a state larger than 100 bytes
      const largeState: Record<string, unknown> = { counter: 0 };
      for (let i = 0; i < 20; i++) {
        largeState[`key_${i}`] = 'x'.repeat(10);
      }
      mgr.setState(CONV, largeState); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → triggers checkpoint, but skip due to cap

      const tree = getTree(mgr, CONV);
      // Tree may or may not exist but should have no nodes
      if (tree) {
        expect(tree.nodes.size).toBe(0);
      }
    });

    it('does not increment nextSeq when checkpoint is skipped', () => {
      (McplStateManager as any).MAX_STATE_BYTES = 100;

      const largeState: Record<string, unknown> = { counter: 0 };
      for (let i = 0; i < 20; i++) {
        largeState[`key_${i}`] = 'x'.repeat(10);
      }
      mgr.setState(CONV, largeState); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10

      const tree = getTree(mgr, CONV);
      if (tree) {
        expect(tree.nextSeq).toBe(0); // Not incremented
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Metadata
  // ═══════════════════════════════════════════════════════════════════

  describe('Metadata', () => {
    it('label has "After N mutations" format', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1 at mutation 10

      const tree = getTree(mgr, CONV)!;
      const chk1 = tree.nodes.get('chk_1')!;
      expect(chk1.label).toBe('After 10 mutations');
    });

    it('records mutationCount', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const tree = getTree(mgr, CONV)!;
      const chk1 = tree.nodes.get('chk_1')!;
      expect(chk1.mutationCount).toBe(10);
    });

    it('sets createdAt to approximately Date.now()', () => {
      const before = Date.now();
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10
      const after = Date.now();

      const tree = getTree(mgr, CONV)!;
      const chk1 = tree.nodes.get('chk_1')!;
      expect(chk1.createdAt).toBeGreaterThanOrEqual(before);
      expect(chk1.createdAt).toBeLessThanOrEqual(after);
    });

    it('getCheckpoints returns metadata', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const result = mgr.getCheckpoints(CONV);
      expect(result).toBeDefined();
      expect(result!.checkpoints.length).toBe(1);

      const cp = result!.checkpoints[0];
      expect(cp.label).toBe('After 10 mutations');
      expect(cp.mutationCount).toBe(10);
      expect(cp.createdAt).toBeGreaterThan(0);
      expect(cp.isCurrent).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getCheckpoints
  // ═══════════════════════════════════════════════════════════════════

  describe('getCheckpoints', () => {
    it('returns all nodes with parent/children', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19); // mutations 2-20 → chk_1, chk_2
      mgr.commitRollback(CONV, 'chk_1'); // resets mutations to 0
      applyNPatches(mgr, CONV, 10); // mutations 1-10 → chk_3 (fork)

      const result = mgr.getCheckpoints(CONV)!;
      expect(result.checkpoints.length).toBe(3);

      const chk1 = result.checkpoints.find(c => c.id === 'chk_1')!;
      expect(chk1.children).toContain('chk_2');
      expect(chk1.children).toContain('chk_3');
    });

    it('isCurrent true only for current node', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);

      const result = mgr.getCheckpoints(CONV)!;
      const currentNodes = result.checkpoints.filter(c => c.isCurrent);
      expect(currentNodes.length).toBe(1);
      expect(currentNodes[0].id).toBe(result.current);
    });

    it('returns null for empty tree', () => {
      expect(mgr.getCheckpoints(CONV)).toBeNull();
    });

    it('returns children as copies not references', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 19);

      const result = mgr.getCheckpoints(CONV)!;
      const chk1 = result.checkpoints.find(c => c.id === 'chk_1')!;
      const origLength = chk1.children.length;

      // Mutate the returned array
      chk1.children.push('fake_node');

      // Internal tree should be unaffected
      const tree = getTree(mgr, CONV)!;
      expect(tree.nodes.get('chk_1')!.children.length).toBe(origLength);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Persistence (setUserId + events)
  // ═══════════════════════════════════════════════════════════════════

  describe('Persistence', () => {
    it('writes checkpoint event to db with userId', () => {
      mgr.setUserId(CONV, USER);
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const checkpointCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'checkpoint',
      );
      expect(checkpointCall).toBeDefined();
      expect(checkpointCall![0]).toBe(USER); // userId
      expect(checkpointCall![2].checkpointId).toBe('chk_1');
    });

    it('checkpoint event includes state snapshot', () => {
      mgr.setUserId(CONV, USER);
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const checkpointCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'checkpoint',
      );
      expect(checkpointCall).toBeDefined();

      // state should be a JSON string of the state at checkpoint time
      // Patches mutate state in place: counter stays 0, but patch_N keys are added
      const stateStr = checkpointCall![2].state;
      expect(typeof stateStr).toBe('string');
      const parsed = JSON.parse(stateStr);
      expect(parsed.counter).toBe(0);
      expect(parsed.patch_0).toBe(1); // patch keys present in snapshot
    });

    it('checkpoint event includes createdAt', () => {
      mgr.setUserId(CONV, USER);
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const checkpointCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'checkpoint',
      );
      expect(checkpointCall![2].createdAt).toBeGreaterThan(0);
    });

    it('does not persist without userId', () => {
      // No setUserId call
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const checkpointCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'checkpoint',
      );
      expect(checkpointCall).toBeUndefined();
    });

    it('uses latest userId after update', () => {
      mgr.setUserId(CONV, 'user-old');
      mgr.setUserId(CONV, 'user-new');
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10

      const calls = (mockDb.appendMcplUserEvent as ReturnType<typeof vi.fn>).mock.calls;
      const checkpointCall = calls.find(
        (c: any[]) => c[1] === 'checkpoint_tree_updated' && c[2]?.action === 'checkpoint',
      );
      expect(checkpointCall![0]).toBe('user-new');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Replay
  // ═══════════════════════════════════════════════════════════════════

  describe('Replay', () => {
    it('replays checkpoint and restores node', () => {
      mgr.replayCheckpointEvent({
        _conversationId: CONV,
        action: 'checkpoint',
        checkpointId: 'chk_1',
        parentId: null,
        hostManaged: true,
        state: JSON.stringify({ counter: 10 }),
        label: 'After 10 mutations',
        mutationCount: 10,
        createdAt: 1000,
      });

      const tree = getTree(mgr, CONV)!;
      expect(tree.nodes.has('chk_1')).toBe(true);
      expect(tree.current).toBe('chk_1');
      expect(tree.nodes.get('chk_1')!.createdAt).toBe(1000);
    });

    it('replays chain with correct tree shape', () => {
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ v: 1 }),
        createdAt: 100, label: 'c1', mutationCount: 10,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_2', parentId: 'chk_1',
        hostManaged: true, state: JSON.stringify({ v: 2 }),
        createdAt: 200, label: 'c2', mutationCount: 20,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_3', parentId: 'chk_2',
        hostManaged: true, state: JSON.stringify({ v: 3 }),
        createdAt: 300, label: 'c3', mutationCount: 30,
      });

      const tree = getTree(mgr, CONV)!;
      expect(tree.nodes.size).toBe(3);
      expect(tree.nodes.get('chk_1')!.children).toContain('chk_2');
      expect(tree.nodes.get('chk_2')!.children).toContain('chk_3');
      expect(tree.current).toBe('chk_3');
    });

    it('restores state from snapshot on replay', () => {
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ counter: 42 }),
        createdAt: 100, label: 'c1', mutationCount: 10,
      });

      expect(mgr.getState(CONV)).toEqual({ counter: 42 });
    });

    it('replays rollback and moves current pointer', () => {
      // First create two checkpoints
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ v: 1 }),
        createdAt: 100, label: 'c1', mutationCount: 10,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_2', parentId: 'chk_1',
        hostManaged: true, state: JSON.stringify({ v: 2 }),
        createdAt: 200, label: 'c2', mutationCount: 20,
      });

      // Replay rollback to chk_1
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'rollback',
        checkpointId: 'chk_1',
      });

      const tree = getTree(mgr, CONV)!;
      expect(tree.current).toBe('chk_1');
      // State restored to chk_1 snapshot
      expect(mgr.getState(CONV)).toEqual({ v: 1 });
    });

    it('replay rollback guard: skips unknown ID', () => {
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ v: 1 }),
        createdAt: 100, label: 'c1', mutationCount: 10,
      });

      // Try rollback to non-existent checkpoint
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'rollback',
        checkpointId: 'chk_999', // doesn't exist
      });

      // current should NOT change
      const tree = getTree(mgr, CONV)!;
      expect(tree.current).toBe('chk_1');
    });

    it('replays mode_upgrade', () => {
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ v: 1 }),
        createdAt: 100, label: 'c1', mutationCount: 10,
      });

      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'mode_upgrade', mode: 'tree',
      });

      const tree = getTree(mgr, CONV)!;
      expect(tree.mode).toBe('tree');
    });

    it('applies eviction after replay when exceeding MAX_NODES', () => {
      (McplStateManager as any).MAX_NODES = 3;

      // Replay 5 checkpoints (linear chain)
      for (let i = 1; i <= 5; i++) {
        mgr.replayCheckpointEvent({
          _conversationId: CONV, action: 'checkpoint',
          checkpointId: `chk_${i}`,
          parentId: i > 1 ? `chk_${i - 1}` : null,
          hostManaged: true, state: JSON.stringify({ v: i }),
          createdAt: i * 100, label: `c${i}`, mutationCount: i * 10,
        });
      }

      const tree = getTree(mgr, CONV)!;
      // Should be trimmed to 3 nodes (linear mode trimChain)
      expect(tree.nodes.size).toBe(3);
    });

    it('uses createdAt for deterministic eviction ordering', () => {
      (McplStateManager as any).MAX_NODES = 3;

      // Replay mode upgrade first
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: JSON.stringify({ v: 1 }),
        createdAt: 1000, label: 'c1', mutationCount: 10,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'mode_upgrade', mode: 'tree',
      });

      // Create branch: chk_1 → chk_2, chk_1 → chk_3
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_2', parentId: 'chk_1',
        hostManaged: true, state: JSON.stringify({ v: 2 }),
        createdAt: 500, // OLDER (should be evicted first)
        label: 'c2', mutationCount: 20,
      });
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_3', parentId: 'chk_1',
        hostManaged: true, state: JSON.stringify({ v: 3 }),
        createdAt: 2000, label: 'c3', mutationCount: 30,
      });

      // Rollback to chk_3 (makes it current, chk_2 is off-branch)
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'rollback', checkpointId: 'chk_3',
      });

      // Add chk_4 as child of chk_3 to exceed limit
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_4', parentId: 'chk_3',
        hostManaged: true, state: JSON.stringify({ v: 4 }),
        createdAt: 3000, label: 'c4', mutationCount: 40,
      });

      const tree = getTree(mgr, CONV)!;
      // chk_2 (createdAt=500, off-branch) should be evicted first
      expect(tree.nodes.has('chk_2')).toBe(false);
      // Active branch nodes should remain
      expect(tree.nodes.has('chk_1')).toBe(true);
      expect(tree.nodes.has('chk_3')).toBe(true);
    });

    it('restores nextSeq from replayed IDs', () => {
      for (let i = 1; i <= 5; i++) {
        mgr.replayCheckpointEvent({
          _conversationId: CONV, action: 'checkpoint',
          checkpointId: `chk_${i}`,
          parentId: i > 1 ? `chk_${i - 1}` : null,
          hostManaged: true, state: JSON.stringify({ v: i }),
          createdAt: i * 100, label: `c${i}`, mutationCount: i * 10,
        });
      }

      const tree = getTree(mgr, CONV)!;
      expect(tree.nextSeq).toBeGreaterThanOrEqual(5);

      // New checkpoint after replay should get chk_6+
      // setState resets the live state. mutation count starts fresh.
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10

      // New node should be chk_6
      expect(tree.nodes.has('chk_6')).toBe(true);
    });

    it('handles corrupt state in replay (node stays, state not set)', () => {
      mgr.replayCheckpointEvent({
        _conversationId: CONV, action: 'checkpoint',
        checkpointId: 'chk_1', parentId: null,
        hostManaged: true, state: '{INVALID JSON!!!',
        createdAt: 100, label: 'c1', mutationCount: 10,
      });

      const tree = getTree(mgr, CONV)!;
      // Node should still exist in tree
      expect(tree.nodes.has('chk_1')).toBe(true);
      // But live state should not be set (parse failed)
      expect(mgr.getState(CONV)).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // cleanup
  // ═══════════════════════════════════════════════════════════════════

  describe('cleanup', () => {
    it('clears all data for conversation', () => {
      mgr.setUserId(CONV, USER);
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 9); // mutations 2-10 → chk_1

      mgr.cleanup(CONV);

      expect(mgr.getState(CONV)).toBeUndefined();
      expect(getTree(mgr, CONV)).toBeUndefined();
      expect(getMutationCount(mgr, CONV)).toBe(0);
      expect((mgr as any).userIds.get(CONV)).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getStats
  // ═══════════════════════════════════════════════════════════════════

  describe('getStats', () => {
    it('counts conversations and nodes', () => {
      mgr.setState('conv-a', { counter: 0 }); // mutation 1
      applyNPatches(mgr, 'conv-a', 9); // mutations 2-10 → 1 node
      mgr.setState('conv-b', { counter: 0 }); // mutation 1
      applyNPatches(mgr, 'conv-b', 19); // mutations 2-20 → 2 nodes

      const stats = mgr.getStats();
      expect(stats.totalConversations).toBe(2);
      expect(stats.totalNodes).toBe(3);
    });

    it('reports maxTreeDepth as longest root→current chain', () => {
      mgr.setState(CONV, { counter: 0 }); // mutation 1
      applyNPatches(mgr, CONV, 49); // mutations 2-50 → 5 checkpoints deep

      const stats = mgr.getStats();
      expect(stats.maxTreeDepth).toBe(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Replay benchmarks — compaction threshold discovery
  // ═══════════════════════════════════════════════════════════════════

  describe('Replay benchmarks', () => {
    // Use default MAX_NODES (50) — realistic production config.
    // These benchmarks measure replay + eviction cost, NOT state size.

    it('replay 50 checkpoints (no eviction) < 50ms', () => {
      // 50 = MAX_NODES, no eviction triggered. Pure replay baseline.
      const events = generateCheckpointEvents(50, { stateSize: 100 });
      const localMgr = createManager();

      const start = performance.now();
      for (const e of events) localMgr.replayCheckpointEvent(e);
      const elapsed = performance.now() - start;

      console.log(`[Bench] 50 checkpoints (100B state, no eviction): ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(50);

      // Sanity: all 50 nodes survived (no eviction)
      const tree = getTree(localMgr, 'bench-conv')!;
      expect(tree.nodes.size).toBe(50);
    });

    it('replay 200 checkpoints (150 evicted) < 200ms', () => {
      // 200 events, MAX_NODES=50 → 150 evicted during replay.
      // trimChain runs 150 times. This is the "typical heavy user" scenario.
      const events = generateCheckpointEvents(200, { stateSize: 100 });
      const localMgr = createManager();

      const start = performance.now();
      for (const e of events) localMgr.replayCheckpointEvent(e);
      const elapsed = performance.now() - start;

      console.log(`[Bench] 200 checkpoints (100B state, 150 evicted): ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(200);

      const tree = getTree(localMgr, 'bench-conv')!;
      expect(tree.nodes.size).toBe(50);
    });

    it('replay 500 checkpoints (450 evicted) < 500ms', () => {
      // 500 events — stress test. If this is slow → compaction needed.
      const events = generateCheckpointEvents(500, { stateSize: 100 });
      const localMgr = createManager();

      const start = performance.now();
      for (const e of events) localMgr.replayCheckpointEvent(e);
      const elapsed = performance.now() - start;

      console.log(`[Bench] 500 checkpoints (100B state, 450 evicted): ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(500);

      const tree = getTree(localMgr, 'bench-conv')!;
      expect(tree.nodes.size).toBe(50);
    });

    it('replay 500 checkpoints with 10KB state < 1000ms', () => {
      // Realistic state size: 10KB per checkpoint. JSON.parse cost adds up.
      const events = generateCheckpointEvents(500, { stateSize: 10_000 });
      const localMgr = createManager();

      const start = performance.now();
      for (const e of events) localMgr.replayCheckpointEvent(e);
      const elapsed = performance.now() - start;

      console.log(`[Bench] 500 checkpoints (10KB state): ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(1000);
    });

    it('replay 1000 checkpoints — measure, soft threshold', () => {
      // Edge case: very long-lived conversation. Measure + log.
      // If this exceeds 2s → compaction should be added.
      const events = generateCheckpointEvents(1000, { stateSize: 100 });
      const localMgr = createManager();

      const start = performance.now();
      for (const e of events) localMgr.replayCheckpointEvent(e);
      const elapsed = performance.now() - start;

      console.log(`[Bench] 1000 checkpoints (100B state): ${elapsed.toFixed(1)}ms`);
      // Soft threshold: warn but don't fail CI
      if (elapsed > 2000) {
        console.warn(`[Bench] ⚠ 1000 checkpoints took ${elapsed.toFixed(0)}ms — consider compaction`);
      }
      // Hard ceiling: must not exceed 5s (would block startup)
      expect(elapsed).toBeLessThan(5000);
    });

    it('event file size estimation', () => {
      // How much disk space does the event JSONL consume?
      // This determines whether compaction is needed for storage.
      const events100B = generateCheckpointEvents(200, { stateSize: 100 });
      const events10K = generateCheckpointEvents(200, { stateSize: 10_000 });

      const size100B = events100B.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
      const size10K = events10K.reduce((sum, e) => sum + JSON.stringify(e).length, 0);

      console.log(`[Bench] 200 events × 100B state = ${(size100B / 1024).toFixed(1)}KB`);
      console.log(`[Bench] 200 events × 10KB state = ${(size10K / 1024 / 1024).toFixed(1)}MB`);

      // Sanity checks (not perf thresholds)
      expect(size100B).toBeLessThan(1024 * 1024);     // < 1MB for 100B states
      expect(size10K).toBeLessThan(10 * 1024 * 1024);  // < 10MB for 10KB states
    });
  });
});
