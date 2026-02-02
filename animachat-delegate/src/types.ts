/**
 * Shared types for the delegate app.
 * Mirrors the server-side protocol types.
 */

import { z } from 'zod';

// =============================================================================
// Tool Definition
// =============================================================================

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// =============================================================================
// Server → Delegate Messages
// =============================================================================

export const DelegateAuthResultSchema = z.object({
  type: z.literal('delegate_auth_result'),
  success: z.boolean(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
});

export const ToolCallRequestSchema = z.object({
  type: z.literal('tool_call_request'),
  requestId: z.string(),
  conversationId: z.string(),
  messageId: z.string().optional(),
  tool: z.object({
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
  timeout: z.number().default(30000),
});

export const TriggerInferenceResultSchema = z.object({
  type: z.literal('trigger_inference_result'),
  triggerId: z.string(),
  success: z.boolean(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  response: z.string().optional(),
  error: z.string().optional(),
});

export const PongSchema = z.object({
  type: z.literal('pong'),
  timestamp: z.number(),
});

export const ToolManifestAckSchema = z.object({
  type: z.literal('tool_manifest_ack'),
  toolCount: z.number(),
  tools: z.array(z.string()),
});

/** All messages the server can send to us */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  DelegateAuthResultSchema,
  ToolCallRequestSchema,
  TriggerInferenceResultSchema,
  PongSchema,
  ToolManifestAckSchema,
]);

export type DelegateAuthResult = z.infer<typeof DelegateAuthResultSchema>;
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
export type TriggerInferenceResult = z.infer<typeof TriggerInferenceResultSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// =============================================================================
// Config Schema
// =============================================================================

export const McpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
});

export const WebhookEndpointSchema = z.object({
  source: z.string(),
  path: z.string(),
  secret: z.string().optional(),
  conversation_id: z.string().optional(),
  participant_id: z.string().optional(),
});

export const DelegateConfigSchema = z.object({
  server: z.object({
    url: z.string(),
    token: z.string(),
  }),
  delegate: z.object({
    id: z.string(),
    capabilities: z.array(z.string()).default(['mcp_host']),
  }),
  mcp_servers: z.array(McpServerConfigSchema).default([]),
  webhooks: z.object({
    enabled: z.boolean().default(false),
    port: z.number().default(8080),
    endpoints: z.array(WebhookEndpointSchema).default([]),
  }).default({ enabled: false, port: 8080, endpoints: [] }),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;
export type DelegateConfig = z.infer<typeof DelegateConfigSchema>;
