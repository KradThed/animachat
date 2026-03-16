import { describe, it, expect } from 'vitest';
import { findLastUserMessageIndex, applyUserInjections } from '../message-helpers.js';

/**
 * Bug 5 regression tests — findLastUserMessageIndex()
 *
 * Ensures beforeUser/afterUser injections target the correct message.
 * Previously, trigger-handler.ts and inference-runner.ts used
 * messages[messages.length - 1] which could be an assistant message.
 */

function makeMsg(role: string, content: string, id = `branch-${Math.random().toString(36).slice(2)}`) {
  return {
    activeBranchId: id,
    branches: [{ id, role, content }],
  };
}

describe('findLastUserMessageIndex', () => {
  it('returns -1 for empty array', () => {
    expect(findLastUserMessageIndex([])).toBe(-1);
  });

  it('finds last user message when it is the last element', () => {
    const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi'), makeMsg('user', 'bye')];
    expect(findLastUserMessageIndex(msgs)).toBe(2);
  });

  it('skips trailing assistant message and finds user', () => {
    const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
    expect(findLastUserMessageIndex(msgs)).toBe(0);
  });

  it('returns -1 when all messages are assistant', () => {
    const msgs = [makeMsg('assistant', 'a'), makeMsg('assistant', 'b')];
    expect(findLastUserMessageIndex(msgs)).toBe(-1);
  });

  it('handles messages with no branches', () => {
    const msgs = [{ activeBranchId: 'x' }, makeMsg('user', 'hi')];
    expect(findLastUserMessageIndex(msgs)).toBe(1);
  });

  it('handles messages with mismatched activeBranchId', () => {
    const msg = {
      activeBranchId: 'nonexistent',
      branches: [{ id: 'other', role: 'user', content: 'hi' }],
    };
    const msgs = [msg, makeMsg('user', 'real')];
    expect(findLastUserMessageIndex(msgs)).toBe(1);
  });
});

describe('applyUserInjections', () => {
  it('prepends beforeUser to last user message content', () => {
    const msgs = [makeMsg('user', 'original'), makeMsg('assistant', 'reply')];
    const result = applyUserInjections(msgs, ['before'], []);
    const branch = result.messages[0].branches[0];
    expect(branch.content).toBe('before\n\noriginal');
    expect(result.systemAppend).toBeUndefined();
  });

  it('appends afterUser to last user message content', () => {
    const msgs = [makeMsg('user', 'original')];
    const result = applyUserInjections(msgs, [], ['after']);
    const branch = result.messages[0].branches[0];
    expect(branch.content).toBe('original\n\nafter');
    expect(result.systemAppend).toBeUndefined();
  });

  it('applies both beforeUser and afterUser', () => {
    const msgs = [makeMsg('user', 'original')];
    const result = applyUserInjections(msgs, ['before'], ['after']);
    const branch = result.messages[0].branches[0];
    expect(branch.content).toBe('before\n\noriginal\n\nafter');
  });

  it('returns systemAppend when no user message found', () => {
    const msgs = [makeMsg('assistant', 'a'), makeMsg('assistant', 'b')];
    const result = applyUserInjections(msgs, ['before'], ['after']);
    expect(result.systemAppend).toBe('before\n\nafter');
    // Messages unchanged (same reference)
    expect(result.messages).toBe(msgs);
  });

  it('returns messages unchanged for empty injection arrays', () => {
    const msgs = [makeMsg('user', 'hello')];
    const result = applyUserInjections(msgs, [], []);
    expect(result.messages).toBe(msgs);
    expect(result.systemAppend).toBeUndefined();
  });

  it('does not mutate original messages', () => {
    const msgs = [makeMsg('user', 'original')];
    const originalContent = msgs[0].branches[0].content;
    applyUserInjections(msgs, ['injected'], []);
    expect(msgs[0].branches[0].content).toBe(originalContent);
  });
});
