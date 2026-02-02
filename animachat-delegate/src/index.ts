#!/usr/bin/env node
/**
 * Animachat Delegate CLI
 *
 * Standalone app that connects to an Animachat server, hosts MCP servers
 * locally for remote tool execution, and optionally serves webhook endpoints
 * for external event triggers (MCP Live).
 *
 * Usage:
 *   animachat-delegate --config delegate.yaml
 *   animachat-delegate --server wss://animachat.example.com --token $TOKEN
 */

import { Command } from 'commander';
import { findConfigPath, loadConfig } from './config.js';
import { DelegateConnection } from './connection.js';
import { McpHostManager } from './mcp-host.js';
import { WebhookServer } from './webhook-server.js';
import type { ToolCallRequest } from './types.js';

// =============================================================================
// CLI
// =============================================================================

const program = new Command()
  .name('animachat-delegate')
  .description('Animachat delegate - remote tool execution and MCP hosting')
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to config YAML file')
  .option('-s, --server <url>', 'Server WebSocket URL (overrides config)')
  .option('-t, --token <token>', 'Auth token (overrides config)')
  .option('-d, --delegate-id <id>', 'Delegate ID (overrides config)')
  .parse();

const opts = program.opts();

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Load config
  const configPath = findConfigPath(opts.config);
  console.log(`[Delegate] Loading config from ${configPath}`);
  const config = loadConfig(configPath);

  // CLI overrides
  if (opts.server) config.server.url = opts.server;
  if (opts.token) config.server.token = opts.token;
  if (opts.delegateId) config.delegate.id = opts.delegateId;

  console.log(`[Delegate] ID: ${config.delegate.id}`);
  console.log(`[Delegate] Server: ${config.server.url}`);
  console.log(`[Delegate] MCP servers: ${config.mcp_servers.length}`);
  console.log(`[Delegate] Webhooks: ${config.webhooks.enabled ? `enabled (port ${config.webhooks.port})` : 'disabled'}`);

  // ---- MCP Host Manager ----
  const mcpHost = new McpHostManager();
  await mcpHost.startAll(config.mcp_servers);
  const tools = mcpHost.getAllTools();
  console.log(`[Delegate] Tools available: ${tools.map(t => t.name).join(', ') || '(none)'}`);

  // ---- WebSocket Connection ----
  const connection = new DelegateConnection({
    serverUrl: config.server.url,
    token: config.server.token,
    delegateId: config.delegate.id,
    capabilities: config.delegate.capabilities,
  });

  // Send tool manifest on connect (and reconnect)
  connection.on('connected', (_sessionId: string, _userId: string) => {
    const currentTools = mcpHost.getAllTools();
    if (currentTools.length > 0) {
      connection.sendToolManifest(currentTools);
    } else {
      console.log('[Delegate] No tools to advertise');
    }
  });

  // Handle tool call requests from the server
  connection.on('tool_call_request', async (request: ToolCallRequest) => {
    console.log(`[Delegate] Tool call: ${request.tool.name} (request: ${request.requestId})`);

    const result = await mcpHost.callTool(request.tool.name, request.tool.input);

    connection.sendToolCallResponse(
      request.requestId,
      request.tool.id,
      result.content,
      result.isError
    );

    console.log(
      `[Delegate] Tool result sent: ${request.tool.name} ` +
      `(${result.isError ? 'error' : 'ok'}, ${result.content.length} chars)`
    );
  });

  connection.on('error', (error: Error) => {
    console.error('[Delegate] Connection error:', error.message);
  });

  connection.on('reconnecting', (attempt: number) => {
    console.log(`[Delegate] Reconnecting (attempt ${attempt})...`);
  });

  connection.on('disconnected', (_code: number, reason: string) => {
    console.log(`[Delegate] Disconnected: ${reason}`);
  });

  // Connect to server
  await connection.connect();

  // ---- Webhook Server ----
  let webhookServer: WebhookServer | null = null;
  if (config.webhooks.enabled && config.webhooks.endpoints.length > 0) {
    webhookServer = new WebhookServer(connection);
    webhookServer.start(config.webhooks.port, config.webhooks.endpoints);
  }

  // ---- Graceful Shutdown ----
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[Delegate] ${signal} received, shutting down...`);

    webhookServer?.stop();
    connection.disconnect();
    await mcpHost.stopAll();

    console.log('[Delegate] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[Delegate] Running. Press Ctrl+C to stop.');
}

// =============================================================================
// Entry
// =============================================================================

main().catch((error) => {
  console.error('[Delegate] Fatal error:', error);
  process.exit(1);
});
