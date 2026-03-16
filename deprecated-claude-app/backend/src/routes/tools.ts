/**
 * Tools API Routes
 *
 * Provides endpoints for:
 * - GET /api/tools - List all available tools for the authenticated user
 * - GET /api/tools/delegates - List connected delegates for the authenticated user
 * - GET /api/tools/delegate-feature-sets - Feature sets grouped by delegate (with conversation state)
 * - GET /api/tools/visible - Tools visible in a conversation (filtered by feature set policy)
 * - POST /api/tools/feature-sets/enable - Enable a feature set for a conversation
 * - POST /api/tools/feature-sets/disable - Disable a feature set for a conversation
 * - GET /api/tools/api-keys - List delegate API keys for the authenticated user
 * - POST /api/tools/api-keys - Create a new delegate API key
 * - DELETE /api/tools/api-keys/:keyId - Revoke a delegate API key
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { toolRegistry, ToolRegistry } from '../tools/tool-registry.js';
import { delegateManager, DelegateManager } from '../delegate/delegate-manager.js';
import { mcplSessionManager } from '../delegate/mcpl-session-manager.js';
import { roomManager } from '../websocket/room-manager.js';
import { Database } from '../database/index.js';
import { buildFeatureSetPredicate } from '../utils/feature-set-predicate.js';

// Extend Express Request to include userId from auth middleware
interface AuthRequest extends Request {
  userId?: string;
}

interface ToolsRouterDeps {
  toolRegistry?: ToolRegistry;
  delegateManager?: DelegateManager;
  db?: Database;
}

// Schema for creating API keys
const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().datetime().nullable().optional(),
});

export function toolsRouter(deps: ToolsRouterDeps = {}): Router {
  const registry = deps.toolRegistry ?? toolRegistry;
  const delegates = deps.delegateManager ?? delegateManager;
  // db will be injected from index.ts
  const db = deps.db;
  const router = Router();

  /**
   * GET /api/tools
   * Returns all available tools for the authenticated user (with source info)
   */
  router.get('/', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const tools = registry.getToolsForUserWithSource(req.userId);
    res.json({ tools });
  });

  /**
   * GET /api/tools/delegates
   * Returns connected delegates for the authenticated user
   */
  router.get('/delegates', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userDelegates = delegates.getDelegatesForUser(req.userId);
    res.json({
      delegates: userDelegates.map(d => ({
        delegateId: d.delegateId,
        userId: d.userId,
        tools: d.tools,
        connectedAt: d.connectedAt.toISOString(),
        capabilities: {
          managedInstall: d.capabilities.includes('managedInstall'),
          canFileAccess: d.capabilities.includes('canFileAccess'),
          canShellAccess: d.capabilities.includes('canShellAccess'),
        },
      }))
    });
  });

  // =============================================================================
  // Delegate API Keys
  // =============================================================================

  /**
   * GET /api/tools/api-keys
   * Returns all delegate API keys for the authenticated user
   */
  router.get('/api-keys', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const keys = db.getDelegateApiKeys(req.userId);
    res.json({ keys });
  });

  /**
   * POST /api/tools/api-keys
   * Create a new delegate API key
   * Returns the full secret key only once on creation
   */
  router.post('/api-keys', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Validate request body
    const parsed = CreateApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    const { name, expiresAt } = parsed.data;
    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;

    try {
      const result = await db.createDelegateApiKey(req.userId, name, expiresAtDate);

      // Return the key info + secret (only time secret is returned!)
      res.status(201).json({
        key: result.key,
        secretKey: result.secretKey,
        warning: 'Save this key securely! It will not be shown again.',
      });
    } catch (error) {
      console.error('[tools/api-keys] Failed to create API key:', error);
      res.status(500).json({ error: 'Failed to create API key' });
    }
  });

  /**
   * DELETE /api/tools/api-keys/:keyId
   * Revoke a delegate API key
   */
  router.delete('/api-keys/:keyId', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { keyId } = req.params;

    try {
      const success = await db.revokeDelegateApiKey(req.userId, keyId);

      if (!success) {
        return res.status(404).json({ error: 'API key not found' });
      }

      res.json({ success: true, message: 'API key revoked' });
    } catch (error) {
      console.error('[tools/api-keys] Failed to revoke API key:', error);
      res.status(500).json({ error: 'Failed to revoke API key' });
    }
  });

  // =============================================================================
  // Feature Set API
  // =============================================================================

  /**
   * GET /api/tools/delegate-feature-sets?conversationId=...
   * Groups feature sets by delegate. Two-layer enabled state when conversationId provided.
   */
  router.get('/delegate-feature-sets', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const conversationId = req.query.conversationId as string | undefined;

    // Validate conversation access if provided
    if (conversationId) {
      const conversation = await db.getConversation(conversationId, req.userId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
    }

    const entries = mcplSessionManager.getFeatureSetEntriesForUser(req.userId);
    const delegateMap = new Map<string, any[]>();

    for (const entry of entries) {
      const session = mcplSessionManager.getSessionForDelegate(req.userId, entry.delegateId);
      if (!session) continue;

      const decl = session.declaredFeatureSets[entry.featureSet];
      if (!decl) continue;

      const runtimeEnabled = mcplSessionManager.isFeatureSetEffectivelyEnabled(session.sessionId, entry.featureSet);
      const quarantined = session.invalidFeatureSets.has(entry.featureSet);

      // Tool counts
      const allTools = registry.getToolsForUserWithSource(req.userId);
      const totalToolCount = allTools.filter(
        t => t.source === 'delegate' && t.delegateId === entry.delegateId && t.featureSet === entry.featureSet
      ).length;

      const featureSetInfo: any = {
        name: entry.featureSet,
        description: decl.description,
        uses: decl.rawUses,
        runtimeEnabled,
        quarantined,
        totalToolCount,
      };

      if (conversationId) {
        const conversationEnabled = db.isFeatureSetEnabled(conversationId, entry.delegateId, entry.featureSet);
        featureSetInfo.conversationEnabled = conversationEnabled;
        featureSetInfo.visible = runtimeEnabled && conversationEnabled;

        // Visible tool count (with conversation filter)
        const isEnabled = buildFeatureSetPredicate(req.userId!, conversationId, db);
        const visibleTools = registry.getToolsForUserWithSource(req.userId, isEnabled);
        featureSetInfo.visibleToolCount = visibleTools.filter(
          t => t.source === 'delegate' && t.delegateId === entry.delegateId && t.featureSet === entry.featureSet
        ).length;
      }

      if (!delegateMap.has(entry.delegateId)) {
        delegateMap.set(entry.delegateId, []);
      }
      delegateMap.get(entry.delegateId)!.push(featureSetInfo);
    }

    const result = Array.from(delegateMap.entries()).map(([delegateId, featureSets]) => ({
      delegateId,
      featureSets,
    }));

    res.json({ delegates: result });
  });

  /**
   * GET /api/tools/visible?conversationId=...
   * Returns tools visible to the user, optionally filtered by conversation feature set policy.
   */
  router.get('/visible', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const conversationId = req.query.conversationId as string | undefined;

    // Validate conversation access if provided
    if (conversationId) {
      const conversation = await db.getConversation(conversationId, req.userId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
    }

    const isEnabled = conversationId
      ? buildFeatureSetPredicate(req.userId!, conversationId, db)
      : undefined;
    const tools = registry.getToolsForUserWithSource(req.userId, isEnabled);
    res.json({ tools });
  });

  /**
   * POST /api/tools/feature-sets/enable
   * Enable a feature set for a conversation.
   */
  router.post('/feature-sets/enable', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { delegateId, featureSet, conversationId } = req.body;
    if (!delegateId || !featureSet || !conversationId) {
      return res.status(400).json({ error: 'delegateId, featureSet, and conversationId are required' });
    }

    // Validate conversation access + ownership
    const conversation = await db.getConversation(conversationId, req.userId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.userId !== req.userId) {
      return res.status(403).json({ error: 'Not the conversation owner' });
    }

    // Validate delegate ownership
    const delegate = delegates.findDelegate(req.userId, delegateId);
    if (!delegate) {
      return res.status(404).json({ error: `Delegate "${delegateId}" not found` });
    }

    // Validate feature set existence
    const declaredNames = mcplSessionManager.getFeatureSetNamesForDelegate(req.userId, delegateId);
    if (!declaredNames.includes(featureSet)) {
      return res.status(404).json({ error: `Feature set "${featureSet}" not found on delegate "${delegateId}"` });
    }

    // 1. Source of truth — toggle state
    await db.setFeatureSetEnabled(conversationId, delegateId, featureSet, true, 'user');

    // 2. Broadcast to conversation room
    roomManager.broadcastToRoom(conversationId, {
      type: 'mcpl/conversation_feature_sets_changed',
      conversationId,
      delegateId,
      changedFeatureSets: [featureSet],
      timestamp: Date.now(),
    });

    // 3. Best-effort toolset history
    db.recordToolsetChangedForConversation(conversationId, req.userId, delegateId, registry)
      .catch(err => console.warn('[tools/feature-sets/enable] toolset_changed failed:', err));

    res.json({ success: true });
  });

  /**
   * POST /api/tools/feature-sets/disable
   * Disable a feature set for a conversation.
   */
  router.post('/feature-sets/disable', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { delegateId, featureSet, conversationId } = req.body;
    if (!delegateId || !featureSet || !conversationId) {
      return res.status(400).json({ error: 'delegateId, featureSet, and conversationId are required' });
    }

    // Validate conversation access + ownership
    const conversation = await db.getConversation(conversationId, req.userId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.userId !== req.userId) {
      return res.status(403).json({ error: 'Not the conversation owner' });
    }

    // Validate delegate ownership
    const delegate = delegates.findDelegate(req.userId, delegateId);
    if (!delegate) {
      return res.status(404).json({ error: `Delegate "${delegateId}" not found` });
    }

    // Validate feature set existence
    const declaredNames = mcplSessionManager.getFeatureSetNamesForDelegate(req.userId, delegateId);
    if (!declaredNames.includes(featureSet)) {
      return res.status(404).json({ error: `Feature set "${featureSet}" not found on delegate "${delegateId}"` });
    }

    // 1. Source of truth — toggle state
    await db.setFeatureSetEnabled(conversationId, delegateId, featureSet, false, 'user');

    // 2. Broadcast to conversation room
    roomManager.broadcastToRoom(conversationId, {
      type: 'mcpl/conversation_feature_sets_changed',
      conversationId,
      delegateId,
      changedFeatureSets: [featureSet],
      timestamp: Date.now(),
    });

    // 3. Best-effort toolset history
    db.recordToolsetChangedForConversation(conversationId, req.userId, delegateId, registry)
      .catch(err => console.warn('[tools/feature-sets/disable] toolset_changed failed:', err));

    res.json({ success: true });
  });

  /**
   * POST /api/tools/test
   * Test a tool with empty input. 10s timeout.
   */
  router.post('/test', async (req: AuthRequest, res: Response) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { toolName } = req.body;
    if (!toolName || typeof toolName !== 'string') {
      return res.status(400).json({ error: 'toolName required' });
    }

    try {
      const result = await registry.executeTool(
        { id: `test-${Date.now()}`, name: toolName, input: {} },
        req.userId,
        { toolsEnabled: true, enabledTools: null, toolTimeout: 10_000 },
      );
      res.json({
        success: !result.isError,
        content: (typeof result.content === 'string'
          ? result.content : JSON.stringify(result.content)
        ).slice(0, 2000),
      });
    } catch (err: any) {
      res.json({ success: false, content: err.message || 'Unknown error' });
    }
  });

  return router;
}
