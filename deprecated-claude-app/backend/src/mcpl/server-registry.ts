/**
 * Server Registry (Fix #3)
 *
 * Maps delegateId:serverName → canonical serverId, with alias tracking
 * for old IDs. Enables O(1) resolution of stale serverIds from event store.
 *
 * Canonical key = delegateId:serverName. serverName must be stable and unique
 * per delegate. If user renames serverName in config, it's treated as a new
 * server (new canonical key) — this is correct behavior, not a bug.
 *
 * Persistence: atomic write (temp file + rename) following the same pattern
 * as writeConfigRaw() in the delegate's config-utils.ts.
 */

// =============================================================================
// Types
// =============================================================================

interface ServerEntry {
  serverId: string;
  previousIds: string[];
  serverName: string;
  delegateId: string;
  lastSeenAt: number;  // updated on every register() — aids debugging
}

// =============================================================================
// ServerRegistry
// =============================================================================

export class ServerRegistry {
  // canonical key (delegateId:serverName) → entry
  private canonical = new Map<string, ServerEntry>();

  // ANY serverId (old or current) → canonical key — O(1) resolve
  private aliasToCanonical = new Map<string, string>();

  /**
   * Register a server with its current ID.
   * On ID change: captures oldId BEFORE mutation, pushes to previousIds,
   * and updates aliasToCanonical.
   *
   * Callers should dedup (delegateId, serverName, serverId) tuples before
   * calling this — prevents spam when manifest has many tools from same server.
   */
  register(delegateId: string, serverName: string, serverId: string): void {
    const canonicalKey = `${delegateId}:${serverName}`;
    const existing = this.canonical.get(canonicalKey);

    if (existing) {
      if (existing.serverId === serverId) {
        // Same ID — just update lastSeenAt
        existing.lastSeenAt = Date.now();
        return;
      }

      // ID changed! Bug fix: capture oldId BEFORE mutation
      const oldId = existing.serverId;
      existing.previousIds.push(oldId);
      existing.serverId = serverId;
      existing.lastSeenAt = Date.now();

      // Update alias maps
      this.aliasToCanonical.set(oldId, canonicalKey);
      this.aliasToCanonical.set(serverId, canonicalKey);

      console.log(
        `[ServerRegistry] Server ID changed: ${serverName} (${delegateId}): ${oldId} → ${serverId}`
      );
    } else {
      // New server
      const entry: ServerEntry = {
        serverId,
        previousIds: [],
        serverName,
        delegateId,
        lastSeenAt: Date.now(),
      };
      this.canonical.set(canonicalKey, entry);
      this.aliasToCanonical.set(serverId, canonicalKey);
    }
  }

  /**
   * Resolve a serverId (possibly old) to the current canonical serverId.
   * O(1) lookup via aliasToCanonical map.
   * Returns undefined if the serverId is unknown.
   */
  resolveServerId(maybeOldId: string): string | undefined {
    const canonicalKey = this.aliasToCanonical.get(maybeOldId);
    if (!canonicalKey) return undefined;

    const entry = this.canonical.get(canonicalKey);
    return entry?.serverId;
  }

  /**
   * Get the full entry for a server by its canonical key.
   */
  getEntry(delegateId: string, serverName: string): ServerEntry | undefined {
    return this.canonical.get(`${delegateId}:${serverName}`);
  }

  /**
   * Current registry size (for testing/metrics).
   */
  get size(): number {
    return this.canonical.size;
  }

  get aliasCount(): number {
    return this.aliasToCanonical.size;
  }
}

// Singleton instance
export const serverRegistry = new ServerRegistry();
