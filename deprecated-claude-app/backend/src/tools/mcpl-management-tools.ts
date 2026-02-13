/**
 * MCPL Agent Management Tools
 *
 * Built-in tools that let the AI agent inspect and manage connected MCP servers.
 * These are registered as server-side tools (available to all users, unprefixed).
 *
 * Tools:
 *   - list_mcp_servers: List connected delegates and their servers (regular tool)
 *   - get_server_status: Get health/capabilities for a specific server (regular tool)
 *   - enable_server: Enable a server's tools for the current conversation (MCPL tool)
 *   - disable_server: Disable a server's tools for the current conversation (MCPL tool)
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

/**
 * Register all MCPL management tools with the tool registry.
 */
export function registerMcplManagementTools(db: Database): void {
  // -------------------------------------------------------------------------
  // list_mcp_servers (regular tool — no context needed)
  // -------------------------------------------------------------------------
  toolRegistry.registerServerTool(
    'list_mcp_servers',
    {
      name: 'list_mcp_servers',
      description:
        'List all connected delegate apps and their MCP servers. ' +
        'Shows delegate names, connected servers, tool counts, and capabilities.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    async () => {
      const stats = delegateManager.getStats();
      const delegates = stats.delegates.map(d => {
        const full = delegateManager.findDelegate(d.userId, d.delegateId);
        const serverNames = new Set<string>();
        if (full) {
          for (const tool of full.tools) {
            if ((tool as any).serverName) {
              serverNames.add((tool as any).serverName);
            }
          }
        }

        return {
          delegateId: d.delegateId,
          toolCount: d.toolCount,
          servers: Array.from(serverNames),
          connectedAt: d.connectedAt.toISOString(),
        };
      });

      const mcplStats = mcplSessionManager.getStats();
      const queueStats = mcplEventQueue.getStats();
      const hookStats = mcplHookManager.getStats();
      const brokerStats = mcplInferenceBroker.getStats();

      const result = {
        delegates,
        totalDelegates: stats.totalDelegates,
        mcplSessions: mcplStats.totalSessions,
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
  // get_server_status (regular tool — no context needed)
  // -------------------------------------------------------------------------
  toolRegistry.registerServerTool(
    'get_server_status',
    {
      name: 'get_server_status',
      description:
        'Get detailed status and capabilities for a specific delegate and its servers. ' +
        'Pass the delegateId to inspect.',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: {
            type: 'string',
            description: 'The delegate ID to inspect',
          },
        },
        required: ['delegateId'],
      },
    },
    async (input) => {
      const delegateId = input.delegateId as string;

      // Find all sessions for this delegate across all users
      const stats = delegateManager.getStats();
      const matches = stats.delegates.filter(d => d.delegateId === delegateId);

      if (matches.length === 0) {
        return {
          toolUseId: '',
          content: JSON.stringify({
            error: `Delegate "${delegateId}" not found`,
            availableDelegates: stats.delegates.map(d => d.delegateId),
          }),
          isError: true,
        };
      }

      const results = matches.map(match => {
        const full = delegateManager.findDelegate(match.userId, match.delegateId);
        const mcplSession = mcplSessionManager.getSessionForDelegate(match.userId, match.delegateId);

        // Group tools by server
        const serverTools: Record<string, string[]> = {};
        if (full) {
          for (const tool of full.tools) {
            const serverName = (tool as any).serverName || 'default';
            if (!serverTools[serverName]) serverTools[serverName] = [];
            serverTools[serverName].push(tool.name);
          }
        }

        return {
          delegateId: match.delegateId,
          userId: match.userId,
          connectedAt: match.connectedAt.toISOString(),
          toolCount: match.toolCount,
          capabilities: full?.capabilities || [],
          isMcpl: !!mcplSession,
          mcplCapabilities: mcplSession?.capabilities || [],
          featureSets: mcplSession?.featureSets || {},
          servers: serverTools,
        };
      });

      return {
        toolUseId: '',
        content: JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
        isError: false,
      };
    }
  );

  // -------------------------------------------------------------------------
  // enable_server (MCPL tool — receives userId + conversationId via context)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'enable_server',
    {
      name: 'enable_server',
      description:
        'Enable tools from a specific delegate for the current conversation. ' +
        'Re-includes the delegate\'s tools in the tool list. ' +
        'Supports wildcards: "memory.*" enables all delegates starting with "memory.".',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: {
            type: 'string',
            description: 'The delegate ID to enable (supports wildcards, e.g. "memory.*")',
          },
        },
        required: ['delegateId'],
      },
    },
    async (input, context) => {
      const delegateIdPattern = input.delegateId as string;
      const { userId, conversationId } = context;

      if (!conversationId) {
        return { toolUseId: '', content: 'No active conversation', isError: true };
      }

      // Resolve wildcard delegateId against known delegates
      const stats = delegateManager.getStats();
      const matchingDelegates = stats.delegates.filter(
        d => d.userId === userId && matchesPattern(delegateIdPattern, d.delegateId)
      );

      if (matchingDelegates.length === 0) {
        return {
          toolUseId: '',
          content: `No delegates matching "${delegateIdPattern}" are connected. Available: ${stats.delegates.filter(d => d.userId === userId).map(d => d.delegateId).join(', ') || 'none'}`,
          isError: true,
        };
      }

      let totalServers = 0;
      let totalTools = 0;
      const enabledDelegates: string[] = [];

      for (const match of matchingDelegates) {
        const delegate = delegateManager.findDelegate(userId, match.delegateId);
        if (!delegate) continue;

        // Collect serverIds for this delegate
        const serverIds = new Set<string>();
        for (const tool of delegate.tools) {
          const serverId = delegateManager.getOrCreateServerId(
            match.delegateId,
            (tool as any).serverName || '_default'
          );
          serverIds.add(serverId);
        }

        // Enable each server
        for (const serverId of serverIds) {
          await db.setServerEnabled(conversationId, serverId, match.delegateId, true, 'agent');
        }

        totalServers += serverIds.size;
        totalTools += delegate.tools.length;
        enabledDelegates.push(match.delegateId);
      }

      return {
        toolUseId: '',
        content: `Enabled ${enabledDelegates.length} delegate(s) matching "${delegateIdPattern}" for this conversation: ${enabledDelegates.join(', ')} (${totalServers} server(s), ${totalTools} tools).`,
        isError: false,
      };
    }
  );

  // -------------------------------------------------------------------------
  // disable_server (MCPL tool — receives userId + conversationId via context)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'disable_server',
    {
      name: 'disable_server',
      description:
        'Disable tools from a specific delegate for the current conversation. ' +
        'The delegate stays connected but its tools are excluded from tool lists. ' +
        'Supports wildcards: "memory.*" disables all delegates starting with "memory.".',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: {
            type: 'string',
            description: 'The delegate ID to disable (supports wildcards, e.g. "memory.*")',
          },
        },
        required: ['delegateId'],
      },
    },
    async (input, context) => {
      const delegateIdPattern = input.delegateId as string;
      const { userId, conversationId } = context;

      if (!conversationId) {
        return { toolUseId: '', content: 'No active conversation', isError: true };
      }

      // Resolve wildcard delegateId against known delegates
      const stats = delegateManager.getStats();
      const matchingDelegates = stats.delegates.filter(
        d => d.userId === userId && matchesPattern(delegateIdPattern, d.delegateId)
      );

      if (matchingDelegates.length === 0) {
        return {
          toolUseId: '',
          content: `No delegates matching "${delegateIdPattern}" are connected.`,
          isError: true,
        };
      }

      let totalServers = 0;
      let totalTools = 0;
      const disabledDelegates: string[] = [];

      for (const match of matchingDelegates) {
        const delegate = delegateManager.findDelegate(userId, match.delegateId);
        if (!delegate) continue;

        // Collect serverIds for this delegate
        const serverIds = new Set<string>();
        for (const tool of delegate.tools) {
          const serverId = delegateManager.getOrCreateServerId(
            match.delegateId,
            (tool as any).serverName || '_default'
          );
          serverIds.add(serverId);
        }

        // Disable each server
        for (const serverId of serverIds) {
          await db.setServerEnabled(conversationId, serverId, match.delegateId, false, 'agent');
        }

        totalServers += serverIds.size;
        totalTools += delegate.tools.length;
        disabledDelegates.push(match.delegateId);
      }

      return {
        toolUseId: '',
        content: `Disabled ${disabledDelegates.length} delegate(s) matching "${delegateIdPattern}" for this conversation: ${disabledDelegates.join(', ')} (${totalServers} server(s), ${totalTools} tools excluded).`,
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

  console.log('[McplManagementTools] Registered 5 management tools (2 regular, 3 MCPL)');
}
