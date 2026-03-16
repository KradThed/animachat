/**
 * Find the index of the last user message in a message array.
 * Walks backwards through messages, checking activeBranch.role === 'user'.
 * Returns -1 if no user message found.
 */
export function findLastUserMessageIndex(
  messages: Array<{ branches?: Array<{ id: string; role: string }>; activeBranchId?: string }>
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const branch = msg.branches?.find((b) => b.id === msg.activeBranchId);
    if (branch?.role === 'user') return i;
  }
  return -1;
}

/**
 * Apply beforeUser/afterUser injections to the last user message.
 * If no user message found, returns systemAppend for fallback to system prompt.
 * Uses immutable message updates (doesn't mutate input).
 * Generic T preserves the caller's message type (avoids narrowing).
 */
export function applyUserInjections<
  T extends {
    branches?: Array<{ id: string; role: string; content?: string }>;
    activeBranchId?: string;
  }
>(
  messages: T[],
  beforeUser: string[],
  afterUser: string[],
): { messages: T[]; systemAppend?: string } {
  if ((beforeUser.length === 0 && afterUser.length === 0) || messages.length === 0) {
    return { messages };
  }

  const lastIdx = findLastUserMessageIndex(messages);

  if (lastIdx === -1) {
    // No user message — caller should append to system prompt
    const combined = [...beforeUser, ...afterUser].join('\n\n');
    return { messages, systemAppend: combined || undefined };
  }

  // Inject into last user message's content (immutable update)
  const updated = messages.map((m, i) => {
    if (i !== lastIdx) return m;
    const branch = m.branches?.find((b) => b.id === m.activeBranchId);
    if (!branch) return m;
    let content = branch.content || '';
    if (beforeUser.length > 0) content = beforeUser.join('\n') + '\n\n' + content;
    if (afterUser.length > 0) content = content + '\n\n' + afterUser.join('\n');
    return {
      ...m,
      branches: m.branches!.map((b) =>
        b.id === m.activeBranchId ? { ...b, content } : b
      ),
    };
  }) as T[];

  return { messages: updated };
}
