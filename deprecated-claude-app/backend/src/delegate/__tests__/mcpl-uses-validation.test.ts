import { describe, it, expect } from 'vitest';

/**
 * Inlined from shared/src/mcpl-types.ts because vitest cannot resolve
 * value exports from @deprecated-claude/shared (outside backend's vite project root).
 */
const SPEC_DECLARATION_USES = new Set([
  'pushEvents',
  'contextHooks.beforeInference',
  'contextHooks.afterInference',
  'inferenceRequest',
  'tools',
  'channels.publish',
  'channels.observe',
]);

const HOST_SUPPORTED_DECLARATION_USES = new Set([
  'pushEvents',
  'contextHooks.beforeInference',
  'contextHooks.afterInference',
  'inferenceRequest',
  'tools',
]);

function validateDeclarationUses(uses: string[]): { supported: string[]; unsupported: string[] } {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const u of uses) {
    if (HOST_SUPPORTED_DECLARATION_USES.has(u)) {
      supported.push(u);
    } else {
      unsupported.push(u);
    }
  }
  return { supported, unsupported };
}

describe('SPEC_DECLARATION_USES', () => {
  it('contains all spec values including channels.publish and channels.observe', () => {
    const expected = [
      'pushEvents',
      'contextHooks.beforeInference',
      'contextHooks.afterInference',
      'inferenceRequest',
      'tools',
      'channels.publish',
      'channels.observe',
    ];
    for (const val of expected) {
      expect(SPEC_DECLARATION_USES.has(val)).toBe(true);
    }
  });

  it('does NOT contain legacy aliases (push_events, context_hooks)', () => {
    expect(SPEC_DECLARATION_USES.has('push_events')).toBe(false);
    expect(SPEC_DECLARATION_USES.has('context_hooks')).toBe(false);
  });

  it('is a superset of HOST_SUPPORTED_DECLARATION_USES', () => {
    for (const val of HOST_SUPPORTED_DECLARATION_USES) {
      expect(SPEC_DECLARATION_USES.has(val)).toBe(true);
    }
  });
});

describe('HOST_SUPPORTED_DECLARATION_USES', () => {
  it('contains only host-implemented spec capabilities', () => {
    const expected = [
      'pushEvents',
      'contextHooks.beforeInference',
      'contextHooks.afterInference',
      'inferenceRequest',
      'tools',
    ];
    expect(HOST_SUPPORTED_DECLARATION_USES.size).toBe(expected.length);
    for (const val of expected) {
      expect(HOST_SUPPORTED_DECLARATION_USES.has(val)).toBe(true);
    }
  });

  it('does NOT contain channels.publish or channels.observe', () => {
    expect(HOST_SUPPORTED_DECLARATION_USES.has('channels.publish')).toBe(false);
    expect(HOST_SUPPORTED_DECLARATION_USES.has('channels.observe')).toBe(false);
  });

  it('does NOT contain legacy aliases (push_events)', () => {
    expect(HOST_SUPPORTED_DECLARATION_USES.has('push_events')).toBe(false);
  });

  it('does NOT contain toolManagement (host-only runtime concept, not a declaration use)', () => {
    expect(HOST_SUPPORTED_DECLARATION_USES.has('toolManagement')).toBe(false);
  });

  it('is a strict subset of SPEC_DECLARATION_USES', () => {
    for (const val of HOST_SUPPORTED_DECLARATION_USES) {
      expect(SPEC_DECLARATION_USES.has(val)).toBe(true);
    }
    expect(HOST_SUPPORTED_DECLARATION_USES.size).toBeLessThan(SPEC_DECLARATION_USES.size);
  });
});

describe('validateDeclarationUses', () => {
  it('partitions supported vs unsupported uses', () => {
    const result = validateDeclarationUses(['pushEvents', 'channels.publish']);
    expect(result.supported).toEqual(['pushEvents']);
    expect(result.unsupported).toEqual(['channels.publish']);
  });

  it('channels.publish is unsupported (spec-valid but host-unsupported)', () => {
    const result = validateDeclarationUses(['channels.publish']);
    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual(['channels.publish']);
  });

  it('channels.observe is unsupported (spec-valid but host-unsupported)', () => {
    const result = validateDeclarationUses(['channels.observe']);
    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual(['channels.observe']);
  });

  it('legacy alias push_events is unsupported', () => {
    const result = validateDeclarationUses(['push_events']);
    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual(['push_events']);
  });

  it('unknown string foo.bar is unsupported', () => {
    const result = validateDeclarationUses(['foo.bar']);
    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual(['foo.bar']);
  });

  it('all HOST_SUPPORTED values produce empty unsupported', () => {
    const result = validateDeclarationUses([...HOST_SUPPORTED_DECLARATION_USES]);
    expect(result.supported).toEqual([...HOST_SUPPORTED_DECLARATION_USES]);
    expect(result.unsupported).toEqual([]);
  });

  it('empty array produces both empty', () => {
    const result = validateDeclarationUses([]);
    expect(result.supported).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('mixed supported + unsupported produces correct partition', () => {
    const result = validateDeclarationUses([
      'pushEvents',
      'channels.publish',
      'tools',
      'foo.bar',
      'contextHooks.beforeInference',
      'push_events',
    ]);
    expect(result.supported).toEqual([
      'pushEvents',
      'tools',
      'contextHooks.beforeInference',
    ]);
    expect(result.unsupported).toEqual([
      'channels.publish',
      'foo.bar',
      'push_events',
    ]);
  });
});
