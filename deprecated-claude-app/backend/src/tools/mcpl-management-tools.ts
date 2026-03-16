/**
 * MCPL Agent Management Tools
 *
 * Built-in tools that let the AI agent inspect and manage connected MCP feature sets.
 * These are registered as server-side tools (available to all users, unprefixed).
 *
 * Tools:
 *   - list_mcp_feature_sets: List delegates and their feature sets (MCPL tool — user-scoped)
 *   - get_feature_set_status: Get detail for a specific feature set (MCPL tool — user-scoped)
 *   - enable_feature_set: Enable a feature set for the current conversation (MCPL tool)
 *   - disable_feature_set: Disable a feature set for the current conversation (MCPL tool)
 */

import { toolRegistry } from './tool-registry.js';
import { delegateManager } from '../delegate/delegate-manager.js';
import { mcplSessionManager } from '../delegate/mcpl-session-manager.js';
import { mcplEventQueue } from '../services/mcpl-event-queue.js';
import { mcplHookManager } from '../services/mcpl-hook-manager.js';
import { mcplInferenceBroker } from '../services/mcpl-inference-broker.js';
import { matchesPattern } from '../services/mcpl-wildcard.js';
import { getScopePoliciesForUser, revokeScopePolicyRule } from '../delegate/delegate-handler.js';
import type { Database } from '../database/index.js';
import { buildFeatureSetPredicate } from '../utils/feature-set-predicate.js';

/**
 * Count delegate tools for a user, optionally filtered by delegateId and featureSet.
 * Returns total count (no conversation filter) and visible count (with conversation filter).
 */
function countToolsForFeatureSet(
  userId: string,
  delegateId: string,
  featureSet: string,
  conversationId?: string,
  db?: Database
): { totalToolCount: number; visibleToolCount?: number } {
  // Get all tools with source info (no conversation filter = total)
  const allTools = toolRegistry.getToolsForUserWithSource(userId);
  const totalToolCount = allTools.filter(
    t => t.source === 'delegate' && t.delegateId === delegateId && t.featureSet === featureSet
  ).length;

  if (!conversationId || !db) {
    return { totalToolCount };
  }

  // With conversation filter (combined runtime + conversation predicate)
  const isEnabled = buildFeatureSetPredicate(userId, conversationId, db);
  const visibleTools = toolRegistry.getToolsForUserWithSource(userId, isEnabled);
  const visibleToolCount = visibleTools.filter(
    t => t.source === 'delegate' && t.delegateId === delegateId && t.featureSet === featureSet
  ).length;

  return { totalToolCount, visibleToolCount };
}

/**
 * Register all MCPL management tools with the tool registry.
 */
export function registerMcplManagementTools(db: Database): void {
  // -------------------------------------------------------------------------
  // list_mcp_feature_sets (MCPL tool — user-scoped)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'list_mcp_feature_sets',
    {
      name: 'list_mcp_feature_sets',
      description:
        'List your connected delegate apps and their feature sets. ' +
        'Shows delegate names, feature set names, enabled state, tool counts, and capabilities.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    async (_input, context) => {
      const { userId, conversationId } = context;

      // Group feature sets by delegate
      const entries = mcplSessionManager.getFeatureSetEntriesForUser(userId);
      const delegateMap = new Map<string, Array<{
        name: string;
        description?: string;
        uses: string[];
        runtimeEnabled: boolean;
        conversationEnabled?: boolean;
        visible?: boolean;
        totalToolCount: number;
        visibleToolCount?: number;
      }>>();

      for (const entry of entries) {
        const session = mcplSessionManager.getSessionForDelegate(userId, entry.delegateId);
        if (!session) continue;

        const decl = session.declaredFeatureSets[entry.featureSet];
        if (!decl) continue;

        const runtimeEnabled = mcplSessionManager.isFeatureSetEffectivelyEnabled(session.sessionId, entry.featureSet);
        const quarantined = session.invalidFeatureSets.has(entry.featureSet);

        const counts = countToolsForFeatureSet(
          userId, entry.delegateId, entry.featureSet,
          conversationId || undefined, db
        );

        const featureSetInfo: any = {
          name: entry.featureSet,
          description: decl.description,
          uses: decl.rawUses,
          runtimeEnabled,
          quarantined,
          totalToolCount: counts.totalToolCount,
        };

        if (conversationId) {
          const conversationEnabled = db.isFeatureSetEnabled(conversationId, entry.delegateId, entry.featureSet);
          featureSetInfo.conversationEnabled = conversationEnabled;
          featureSetInfo.visible = runtimeEnabled && conversationEnabled;
          featureSetInfo.visibleToolCount = counts.visibleToolCount;
        }

        if (!delegateMap.has(entry.delegateId)) {
          delegateMap.set(entry.delegateId, []);
        }
        delegateMap.get(entry.delegateId)!.push(featureSetInfo);
      }

      const delegates = Array.from(delegateMap.entries()).map(([delegateId, featureSets]) => ({
        delegateId,
        featureSets,
      }));

      const queueStats = mcplEventQueue.getStats();
      const hookStats = mcplHookManager.getStats();
      const brokerStats = mcplInferenceBroker.getStats();

      const result = {
        delegates,
        totalDelegates: delegates.length,
        eventQueue: {
          totalQueued: queueStats.totalQueued,
          processedThisHour: queueStats.processedThisHour,
          maxPerHour: queueStats.maxPerHour,
        },
        hooks: {
          registeredServers: hookStats.registeredServers,
        },
        inference: {
          activeRequests: brokerStats.activeRequests,
          completedThisHour: brokerStats.completedThisHour,
          maxPerHour: brokerStats.maxPerHour,
        },
      };

      return {
        toolUseId: '',
        content: JSON.stringify(result, null, 2),
        isError: false,
      };
    }
  );

  // -------------------------------------------------------------------------
  // get_feature_set_status (MCPL tool — user-scoped)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'get_feature_set_status',
    {
      name: 'get_feature_set_status',
      description:
        'Get detailed status for a specific feature set from a delegate. ' +
        'Shows uses, scope rules, enabled state, and tool counts.',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: {
            type: 'string',
            description: 'The exact delegate ID to inspect',
          },
          featureSet: {
            type: 'string',
            description: 'The exact feature set name to inspect',
          },
        },
        required: ['delegateId', 'featureSet'],
      },
    },
    async (input, context) => {
      const delegateId = input.delegateId as string;
      const featureSetName = input.featureSet as string;
      const { userId, conversationId } = context;

      // Validate delegate exists for this user
      const delegate = delegateManager.findDelegate(userId, delegateId);
      if (!delegate) {
        const stats = delegateManager.getStats();
        const userDelegates = stats.delegates
          .filter(d => d.userId === userId)
          .map(d => d.delegateId);
        return {
          toolUseId: '',
          content: JSON.stringify({
            error: `Delegate "${delegateId}" not found`,
            availableDelegates: userDelegates,
          }),
          isError: true,
        };
      }

      // Validate feature set exists
      const session = mcplSessionManager.getSessionForDelegate(userId, delegateId);
      if (!session) {
        return {
          toolUseId: '',
          content: JSON.stringify({ error: `No MCPL session for delegate "${delegateId}"` }),
          isError: true,
        };
      }

      const decl = session.declaredFeatureSets[featureSetName];
      if (!decl) {
        const available = Object.keys(session.declaredFeatureSets);
        return {
          toolUseId: '',
          content: JSON.stringify({
            error: `Feature set "${featureSetName}" not found on delegate "${delegateId}"`,
            availableFeatureSets: available,
          }),
          isError: true,
        };
      }

      const runtimeEnabled = mcplSessionManager.isFeatureSetEffectivelyEnabled(session.sessionId, featureSetName);
      const quarantined = session.invalidFeatureSets.has(featureSetName);
      const scopeState = session.scopesByFeatureSet[featureSetName];

      const counts = countToolsForFeatureSet(
        userId, delegateId, featureSetName,
        conversationId || undefined, db
      );

      const result: any = {
        delegateId,
        featureSet: featureSetName,
        description: decl.description,
        uses: decl.rawUses,
        scoped: decl.scoped ?? false,
        runtimeEnabled,
        quarantined,
        totalToolCount: counts.totalToolCount,
      };

      if (conversationId) {
        const conversationEnabled = db.isFeatureSetEnabled(conversationId, delegateId, featureSetName);
        result.conversationEnabled = conversationEnabled;
        result.visible = runtimeEnabled && conversationEnabled;
        result.visibleToolCount = counts.visibleToolCount;
      }

      if (scopeState) {
        result.scopeRules = scopeState;
      }

      return {
        toolUseId: '',
        content: JSON.stringify(result, null, 2),
        isError: false,
      };
    }
  );

  // -------------------------------------------------------------------------
  // enable_feature_set (MCPL tool — exact delegateId, wildcard featureSet)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'enable_feature_set',
    {
      name: 'enable_feature_set',
      description:
        'Enable a feature set\'s tools for the current conversation. ' +
        'Re-includes the feature set\'s tools in the tool list. ' +
        'Supports wildcards for featureSet: "memory.*" enables all feature sets starting with "memory.".',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: {
            type: 'string',
            description: 'The exact delegate ID (no wildcards)',
          },
          featureSet: {
            type: 'string',
            description: 'The feature set name to enable (supports wildcards, e.g. "memory.*")',
          },
        },
        required: ['delegateId', 'featureSet'],
      },
    },
    async (input, context) => {
      const delegateId = input.delegateId as string;
      const featureSetPattern = input.featureSet as string;
      const { userId, conversationId } = context;

      if (!conversationId) {
        return { toolUseId: '', content: 'No active conversation', isError: true };
      }

      // Validate delegate exists for this user
      const delegate = delegateManager.findDelegate(userId, delegateId);
      if (!delegate) {
        const stats = delegateManager.getStats();
        const userDelegates = stats.delegates
          .filter(d => d.userId === userId)
          .map(d => d.delegateId);
        return {
          toolUseId: '',
          content: `Delegate "${delegateId}" not found. Available: ${userDelegates.join(', ') || 'none'}`,
          isError: true,
        };
      }

      // Match featureSet pattern against declared feature sets
      const declaredNames = mcplSessionManager.getFeatureSetNamesForDelegate(userId, delegateId);
      const matchingNames = declaredNames.filter(name => matchesPattern(featureSetPattern, name));

      if (matchingNames.length === 0) {
        return {
          toolUseId: '',
          content: `No feature sets matching "${featureSetPattern}" on delegate "${delegateId}". Available: ${declaredNames.join(', ') || 'none'}`,
          isError: true,
        };
      }

      let totalToolCount = 0;
      const enabledNames: string[] = [];

      for (const name of matchingNames) {
        await db.setFeatureSetEnabled(conversationId, delegateId, name, true, 'agent');
        const counts = countToolsForFeatureSet(userId, delegateId, name);
        totalToolCount += counts.totalToolCount;
        enabledNames.push(name);
      }

      return {
        toolUseId: '',
        content: `Enabled ${enabledNames.length} feature set(s) on delegate "${delegateId}" for this conversation: ${enabledNames.join(', ')} (${totalToolCount} tools).`,
        isError: false,
      };
    }
  );

  // -------------------------------------------------------------------------
  // disable_feature_set (MCPL tool — exact delegateId, wildcard featureSet)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'disable_feature_set',
    {
      name: 'disable_feature_set',
      description:
        'Disable a feature set\'s tools for the current conversation. ' +
        'The delegate stays connected but the feature set\'s tools are excluded from tool lists. ' +
        'Supports wildcards for featureSet: "memory.*" disables all feature sets starting with "memory.".',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: {
            type: 'string',
            description: 'The exact delegate ID (no wildcards)',
          },
          featureSet: {
            type: 'string',
            description: 'The feature set name to disable (supports wildcards, e.g. "memory.*")',
          },
        },
        required: ['delegateId', 'featureSet'],
      },
    },
    async (input, context) => {
      const delegateId = input.delegateId as string;
      const featureSetPattern = input.featureSet as string;
      const { userId, conversationId } = context;

      if (!conversationId) {
        return { toolUseId: '', content: 'No active conversation', isError: true };
      }

      // Validate delegate exists for this user
      const delegate = delegateManager.findDelegate(userId, delegateId);
      if (!delegate) {
        return {
          toolUseId: '',
          content: `Delegate "${delegateId}" not found.`,
          isError: true,
        };
      }

      // Match featureSet pattern against declared feature sets
      const declaredNames = mcplSessionManager.getFeatureSetNamesForDelegate(userId, delegateId);
      const matchingNames = declaredNames.filter(name => matchesPattern(featureSetPattern, name));

      if (matchingNames.length === 0) {
        return {
          toolUseId: '',
          content: `No feature sets matching "${featureSetPattern}" on delegate "${delegateId}". Available: ${declaredNames.join(', ') || 'none'}`,
          isError: true,
        };
      }

      let totalToolCount = 0;
      const disabledNames: string[] = [];

      for (const name of matchingNames) {
        await db.setFeatureSetEnabled(conversationId, delegateId, name, false, 'agent');
        const counts = countToolsForFeatureSet(userId, delegateId, name);
        totalToolCount += counts.totalToolCount;
        disabledNames.push(name);
      }

      return {
        toolUseId: '',
        content: `Disabled ${disabledNames.length} feature set(s) on delegate "${delegateId}" for this conversation: ${disabledNames.join(', ')} (${totalToolCount} tools excluded).`,
        isError: false,
      };
    }
  );

  // -------------------------------------------------------------------------
  // manage_scope_policies (MCPL tool — manages user scope policies)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'manage_scope_policies',
    {
      name: 'manage_scope_policies',
      description:
        'List or revoke scope access policies for delegates. ' +
        'Policies control auto-approve/deny for capability elevation requests.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action to perform: "list" or "revoke"',
          },
          delegateId: {
            type: 'string',
            description: 'Optional: filter by delegate ID',
          },
          featureSet: {
            type: 'string',
            description: 'Required for "revoke": the featureSet pattern to revoke',
          },
          label: {
            type: 'string',
            description: 'Optional for "revoke": specific label to revoke',
          },
        },
        required: ['action'],
      },
    },
    async (input, context) => {
      const action = input.action as string;
      const { userId } = context;

      if (action === 'list') {
        const policies = getScopePoliciesForUser(userId, input.delegateId as string | undefined);
        return {
          toolUseId: '',
          content: JSON.stringify(policies, null, 2),
          isError: false,
        };
      }

      if (action === 'revoke') {
        const delegateId = input.delegateId as string;
        const featureSet = input.featureSet as string;
        if (!delegateId || !featureSet) {
          return {
            toolUseId: '',
            content: 'Both delegateId and featureSet are required for revoke action',
            isError: true,
          };
        }
        const revoked = revokeScopePolicyRule(userId, delegateId, featureSet, input.label as string | undefined);
        return {
          toolUseId: '',
          content: revoked
            ? `Revoked policy rule for ${delegateId}/${featureSet}${input.label ? `/${input.label}` : ''}`
            : `No matching policy rule found for ${delegateId}/${featureSet}`,
          isError: !revoked,
        };
      }

      return {
        toolUseId: '',
        content: `Unknown action "${action}". Use "list" or "revoke".`,
        isError: true,
      };
    }
  );

  console.log('[McplManagementTools] Registered 5 MCPL management tools');
}
