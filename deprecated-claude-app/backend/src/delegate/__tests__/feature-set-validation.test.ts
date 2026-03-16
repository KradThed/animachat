import { describe, it, expect, beforeEach } from 'vitest';
import { McplSessionManager } from '../mcpl-session-manager.js';
import type { McplFeatureSet, DeclaredFeatureSet } from '@deprecated-claude/shared';

/**
 * Host-supported declaration uses (matches shared/src/mcpl-types.ts).
 * Inlined because vitest cannot resolve value exports from @deprecated-claude/shared
 * (the shared package is outside backend's vite project root).
 */
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

// =============================================================================
// Helpers
// =============================================================================

/**
 * Mirrors applyUsesValidation() from delegate-handler.ts for test use.
 * Quarantines feature sets with unsupported uses; auto-recovers valid ones.
 */
function applyUsesValidation(
  mgr: McplSessionManager,
  sessionId: string,
  declared: Record<string, McplFeatureSet | DeclaredFeatureSet>,
  _delegateId: string
): void {
  for (const [name, fs] of Object.entries(declared)) {
    const uses = 'rawUses' in fs ? fs.rawUses : fs.uses;
    const { unsupported } = validateDeclarationUses(uses);
    if (unsupported.length > 0) {
      mgr.quarantineFeatureSet(sessionId, name);
    } else {
      mgr.unquarantineFeatureSet(sessionId, name);
    }
  }
}

function createSessionManager(): McplSessionManager {
  return new McplSessionManager();
}

function createSession(mgr: McplSessionManager, delegateId = 'test-delegate', userId = 'user-1') {
  return mgr.createSession(delegateId, userId, {}, '0.4.1');
}

// =============================================================================
// Tests
// =============================================================================

describe('applyUsesValidation + quarantine', () => {
  let mgr: McplSessionManager;

  beforeEach(() => {
    mgr = createSessionManager();
  });

  it('feature set with supported uses → not quarantined', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      filesystem: { uses: ['tools'], description: 'FS tools' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'filesystem')).toBe(true);
    expect(session.invalidFeatureSets.has('filesystem')).toBe(false);
  });

  it('feature set with channels.publish → quarantined (spec-valid, host-unsupported)', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      realtime: { uses: ['channels.publish'], description: 'Realtime' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(session.enabledFeatureSets.has('realtime')).toBe(true); // host intent preserved
    expect(session.invalidFeatureSets.has('realtime')).toBe(true); // quarantined
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'realtime')).toBe(false);
  });

  it('feature set with channels.observe → quarantined', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      observer: { uses: ['channels.observe'], description: 'Observer' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(session.invalidFeatureSets.has('observer')).toBe(true);
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'observer')).toBe(false);
  });

  it('feature set with unknown string (foo.bar) → quarantined', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      custom: { uses: ['foo.bar'], description: 'Custom' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(session.invalidFeatureSets.has('custom')).toBe(true);
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'custom')).toBe(false);
  });

  it('feature set with mixed supported + unsupported → quarantined (ANY unsupported triggers)', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      mixed: { uses: ['tools', 'channels.publish'], description: 'Mixed' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(session.invalidFeatureSets.has('mixed')).toBe(true);
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'mixed')).toBe(false);
  });

  it('feature set with empty uses array → not quarantined', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      empty: { uses: [], description: 'Empty' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(session.invalidFeatureSets.has('empty')).toBe(false);
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'empty')).toBe(true);
  });

  it('getEffectiveEnabledNames excludes quarantined', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      valid: { uses: ['tools'], description: 'Valid' },
      invalid: { uses: ['channels.publish'], description: 'Invalid' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    const enabled = mgr.getEffectiveEnabledNames(session.sessionId);
    const disabled = mgr.getEffectiveDisabledNames(session.sessionId);

    expect(enabled).toContain('valid');
    expect(enabled).not.toContain('invalid');
    expect(disabled).toContain('invalid');
    expect(disabled).not.toContain('valid');
  });

  it('auto-recovery: re-declare with supported uses → removed from quarantine', () => {
    const session = createSession(mgr);

    // First declaration with unsupported uses
    const badDecl: Record<string, McplFeatureSet> = {
      channels: { uses: ['channels.publish'], description: 'Channels' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, badDecl);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, badDecl, 'test-delegate');

    expect(session.invalidFeatureSets.has('channels')).toBe(true);
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'channels')).toBe(false);

    // Re-declare with supported uses (via merge — simulates featureSets_changed)
    const goodDecl: Record<string, McplFeatureSet> = {
      channels: { uses: ['pushEvents'], description: 'Channels fixed' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, goodDecl);
    // enabledFeatureSets already has 'channels' — host intent preserved
    applyUsesValidation(mgr, session.sessionId, goodDecl, 'test-delegate');

    expect(session.invalidFeatureSets.has('channels')).toBe(false);
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'channels')).toBe(true);
  });

  it('quarantined names stay in declaredFeatureSets and enabledFeatureSets', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      quarantined: { uses: ['channels.observe'], description: 'Q' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    // Quarantined but still declared and in enabledFeatureSets (host intent)
    expect(session.declaredFeatureSets['quarantined']).toBeDefined();
    expect(session.enabledFeatureSets.has('quarantined')).toBe(true);
    expect(session.invalidFeatureSets.has('quarantined')).toBe(true);
  });

  it('validateCapability returns disabled for quarantined feature set', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      blocked: { uses: ['channels.publish', 'tools'], description: 'Blocked' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    const result = mgr.validateCapability('user-1', 'test-delegate', 'blocked', 'tool_management');
    expect(result).toBe('disabled');
  });

  it('undeclareFeatureSets cleans quarantine', () => {
    const session = createSession(mgr);
    const declared: Record<string, McplFeatureSet> = {
      temp: { uses: ['channels.observe'], description: 'Temp' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    expect(session.invalidFeatureSets.has('temp')).toBe(true);

    mgr.undeclareFeatureSets(session.sessionId, ['temp']);
    expect(session.invalidFeatureSets.has('temp')).toBe(false);
  });

  it('reconcileDeclaredFeatureSets cleans quarantine for removed names', () => {
    const session = createSession(mgr);

    // Declare two feature sets
    const decl1: Record<string, McplFeatureSet> = {
      keep: { uses: ['tools'], description: 'Keep' },
      remove: { uses: ['channels.observe'], description: 'Remove' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, decl1);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, decl1, 'test-delegate');

    expect(session.invalidFeatureSets.has('remove')).toBe(true);

    // Reconcile with only 'keep' — 'remove' should be cleaned
    const decl2: Record<string, McplFeatureSet> = {
      keep: { uses: ['tools'], description: 'Keep' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, decl2);

    expect(session.invalidFeatureSets.has('remove')).toBe(false);
  });
});

describe('buildFeatureSetPredicate', () => {
  it('blocks quarantined feature set tools even when conversation-enabled', () => {
    // This is a conceptual test — verifying the logic flow.
    // When runtime layer returns false (quarantined), the combined predicate
    // should return false regardless of conversation layer.
    const mgr = createSessionManager();
    const session = createSession(mgr);

    const declared: Record<string, McplFeatureSet> = {
      quarantined_fs: { uses: ['channels.publish'], description: 'Q' },
    };
    mgr.reconcileDeclaredFeatureSets(session.sessionId, declared);
    mgr.enableAllDeclaredFeatureSets(session.sessionId);
    applyUsesValidation(mgr, session.sessionId, declared, 'test-delegate');

    // Runtime layer: quarantined → effectively disabled
    expect(mgr.isFeatureSetEffectivelyEnabled(session.sessionId, 'quarantined_fs')).toBe(false);

    // The combined predicate would short-circuit on this false
    // (actual buildFeatureSetPredicate needs db — tested at integration level)
  });
});

describe('scope_elevate preflight validation', () => {
  it('validates that unsupported uses are detected', () => {
    const { unsupported } = validateDeclarationUses(['channels.observe']);
    expect(unsupported).toContain('channels.observe');
    expect(unsupported.length).toBe(1);
  });

  it('validates that supported uses pass', () => {
    const { unsupported } = validateDeclarationUses(['pushEvents', 'tools']);
    expect(unsupported).toHaveLength(0);
  });

  it('undeclared featureSet is not in session', () => {
    const mgr = createSessionManager();
    createSession(mgr);

    // Session exists but featureSet 'nonexistent' is not declared
    const sess = mgr.getSessionForDelegate('user-1', 'test-delegate');
    expect(sess).toBeDefined();
    expect(sess!.declaredFeatureSets['nonexistent']).toBeUndefined();
  });

  it('missing delegate returns undefined session', () => {
    const mgr = createSessionManager();
    const sess = mgr.getSessionForDelegate('user-1', 'no-such-delegate');
    expect(sess).toBeUndefined();
  });
});
