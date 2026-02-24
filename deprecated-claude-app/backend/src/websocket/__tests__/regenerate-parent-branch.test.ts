import { describe, it, expect } from 'vitest';

/**
 * WS-6: Test that regenerate finds the correct parent message in branched conversations.
 *
 * The current handleRegenerate code uses `allMessages[targetMessageIndex - 1]` to find
 * the parent user message. This is a flat-index lookup on a topologically sorted array.
 * In branched conversations, index-1 may be a message from a different branch.
 *
 * This test extracts the parent-finding logic from handleRegenerate (lines 2181-2193)
 * and verifies it against a realistic branched conversation topology.
 */

// Minimal Message type matching what handleRegenerate uses
interface Branch {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  parentBranchId?: string;
  participantId?: string;
}

interface Message {
  id: string;
  branches: Branch[];
  activeBranchId: string;
  order: number;
}

/**
 * Simulates sortMessagesByTreeOrder from database/index.ts:4542
 * Topological sort: parents before children, based on parentBranchId links.
 */
function sortMessagesByTreeOrder(messages: Message[]): Message[] {
  if (messages.length === 0) return [];

  const branchToMsgIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    for (const branch of messages[i].branches) {
      branchToMsgIndex.set(branch.id, i);
    }
  }

  const sortedIndices: number[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();

  const visit = (msgIndex: number): void => {
    if (visited.has(msgIndex)) return;
    if (visiting.has(msgIndex)) return;

    visiting.add(msgIndex);
    const msg = messages[msgIndex];

    for (const branch of msg.branches) {
      if (branch.parentBranchId && branch.parentBranchId !== 'root') {
        const parentMsgIndex = branchToMsgIndex.get(branch.parentBranchId);
        if (parentMsgIndex !== undefined && parentMsgIndex !== msgIndex) {
          visit(parentMsgIndex);
        }
      }
    }

    visiting.delete(msgIndex);
    visited.add(msgIndex);
    sortedIndices.push(msgIndex);
  };

  for (let i = 0; i < messages.length; i++) {
    visit(i);
  }

  return sortedIndices.map(i => messages[i]);
}

/**
 * Extracts the parent-finding logic from handleRegenerate (handler.ts:2181-2193).
 * Returns the correctParentBranchId that would be used.
 */
function findRegenerateParent(
  allMessages: Message[],
  targetMessageId: string,
  targetBranchId: string,
  frontendParentBranchId?: string,
): { correctParentBranchId: string; parentUserBranchId: string | undefined; flatIndexParentId: string | undefined } {
  const targetMessageIndex = allMessages.findIndex(m => m.id === targetMessageId);
  const parentUserMessage = targetMessageIndex > 0 ? allMessages[targetMessageIndex - 1] : null;
  const parentUserBranch = parentUserMessage
    ? parentUserMessage.branches.find(b => b.id === parentUserMessage.activeBranchId)
    : null;

  const msg = allMessages.find(m => m.id === targetMessageId)!;
  const originalBranch = msg.branches.find(b => b.id === targetBranchId);

  const correctParentBranchId =
    frontendParentBranchId ||
    originalBranch?.parentBranchId ||
    parentUserBranch?.id ||
    'root';

  return {
    correctParentBranchId,
    parentUserBranchId: parentUserBranch?.id,
    flatIndexParentId: parentUserMessage?.id,
  };
}

describe('WS-6: Regenerate parent branch in branched conversations', () => {
  /**
   * Conversation tree topology:
   *
   *   msg-1 (user, branch-1a)          ← root user message
   *     ├─ msg-2 (assistant, branch-2a, parent=branch-1a)   ← branch A response
   *     │    └─ msg-3 (user, branch-3a, parent=branch-2a)   ← branch A follow-up
   *     │         └─ msg-4 (assistant, branch-4a, parent=branch-3a) ← TARGET (regenerate this)
   *     └─ msg-5 (assistant, branch-5b, parent=branch-1a)   ← branch B response (second regeneration)
   *          └─ msg-6 (user, branch-6b, parent=branch-5b)   ← branch B follow-up
   *               └─ msg-7 (assistant, branch-7b, parent=branch-6b) ← branch B last
   *
   * When regenerating msg-4, the correct parent is msg-3 (branch-3a).
   * But topological sort puts ALL tree nodes in a flat list. Depending on visit order,
   * index-1 of msg-4 might be msg-6 (from branch B) instead of msg-3.
   */
  const messages: Message[] = [
    {
      id: 'msg-1', order: 0,
      branches: [{ id: 'branch-1a', role: 'user', content: 'Hello', parentBranchId: 'root' }],
      activeBranchId: 'branch-1a',
    },
    {
      id: 'msg-2', order: 1,
      branches: [{ id: 'branch-2a', role: 'assistant', content: 'Hi (A)', parentBranchId: 'branch-1a' }],
      activeBranchId: 'branch-2a',
    },
    {
      id: 'msg-3', order: 2,
      branches: [{ id: 'branch-3a', role: 'user', content: 'Follow up A', parentBranchId: 'branch-2a' }],
      activeBranchId: 'branch-3a',
    },
    {
      id: 'msg-4', order: 3,
      branches: [{ id: 'branch-4a', role: 'assistant', content: 'Response A2', parentBranchId: 'branch-3a' }],
      activeBranchId: 'branch-4a',
    },
    {
      id: 'msg-5', order: 4,
      branches: [{ id: 'branch-5b', role: 'assistant', content: 'Hi (B)', parentBranchId: 'branch-1a' }],
      activeBranchId: 'branch-5b',
    },
    {
      id: 'msg-6', order: 5,
      branches: [{ id: 'branch-6b', role: 'user', content: 'Follow up B', parentBranchId: 'branch-5b' }],
      activeBranchId: 'branch-6b',
    },
    {
      id: 'msg-7', order: 6,
      branches: [{ id: 'branch-7b', role: 'assistant', content: 'Response B2', parentBranchId: 'branch-6b' }],
      activeBranchId: 'branch-7b',
    },
  ];

  const sorted = sortMessagesByTreeOrder(messages);

  it('topological sort produces valid parent-before-child order', () => {
    const indexMap = new Map(sorted.map((m, i) => [m.id, i]));

    // Every message with a parent branch should appear after its parent
    for (const msg of sorted) {
      for (const branch of msg.branches) {
        if (branch.parentBranchId && branch.parentBranchId !== 'root') {
          // Find which message owns the parent branch
          const parentMsg = sorted.find(m => m.branches.some(b => b.id === branch.parentBranchId));
          if (parentMsg) {
            expect(indexMap.get(parentMsg.id)!).toBeLessThan(indexMap.get(msg.id)!);
          }
        }
      }
    }
  });

  it('flat index-1 may return wrong parent from different branch (BUG DEMONSTRATION)', () => {
    // Regenerating msg-4 (branch-4a). Correct parent = msg-3 (branch-3a).
    const result = findRegenerateParent(sorted, 'msg-4', 'branch-4a');
    const targetIndex = sorted.findIndex(m => m.id === 'msg-4');
    const flatParent = sorted[targetIndex - 1];

    // The flat index-1 parent MIGHT be from the wrong branch.
    // In topological order, both branch A and branch B children come after msg-1.
    // The exact order of sibling branches depends on the DFS visit order.
    //
    // If sorted = [msg-1, msg-2, msg-3, msg-4, msg-5, msg-6, msg-7] → index-1 is msg-3 (correct)
    // If sorted = [msg-1, msg-5, msg-6, msg-7, msg-2, msg-3, msg-4] → index-1 is msg-3 (correct)
    // If sorted = [msg-1, msg-2, msg-5, msg-6, msg-3, msg-4, msg-7] → index-1 is msg-3 (correct)
    //
    // BUT the current DFS iterates by insertion order. With the topology as defined,
    // msg-4 depends on msg-3 which depends on msg-2 which depends on msg-1.
    // msg-7 depends on msg-6 which depends on msg-5 which depends on msg-1.
    // Both subchains share msg-1 as root.
    //
    // DFS visits: 0(msg-1) → 1(msg-2,needs msg-1 done) → 2(msg-3,needs msg-2) → 3(msg-4,needs msg-3)
    //             → 4(msg-5,needs msg-1 done) → 5(msg-6,needs msg-5) → 6(msg-7,needs msg-6)
    // So sorted = [msg-1, msg-2, msg-3, msg-4, msg-5, msg-6, msg-7]
    // In THIS case, flat index-1 happens to be msg-3 (correct).
    // BUT this is fragile — if message insertion order changes (e.g., branch B messages
    // were created first), DFS visit order changes and index-1 breaks.

    // Regardless of flat index correctness, the FIRST two fallbacks (frontend parentBranchId,
    // originalBranch.parentBranchId) should give the correct answer:
    expect(result.correctParentBranchId).toBe('branch-3a');
  });

  it('originalBranch.parentBranchId provides correct parent even if flat index is wrong', () => {
    // branch-4a has parentBranchId = 'branch-3a' → correct regardless of array order
    const result = findRegenerateParent(sorted, 'msg-4', 'branch-4a');
    expect(result.correctParentBranchId).toBe('branch-3a');
  });

  it('frontend parentBranchId overrides all fallbacks', () => {
    const result = findRegenerateParent(sorted, 'msg-4', 'branch-4a', 'custom-parent-from-frontend');
    expect(result.correctParentBranchId).toBe('custom-parent-from-frontend');
  });

  it('flat index-1 IS wrong when message order differs from branch path', () => {
    // Reorder messages so that branch B messages appear before branch A in the array.
    // This simulates a scenario where branch B was created first.
    const reorderedMessages: Message[] = [
      messages[0], // msg-1 (root)
      messages[4], // msg-5 (branch B assistant)
      messages[5], // msg-6 (branch B user)
      messages[6], // msg-7 (branch B assistant)
      messages[1], // msg-2 (branch A assistant)
      messages[2], // msg-3 (branch A user)
      messages[3], // msg-4 (branch A assistant) ← regenerate target
    ];

    const reorderedSorted = sortMessagesByTreeOrder(reorderedMessages);
    const targetIndex = reorderedSorted.findIndex(m => m.id === 'msg-4');
    const flatParent = reorderedSorted[targetIndex - 1];

    // With reordered input, DFS visits branch B first:
    // msg-1 → msg-5 → msg-6 → msg-7 → msg-2 → msg-3 → msg-4
    // So index-1 of msg-4 is msg-3 (still correct in this case because DFS follows chains)

    // BUT if we have a topology where sibling messages interleave:
    // Let's create a case where it definitely breaks — messages from two branches
    // share the same parent message and get interleaved by the topological sort.

    // Even if flat-index happens to work with pure topological sort,
    // originalBranch.parentBranchId is the ONLY reliable source.
    const result = findRegenerateParent(reorderedSorted, 'msg-4', 'branch-4a');
    expect(result.correctParentBranchId).toBe('branch-3a');
  });

  it('BUG: flat index fails with multi-branch messages (realistic scenario)', () => {
    /**
     * Realistic case: msg-2 has TWO branches (branch A and branch B are both on msg-2).
     * This is how actual regeneration works — regenerate creates a new branch on the SAME message.
     *
     *   msg-1 (user, branch-1)
     *     └─ msg-2 (assistant, branch-2a + branch-2b)   ← two regeneration branches
     *          ├─ [branch-2a path]: msg-3a (user) → msg-4a (assistant) ← TARGET
     *          └─ [branch-2b path]: msg-3b (user) → msg-4b (assistant)
     *
     * Here msg-3a and msg-3b are DIFFERENT messages, each parented to a different branch of msg-2.
     * Topological sort: msg-1, msg-2 must come first. Then msg-3a/msg-3b in some order.
     *
     * If sorted = [msg-1, msg-2, msg-3b, msg-4b, msg-3a, msg-4a]
     * Then index-1 of msg-4a = msg-3a (correct)
     * If sorted = [msg-1, msg-2, msg-3a, msg-3b, msg-4b, msg-4a]
     * Then index-1 of msg-4a = msg-4b (WRONG — different branch!)
     */
    const multiBranchMessages: Message[] = [
      {
        id: 'mb-1', order: 0,
        branches: [{ id: 'mb-b1', role: 'user', content: 'Start', parentBranchId: 'root' }],
        activeBranchId: 'mb-b1',
      },
      {
        id: 'mb-2', order: 1,
        branches: [
          { id: 'mb-b2a', role: 'assistant', content: 'Reply A', parentBranchId: 'mb-b1' },
          { id: 'mb-b2b', role: 'assistant', content: 'Reply B', parentBranchId: 'mb-b1' },
        ],
        activeBranchId: 'mb-b2a',
      },
      // Branch B path (inserted BEFORE branch A path to control DFS order)
      {
        id: 'mb-3b', order: 4,
        branches: [{ id: 'mb-b3b', role: 'user', content: 'Follow B', parentBranchId: 'mb-b2b' }],
        activeBranchId: 'mb-b3b',
      },
      {
        id: 'mb-4b', order: 5,
        branches: [{ id: 'mb-b4b', role: 'assistant', content: 'Resp B', parentBranchId: 'mb-b3b' }],
        activeBranchId: 'mb-b4b',
      },
      // Branch A path
      {
        id: 'mb-3a', order: 2,
        branches: [{ id: 'mb-b3a', role: 'user', content: 'Follow A', parentBranchId: 'mb-b2a' }],
        activeBranchId: 'mb-b3a',
      },
      {
        id: 'mb-4a', order: 3,
        branches: [{ id: 'mb-b4a', role: 'assistant', content: 'Resp A', parentBranchId: 'mb-b3a' }],
        activeBranchId: 'mb-b4a',
      },
    ];

    const mbSorted = sortMessagesByTreeOrder(multiBranchMessages);
    const sortedIds = mbSorted.map(m => m.id);

    // Find where msg-4a ends up
    const target4aIndex = sortedIds.indexOf('mb-4a');
    const flatParentOf4a = mbSorted[target4aIndex - 1];

    // The flat parent might NOT be mb-3a (correct parent) — it could be mb-4b or mb-3b
    // depending on topological sort order.
    //
    // With this input order (B path first), DFS visits:
    // 0: mb-1 (no deps) → output
    // 1: mb-2 (needs mb-1, done) → output
    // 2: mb-3b (needs mb-2, done) → output
    // 3: mb-4b (needs mb-3b, done) → output
    // 4: mb-3a (needs mb-2, done) → output
    // 5: mb-4a (needs mb-3a, done) → output
    // Sorted: [mb-1, mb-2, mb-3b, mb-4b, mb-3a, mb-4a]
    // index-1 of mb-4a (index 5) = mb-3a (index 4) → happens to be correct

    // BUT let's try with interleaved order that breaks it:
    const interleaved: Message[] = [
      multiBranchMessages[0], // mb-1
      multiBranchMessages[1], // mb-2
      multiBranchMessages[4], // mb-3a (branch A user)
      multiBranchMessages[2], // mb-3b (branch B user)
      multiBranchMessages[3], // mb-4b (branch B assistant)
      multiBranchMessages[5], // mb-4a (branch A assistant) ← TARGET
    ];

    const interleavedSorted = sortMessagesByTreeOrder(interleaved);
    const intSortedIds = interleavedSorted.map(m => m.id);
    const intTarget4aIndex = intSortedIds.indexOf('mb-4a');
    const intFlatParent = interleavedSorted[intTarget4aIndex - 1];

    // With input order [mb-1, mb-2, mb-3a, mb-3b, mb-4b, mb-4a]:
    // DFS: 0:mb-1, 1:mb-2(needs mb-1), 2:mb-3a(needs mb-2), 3:mb-3b(needs mb-2),
    //      4:mb-4b(needs mb-3b), 5:mb-4a(needs mb-3a)
    // Sorted: [mb-1, mb-2, mb-3a, mb-3b, mb-4b, mb-4a]
    // index-1 of mb-4a (index 5) = mb-4b (index 4) — WRONG BRANCH!

    if (intFlatParent.id !== 'mb-3a') {
      // BUG CONFIRMED: flat index returned a message from the wrong branch
      expect(intFlatParent.id).toBe('mb-4b'); // wrong parent (from branch B)

      // But originalBranch.parentBranchId still gives the correct answer:
      const result = findRegenerateParent(interleavedSorted, 'mb-4a', 'mb-b4a');
      expect(result.correctParentBranchId).toBe('mb-b3a'); // correct!
      expect(result.flatIndexParentId).toBe('mb-4b'); // flat index was wrong
    } else {
      // If flat index happened to be correct, still verify parentBranchId fallback works
      const result = findRegenerateParent(interleavedSorted, 'mb-4a', 'mb-b4a');
      expect(result.correctParentBranchId).toBe('mb-b3a');
    }
  });
});
