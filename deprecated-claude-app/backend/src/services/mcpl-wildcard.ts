/**
 * MCPL Wildcard Matching
 *
 * Provides wildcard expansion for featureSet keys.
 * Pattern: "memory.*" matches any serverId starting with "memory." (recursive).
 * Only trailing `.*` is supported (not globs, not `mem*.foo`).
 *
 * Rules:
 *   - "foo.*"  matches "foo.bar" and "foo.bar.baz" (recursive prefix)
 *   - "foo"    matches only "foo" exactly
 *   - Concrete keys override wildcards: if both "memory.*" and "memory.notes" exist,
 *     "memory.notes" wins for serverId "memory.notes"
 *   - Invalid patterns (e.g., "*foo", "foo.*.bar") → skip with warning, don't crash
 */

import type { McplFeatureSet } from '@deprecated-claude/shared';

// =============================================================================
// Pattern Matching
// =============================================================================

/**
 * Check if a pattern is a valid wildcard pattern.
 * Valid: "foo.*" (trailing .*), "foo" (exact).
 * Invalid: "*foo", "foo.*.bar", "*.foo", etc.
 */
function isValidPattern(pattern: string): boolean {
  if (!pattern || pattern.length === 0) return false;

  // Exact match (no wildcard) — always valid
  if (!pattern.includes('*')) return true;

  // Must end with ".*" and have no other wildcards
  if (!pattern.endsWith('.*')) return false;

  // Check the prefix before ".*" has no wildcards
  const prefix = pattern.slice(0, -2);
  if (prefix.includes('*')) return false;

  // Prefix must be non-empty
  if (prefix.length === 0) return false;

  return true;
}

/**
 * Check if a serverId matches a pattern (exact or wildcard).
 *
 * "foo.*" matches "foo.bar", "foo.bar.baz" (recursive prefix match)
 * "foo"   matches only "foo" exactly
 */
export function matchesPattern(pattern: string, serverId: string): boolean {
  if (!isValidPattern(pattern)) return false;

  // Exact match
  if (!pattern.endsWith('.*')) {
    return pattern === serverId;
  }

  // Wildcard: "foo.*" → serverId must start with "foo."
  const prefix = pattern.slice(0, -1); // "foo.*" → "foo."
  return serverId.startsWith(prefix);
}

// =============================================================================
// Wildcard Expansion
// =============================================================================

/**
 * Expand wildcard featureSet keys against a concrete serverIds list.
 *
 * "memory.*" matches any serverId starting with "memory."
 * Returns a flat Record<string, McplFeatureSet> with all wildcards expanded.
 *
 * Concrete keys override wildcards:
 *   { "memory.*": fsA, "memory.notes": fsB } with serverIds ["memory.notes", "memory.cal"]
 *   → { "memory.notes": fsB, "memory.cal": fsA }
 */
export function expandWildcards(
  featureSets: Record<string, McplFeatureSet>,
  serverIds: string[]
): Record<string, McplFeatureSet> {
  const result: Record<string, McplFeatureSet> = {};

  // Separate concrete keys from wildcard keys
  const concreteKeys: Array<[string, McplFeatureSet]> = [];
  const wildcardKeys: Array<[string, McplFeatureSet]> = [];

  for (const [pattern, fs] of Object.entries(featureSets)) {
    if (!isValidPattern(pattern)) {
      console.warn(`[McplWildcard] Invalid pattern "${pattern}", skipping`);
      continue;
    }

    if (pattern.endsWith('.*')) {
      wildcardKeys.push([pattern, fs]);
    } else {
      concreteKeys.push([pattern, fs]);
    }
  }

  // Step 1: Apply wildcards first (lower priority)
  for (const [pattern, fs] of wildcardKeys) {
    for (const serverId of serverIds) {
      if (matchesPattern(pattern, serverId)) {
        // Only set if not already set by a more specific wildcard
        // (first wildcard match wins among wildcards)
        if (!(serverId in result)) {
          result[serverId] = fs;
        }
      }
    }
  }

  // Step 2: Apply concrete keys (higher priority — override wildcards)
  for (const [key, fs] of concreteKeys) {
    result[key] = fs;
  }

  return result;
}
