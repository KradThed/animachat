import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InferenceRouter, RoutingRule } from '../inference-routing.js';

/**
 * Unit tests for InferenceRouter.resolve() matching logic.
 *
 * We bypass loadConfig (which reads disk + validates models) by setting
 * the private `rules` and `defaultConfig` fields directly.
 */

function setRules(router: InferenceRouter, rules: RoutingRule[]): void {
  (router as any).rules = rules;
}

function setDefault(router: InferenceRouter, cfg: { useConversationModel?: boolean; provider?: string; model?: string }): void {
  (router as any).defaultConfig = cfg;
}

describe('InferenceRouter', () => {
  let router: InferenceRouter;

  beforeEach(() => {
    router = new InferenceRouter('/nonexistent/path.json');
  });

  // ---------------------------------------------------------------------------
  // featureSet matching
  // ---------------------------------------------------------------------------
  describe('featureSet matching', () => {
    it('matches exact featureSet', () => {
      setRules(router, [
        { match: { featureSet: 'memory.recall' }, route: { provider: 'openai', model: 'gpt-4o' } },
      ]);

      const result = router.resolve({ delegateId: 'any', featureSet: 'memory.recall' });
      expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
    });

    it('matches wildcard featureSet (memory.*)', () => {
      setRules(router, [
        { match: { featureSet: 'memory.*' }, route: { provider: 'anthropic', model: 'claude-sonnet' } },
      ]);

      const result = router.resolve({ delegateId: 'any', featureSet: 'memory.summarize' });
      expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet' });
    });

    it('no match when featureSet differs', () => {
      setRules(router, [
        { match: { featureSet: 'vision.ocr' }, route: { provider: 'openai', model: 'gpt-4o' } },
      ]);

      const result = router.resolve({ delegateId: 'any', featureSet: 'memory.recall' });
      expect(result).toBeNull(); // falls through to default (useConversationModel)
    });
  });

  // ---------------------------------------------------------------------------
  // serverId deprecated alias
  // ---------------------------------------------------------------------------
  describe('serverId deprecated alias', () => {
    it('match.serverId matches against context.featureSet (not a real serverId)', () => {
      setRules(router, [
        { match: { serverId: 'tools.search' }, route: { provider: 'openai', model: 'gpt-4o-mini' } },
      ]);

      const result = router.resolve({ delegateId: 'any', featureSet: 'tools.search' });
      expect(result).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    });

    it('match.serverId wildcard works against context.featureSet', () => {
      setRules(router, [
        { match: { serverId: 'tools.*' }, route: { provider: 'openai', model: 'gpt-4o-mini' } },
      ]);

      const result = router.resolve({ delegateId: 'any', featureSet: 'tools.search' });
      expect(result).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    });

    it('match.serverId + match.featureSet both present — AND semantics', () => {
      setRules(router, [
        {
          match: { featureSet: 'tools.*', serverId: 'tools.search' },
          route: { provider: 'openai', model: 'gpt-4o' },
        },
      ]);

      // Both conditions satisfied
      expect(router.resolve({ delegateId: 'any', featureSet: 'tools.search' }))
        .toEqual({ provider: 'openai', model: 'gpt-4o' });

      // featureSet matches wildcard, but serverId expects exact 'tools.search'
      expect(router.resolve({ delegateId: 'any', featureSet: 'tools.other' }))
        .toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // default behavior
  // ---------------------------------------------------------------------------
  describe('default behavior', () => {
    it('useConversationModel returns null', () => {
      setRules(router, []);
      setDefault(router, { useConversationModel: true });

      const result = router.resolve({ delegateId: 'any' });
      expect(result).toBeNull();
    });

    it('explicit default returns provider + model', () => {
      setRules(router, []);
      setDefault(router, { provider: 'anthropic', model: 'claude-opus' });

      const result = router.resolve({ delegateId: 'any' });
      expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus' });
    });
  });

  // ---------------------------------------------------------------------------
  // first-match-wins
  // ---------------------------------------------------------------------------
  describe('first-match-wins', () => {
    it('returns first matching rule, skips later', () => {
      setRules(router, [
        { match: { featureSet: 'memory.*' }, route: { provider: 'openai', model: 'gpt-4o' } },
        { match: { featureSet: 'memory.recall' }, route: { provider: 'anthropic', model: 'claude-sonnet' } },
      ]);

      // 'memory.recall' matches both rules — first one wins
      const result = router.resolve({ delegateId: 'any', featureSet: 'memory.recall' });
      expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
    });
  });
});
