/**
 * Tool Registry
 *
 * Central registry for all tools available in the system.
 * Manages both server-side tools and delegate-provided tools.
 *
 * Tool resolution order for a given userId:
 * 1. Server tools (available to all users)
 * 2. User's delegate tools (scoped by userId + delegateId)
 *
 * Delegate tool keys: `${userId}:${delegateId}:${toolName}`
 * Server tool keys: `server:${toolName}`
 */

import { Logger } from '../utils/logger.js';

// Membrane-compatible tool types (mirrored from membrane to avoid import dependency)
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  toolUseId: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ToolExecutor = (input: Record<string, unknown>) => Promise<ToolResult>;

interface RegisteredTool {
  definition: ToolDefinition;
  source: 'server' | 'delegate';
  delegateId?: string;
  userId?: string;
  execute: ToolExecutor;
}

class ToolRegistry {
  private serverTools: Map<string, RegisteredTool> = new Map();
  private delegateTools: Map<string, RegisteredTool> = new Map();

  /**
   * Register a server-side tool (available to all users).
   */
  registerServerTool(
    name: string,
    definition: ToolDefinition,
    executor: ToolExecutor
  ): void {
    const key = `server:${name}`;
    this.serverTools.set(key, {
      definition,
      source: 'server',
      execute: executor,
    });
    Logger.debug(`[ToolRegistry] Registered server tool: ${name}`);
  }

  /**
   * Register tools from a delegate (scoped to a user).
   */
  registerDelegateTools(
    userId: string,
    delegateId: string,
    tools: ToolDefinition[],
    executor: (name: string, input: Record<string, unknown>) => Promise<ToolResult>
  ): void {
    for (const tool of tools) {
      const key = `${userId}:${delegateId}:${tool.name}`;
      this.delegateTools.set(key, {
        definition: tool,
        source: 'delegate',
        delegateId,
        userId,
        execute: (input) => executor(tool.name, input),
      });
    }
    Logger.debug(`[ToolRegistry] Registered ${tools.length} delegate tools for user ${userId}, delegate ${delegateId}`);
  }

  /**
   * Unregister all tools from a specific delegate.
   */
  unregisterDelegateTools(userId: string, delegateId: string): void {
    const prefix = `${userId}:${delegateId}:`;
    let removed = 0;
    for (const key of this.delegateTools.keys()) {
      if (key.startsWith(prefix)) {
        this.delegateTools.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      Logger.debug(`[ToolRegistry] Unregistered ${removed} delegate tools for user ${userId}, delegate ${delegateId}`);
    }
  }

  /**
   * Get all tool definitions available to a user.
   * Returns server tools + user's delegate tools.
   */
  getToolsForUser(userId: string): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const seenNames = new Set<string>();

    // Server tools first
    for (const tool of this.serverTools.values()) {
      tools.push(tool.definition);
      seenNames.add(tool.definition.name);
    }

    // User's delegate tools (skip if name conflicts with server tool)
    const userPrefix = `${userId}:`;
    for (const [key, tool] of this.delegateTools) {
      if (key.startsWith(userPrefix)) {
        if (seenNames.has(tool.definition.name)) {
          // Conflict: delegate tool name matches server tool, skip
          Logger.debug(`[ToolRegistry] Skipping delegate tool "${tool.definition.name}" (conflicts with server tool)`);
          continue;
        }
        tools.push(tool.definition);
        seenNames.add(tool.definition.name);
      }
    }

    return tools;
  }

  /**
   * Check if any tools are available for a user.
   */
  hasToolsForUser(userId: string): boolean {
    if (this.serverTools.size > 0) return true;

    const userPrefix = `${userId}:`;
    for (const key of this.delegateTools.keys()) {
      if (key.startsWith(userPrefix)) return true;
    }

    return false;
  }

  /**
   * Execute a tool by name for a given user.
   * Looks up server tools first, then delegate tools.
   */
  async executeTool(
    name: string,
    input: Record<string, unknown>,
    userId: string
  ): Promise<ToolResult> {
    // Check server tools first
    const serverKey = `server:${name}`;
    const serverTool = this.serverTools.get(serverKey);
    if (serverTool) {
      try {
        Logger.debug(`[ToolRegistry] Executing server tool: ${name}`);
        return await serverTool.execute(input);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ToolRegistry] Server tool "${name}" failed:`, errorMsg);
        return { toolUseId: '', content: `Tool error: ${errorMsg}`, isError: true };
      }
    }

    // Check user's delegate tools
    const userPrefix = `${userId}:`;
    for (const [key, tool] of this.delegateTools) {
      if (key.startsWith(userPrefix) && tool.definition.name === name) {
        try {
          Logger.debug(`[ToolRegistry] Executing delegate tool: ${name} (delegate: ${tool.delegateId})`);
          return await tool.execute(input);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[ToolRegistry] Delegate tool "${name}" failed:`, errorMsg);
          return { toolUseId: '', content: `Tool error: ${errorMsg}`, isError: true };
        }
      }
    }

    // Tool not found
    console.warn(`[ToolRegistry] Tool not found: ${name} (user: ${userId})`);
    return { toolUseId: '', content: `Unknown tool: ${name}`, isError: true };
  }

  /**
   * Get delegate info for a tool (used for routing decisions).
   */
  getDelegateForTool(name: string, userId: string): { delegateId: string; userId: string } | null {
    const userPrefix = `${userId}:`;
    for (const [key, tool] of this.delegateTools) {
      if (key.startsWith(userPrefix) && tool.definition.name === name) {
        return { delegateId: tool.delegateId!, userId: tool.userId! };
      }
    }
    return null;
  }

  /**
   * Get registry stats for debugging.
   */
  getStats(): { serverTools: number; delegateTools: number; delegateToolsByUser: Record<string, number> } {
    const delegateToolsByUser: Record<string, number> = {};
    for (const [key] of this.delegateTools) {
      const userId = key.split(':')[0];
      delegateToolsByUser[userId] = (delegateToolsByUser[userId] || 0) + 1;
    }

    return {
      serverTools: this.serverTools.size,
      delegateTools: this.delegateTools.size,
      delegateToolsByUser,
    };
  }
}

export const toolRegistry = new ToolRegistry();
