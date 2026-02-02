/**
 * MCP Host Manager
 *
 * Spawns and manages MCP server subprocesses via stdio transport.
 * Collects tool definitions from all servers and routes tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig, ToolDefinition } from './types.js';

// =============================================================================
// Types
// =============================================================================

interface McpServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDefinition[];
}

// =============================================================================
// McpHostManager
// =============================================================================

export class McpHostManager {
  private servers: Map<string, McpServer> = new Map();
  private toolToServer: Map<string, string> = new Map();

  /**
   * Spawn all configured MCP servers and collect their tools.
   * Individual server failures are logged but don't prevent others from starting.
   */
  async startAll(configs: McpServerConfig[]): Promise<void> {
    if (configs.length === 0) {
      console.log('[McpHost] No MCP servers configured');
      return;
    }

    console.log(`[McpHost] Starting ${configs.length} MCP server(s)...`);

    const results = await Promise.allSettled(
      configs.map(config => this.spawnServer(config))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const config = configs[i];
      if (result.status === 'rejected') {
        console.error(`[McpHost] Failed to start "${config.name}":`, result.reason);
      }
    }

    const started = [...this.servers.values()];
    const totalTools = started.reduce((sum, s) => sum + s.tools.length, 0);
    console.log(
      `[McpHost] ${started.length}/${configs.length} servers started, ${totalTools} tools available`
    );
  }

  /**
   * Stop all running MCP servers gracefully.
   */
  async stopAll(): Promise<void> {
    if (this.servers.size === 0) return;

    console.log(`[McpHost] Stopping ${this.servers.size} MCP server(s)...`);

    const results = await Promise.allSettled(
      [...this.servers.values()].map(async (server) => {
        try {
          await server.client.close();
          console.log(`[McpHost] Stopped "${server.name}"`);
        } catch (error) {
          console.warn(`[McpHost] Error stopping "${server.name}":`, error);
        }
      })
    );

    this.servers.clear();
    this.toolToServer.clear();
  }

  /**
   * Get all tools aggregated from all running MCP servers.
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      tools.push(...server.tools);
    }
    return tools;
  }

  /**
   * Call a tool by name, routing to the correct MCP server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    const serverName = this.toolToServer.get(name);
    if (!serverName) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return { content: `MCP server "${serverName}" is not running`, isError: true };
    }

    try {
      const result = await server.client.callTool({ name, arguments: args });

      // Extract text content from the result
      const textParts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            textParts.push('[image]');
          } else if (block.type === 'resource') {
            textParts.push(`[resource: ${(block as any).uri || 'unknown'}]`);
          }
        }
      }

      return {
        content: textParts.join('\n') || '(empty result)',
        isError: result.isError === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[McpHost] Tool call "${name}" failed:`, message);
      return { content: `Tool execution error: ${message}`, isError: true };
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async spawnServer(config: McpServerConfig): Promise<void> {
    console.log(`[McpHost] Starting "${config.name}" (${config.command} ${config.args.join(' ')})...`);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    });

    const client = new Client(
      { name: `animachat-delegate:${config.name}`, version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    const server: McpServer = {
      name: config.name,
      client,
      transport,
      tools: [],
    };

    // Collect tools
    await this.collectTools(server);

    this.servers.set(config.name, server);
    console.log(`[McpHost] "${config.name}" started with ${server.tools.length} tools`);
  }

  private async collectTools(server: McpServer): Promise<void> {
    const result = await server.client.listTools();

    server.tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: {
        type: 'object' as const,
        properties: (tool.inputSchema as any)?.properties ?? {},
        required: (tool.inputSchema as any)?.required,
      },
    }));

    // Build tool → server mapping
    for (const tool of server.tools) {
      if (this.toolToServer.has(tool.name)) {
        console.warn(
          `[McpHost] Tool name conflict: "${tool.name}" from "${server.name}" ` +
          `shadows existing tool from "${this.toolToServer.get(tool.name)}"`
        );
      }
      this.toolToServer.set(tool.name, server.name);
    }
  }
}
