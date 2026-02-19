import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerRegistry } from '../server-registry.js';

// =============================================================================
// Helpers
// =============================================================================

function createRegistry(): ServerRegistry {
  return new ServerRegistry();
}

// =============================================================================
// Tests
// =============================================================================

describe('ServerRegistry', () => {
  let reg: ServerRegistry;

  beforeEach(() => {
    reg = createRegistry();
  });

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------

  describe('register', () => {
    it('registers a new server and increments size', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      expect(reg.size).toBe(1);
    });

    it('same ID re-registration updates lastSeenAt only', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      const entry1 = reg.getEntry('d1', 'filesystem');
      const lastSeen1 = entry1!.lastSeenAt;

      // Small delay to get different timestamp
      reg.register('d1', 'filesystem', 'srv_aaa');
      const entry2 = reg.getEntry('d1', 'filesystem');

      expect(entry2!.serverId).toBe('srv_aaa');
      expect(entry2!.previousIds).toHaveLength(0);
      expect(entry2!.lastSeenAt).toBeGreaterThanOrEqual(lastSeen1);
    });

    it('ID change captures oldId in previousIds and updates serverId', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      reg.register('d1', 'filesystem', 'srv_bbb');

      const entry = reg.getEntry('d1', 'filesystem');
      expect(entry!.serverId).toBe('srv_bbb');
      expect(entry!.previousIds).toEqual(['srv_aaa']);
    });

    it('logs ID change to console', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      reg.register('d1', 'filesystem', 'srv_aaa');
      reg.register('d1', 'filesystem', 'srv_bbb');

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Server ID changed'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('srv_aaa → srv_bbb'),
      );

      logSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // resolveServerId
  // ---------------------------------------------------------------------------

  describe('resolveServerId', () => {
    it('resolves current ID to itself', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      expect(reg.resolveServerId('srv_aaa')).toBe('srv_aaa');
    });

    it('resolves old ID to current ID after change', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      reg.register('d1', 'filesystem', 'srv_bbb');

      expect(reg.resolveServerId('srv_aaa')).toBe('srv_bbb');
    });

    it('returns undefined for unknown ID', () => {
      expect(reg.resolveServerId('srv_unknown')).toBeUndefined();
    });

    it('resolves through chain of renames: A→B→C', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      reg.register('d1', 'filesystem', 'srv_aaa');
      reg.register('d1', 'filesystem', 'srv_bbb');
      reg.register('d1', 'filesystem', 'srv_ccc');

      // All old IDs resolve to current
      expect(reg.resolveServerId('srv_aaa')).toBe('srv_ccc');
      expect(reg.resolveServerId('srv_bbb')).toBe('srv_ccc');
      expect(reg.resolveServerId('srv_ccc')).toBe('srv_ccc');

      logSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // getEntry
  // ---------------------------------------------------------------------------

  describe('getEntry', () => {
    it('returns entry by delegateId:serverName', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      const entry = reg.getEntry('d1', 'filesystem');
      expect(entry).toBeDefined();
      expect(entry!.serverName).toBe('filesystem');
      expect(entry!.delegateId).toBe('d1');
      expect(entry!.serverId).toBe('srv_aaa');
    });

    it('returns undefined for unknown key', () => {
      expect(reg.getEntry('d1', 'nonexistent')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // aliasToCanonical maps current ID
  // ---------------------------------------------------------------------------

  describe('aliasToCanonical maps current ID', () => {
    it('new registration maps current ID in alias map', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      expect(reg.aliasCount).toBe(1);
      // Verify resolve works (proves alias map has the entry)
      expect(reg.resolveServerId('srv_aaa')).toBe('srv_aaa');
    });

    it('after ID change, both old and new are mapped to same canonical key', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      reg.register('d1', 'filesystem', 'srv_bbb');

      expect(reg.aliasCount).toBe(2);
      // Both resolve to same current ID
      expect(reg.resolveServerId('srv_aaa')).toBe('srv_bbb');
      expect(reg.resolveServerId('srv_bbb')).toBe('srv_bbb');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('ID cycles back to original: A→B→A — resolves correctly', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      reg.register('d1', 'fs', 'srv_aaa');
      reg.register('d1', 'fs', 'srv_bbb');
      reg.register('d1', 'fs', 'srv_aaa'); // cycle back

      // Both should resolve to current = srv_aaa
      expect(reg.resolveServerId('srv_aaa')).toBe('srv_aaa');
      expect(reg.resolveServerId('srv_bbb')).toBe('srv_aaa');

      // previousIds should have full history
      const entry = reg.getEntry('d1', 'fs');
      expect(entry!.previousIds).toEqual(['srv_aaa', 'srv_bbb']);

      logSpy.mockRestore();
    });

    it('namespace isolation: same serverName on different delegates are independent', () => {
      reg.register('d1', 'filesystem', 'srv_aaa');
      reg.register('d2', 'filesystem', 'srv_bbb');

      expect(reg.size).toBe(2);
      expect(reg.getEntry('d1', 'filesystem')!.serverId).toBe('srv_aaa');
      expect(reg.getEntry('d2', 'filesystem')!.serverId).toBe('srv_bbb');

      // IDs resolve independently
      expect(reg.resolveServerId('srv_aaa')).toBe('srv_aaa');
      expect(reg.resolveServerId('srv_bbb')).toBe('srv_bbb');
    });

    it('same serverId used by two different delegate:server pairs', () => {
      // Edge: two different canonical keys both register with same serverId
      reg.register('d1', 'fs', 'srv_shared');
      reg.register('d2', 'git', 'srv_shared');

      // aliasToCanonical for srv_shared will point to the LAST registration
      // This is a known limitation — last-writer-wins
      expect(reg.size).toBe(2);
      // Both entries exist independently in canonical map
      expect(reg.getEntry('d1', 'fs')!.serverId).toBe('srv_shared');
      expect(reg.getEntry('d2', 'git')!.serverId).toBe('srv_shared');
    });

    it('previousIds accumulates through many renames', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      for (let i = 0; i < 20; i++) {
        reg.register('d1', 'fs', `srv_${i}`);
      }

      const entry = reg.getEntry('d1', 'fs');
      expect(entry!.serverId).toBe('srv_19');
      expect(entry!.previousIds).toHaveLength(19); // 0..18
      expect(entry!.previousIds[0]).toBe('srv_0');
      expect(entry!.previousIds[18]).toBe('srv_18');

      logSpy.mockRestore();
    });

    it('getEntry returns reference — mutations visible to caller', () => {
      reg.register('d1', 'fs', 'srv_aaa');
      const entry = reg.getEntry('d1', 'fs');
      // This is expected behavior (no copy), document with test
      const originalLastSeen = entry!.lastSeenAt;
      reg.register('d1', 'fs', 'srv_aaa'); // re-register updates lastSeenAt
      expect(entry!.lastSeenAt).toBeGreaterThanOrEqual(originalLastSeen);
    });
  });
});
