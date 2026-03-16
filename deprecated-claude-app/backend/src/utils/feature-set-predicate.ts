/**
 * Combined feature-set predicate for tool availability.
 *
 * Combines two layers:
 *   1. Runtime layer: mcplSessionManager.isFeatureSetEffectivelyEnabled()
 *      (enabled AND not quarantined)
 *   2. Conversation layer: db.isFeatureSetEnabled()
 *      (not disabled for this conversation)
 *
 * Fail-closed: no session → tools unavailable.
 */

import { mcplSessionManager } from '../delegate/mcpl-session-manager.js';
import type { Database } from '../database/index.js';

/**
 * Build a combined predicate for tool availability:
 *   runtimeEffective(userId, delegateId, featureSet) && conversationEnabled(conversationId, delegateId, featureSet)
 *
 * - Runtime layer: mcplSessionManager.isFeatureSetEffectivelyEnabled()
 * - Conversation layer: db.isFeatureSetEnabled()
 */
export function buildFeatureSetPredicate(
  userId: string,
  conversationId: string,
  db: Database
): (delegateId: string, featureSet: string) => boolean {
  return (delegateId: string, featureSet: string) => {
    // 1. Runtime layer: fail-closed if no session found
    const session = mcplSessionManager.getSessionForDelegate(userId, delegateId);
    if (!session) return false; // fail-closed: no session → tools unavailable
    if (!mcplSessionManager.isFeatureSetEffectivelyEnabled(session.sessionId, featureSet)) {
      return false;
    }
    // 2. Conversation layer: not disabled for this conversation?
    return db.isFeatureSetEnabled(conversationId, delegateId, featureSet);
  };
}
