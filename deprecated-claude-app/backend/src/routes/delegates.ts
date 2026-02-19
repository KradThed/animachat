/**
 * Delegates API Routes
 *
 * Authorization endpoints (PKCE flow):
 * - POST /api/delegates/authorize/confirm - Confirm authorization, create delegate + auth code
 * - POST /api/delegates/exchange          - Exchange auth code + PKCE verifier for API key (no auth)
 *
 * CRUD endpoints:
 * - GET    /api/delegates                 - List user's delegates with keys + connection status
 * - POST   /api/delegates                 - Create delegate entity manually
 * - POST   /api/delegates/:id/keys        - Create new key for delegate
 * - DELETE /api/delegates/keys/:keyId     - Revoke a delegate entity key
 * - DELETE /api/delegates/:id             - Soft-delete delegate
 *
 * CSRF safe: authorize page is SPA (not server-rendered form), all POSTs use fetch() with Bearer token
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { Database } from '../database/index.js';
import { delegateManager } from '../delegate/delegate-manager.js';
import {
  createAuthCode,
  consumeAuthCode,
  validateRedirectUri,
  checkExchangeRateLimit,
} from '../delegate/auth-codes.js';

// =============================================================================
// Schemas
// =============================================================================

const NAMESPACE_REGEX = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

const AuthorizeConfirmSchema = z.object({
  namespace: z.string().regex(NAMESPACE_REGEX, 'Namespace must be 2-40 chars: lowercase alphanumeric and hyphens'),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  state: z.string().min(1),
});

const ExchangeSchema = z.object({
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
});

const CreateDelegateSchema = z.object({
  namespace: z.string().regex(NAMESPACE_REGEX, 'Namespace must be 2-40 chars: lowercase alphanumeric and hyphens'),
});

// =============================================================================
// Router
// =============================================================================

export function delegatesRouter(db: Database): Router {
  const router = Router();

  // --------------------------------------------------------------------------
  // POST /authorize/confirm — Create delegate + auth code (JWT auth required)
  // --------------------------------------------------------------------------
  router.post('/authorize/confirm', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = AuthorizeConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    const { namespace, redirect_uri, code_challenge, state } = parsed.data;

    // Validate redirect_uri
    const uriResult = validateRedirectUri(redirect_uri);
    if (!uriResult.valid) {
      return res.status(400).json({ error: `Invalid redirect_uri: ${uriResult.reason}` });
    }

    // Find or create delegate
    const result = await db.findOrCreateDelegate(req.userId, namespace);
    if ('error' in result) {
      return res.status(409).json({ error: result.error });
    }

    // Create auth code
    const code = createAuthCode(
      req.userId,
      result.delegate.id,
      namespace,
      code_challenge,
      redirect_uri,
      state,
    );

    // Return redirect URL for frontend to navigate to
    const redirectUrl = `${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    res.json({ redirectUrl });
  });

  // --------------------------------------------------------------------------
  // POST /exchange — Exchange auth code for API key (NO auth — PKCE is the auth)
  // --------------------------------------------------------------------------
  router.post('/exchange', async (req: Request, res: Response) => {
    // Rate limit by IP
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkExchangeRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }

    const parsed = ExchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    const { code, code_verifier } = parsed.data;

    // Consume auth code with PKCE verification
    const pending = consumeAuthCode(code, code_verifier);
    if (!pending) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    // Create API key for delegate
    const keyResult = await db.createKeyForDelegate(pending.delegateId);
    if (!keyResult) {
      return res.status(500).json({ error: 'Failed to create API key' });
    }

    res.json({
      api_key: keyResult.secretKey,
      namespace: pending.namespace,
    });
  });

  // --------------------------------------------------------------------------
  // GET / — List user's delegates with keys + connection status
  // --------------------------------------------------------------------------
  router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const delegates = db.getDelegatesForUser(req.userId);
    const connectedDelegates = delegateManager.getDelegatesForUser(req.userId);

    const result = delegates.map(del => {
      // Check if this delegate is currently connected
      const connected = connectedDelegates.find(cd => cd.delegateId === del.namespace);
      const keys = db.getKeysForDelegate(del.id);

      return {
        id: del.id,
        namespace: del.namespace,
        createdAt: del.createdAt.toISOString(),
        lastSeenAt: del.lastSeenAt?.toISOString() || null,
        isConnected: !!connected,
        toolCount: connected?.tools?.length ?? 0,
        keys: keys.map(k => ({
          id: k.id,
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt.toISOString(),
        })),
      };
    });

    res.json({ delegates: result });
  });

  // --------------------------------------------------------------------------
  // POST / — Create delegate entity manually
  // --------------------------------------------------------------------------
  router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = CreateDelegateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    const result = await db.findOrCreateDelegate(req.userId, parsed.data.namespace);
    if ('error' in result) {
      return res.status(409).json({ error: result.error });
    }

    res.status(201).json({
      id: result.delegate.id,
      namespace: result.delegate.namespace,
      created: result.created,
    });
  });

  // --------------------------------------------------------------------------
  // POST /:id/keys — Create new key for delegate
  // --------------------------------------------------------------------------
  router.post('/:id/keys', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const delegateId = req.params.id;

    // Verify user owns this delegate
    const delegates = db.getDelegatesForUser(req.userId);
    const delegate = delegates.find(d => d.id === delegateId);
    if (!delegate) {
      return res.status(404).json({ error: 'Delegate not found' });
    }

    const keyResult = await db.createKeyForDelegate(delegateId);
    if (!keyResult) {
      return res.status(500).json({ error: 'Failed to create key' });
    }

    res.status(201).json({
      keyId: keyResult.keyId,
      keyPrefix: keyResult.keyPrefix,
      secretKey: keyResult.secretKey,
      warning: 'Save this key securely! It will not be shown again.',
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /keys/:keyId — Revoke a delegate entity key
  // --------------------------------------------------------------------------
  router.delete('/keys/:keyId', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const keyId = req.params.keyId;

    // Verify user owns a delegate that owns this key
    const delegates = db.getDelegatesForUser(req.userId);
    let found = false;
    for (const del of delegates) {
      const keys = db.getKeysForDelegate(del.id);
      if (keys.find(k => k.id === keyId)) {
        found = true;
        break;
      }
    }

    if (!found) {
      return res.status(404).json({ error: 'Key not found' });
    }

    const revoked = await db.revokeDelegateEntityKey(keyId);
    if (!revoked) {
      return res.status(404).json({ error: 'Key not found or already revoked' });
    }

    res.json({ success: true });
  });

  // --------------------------------------------------------------------------
  // DELETE /:id — Soft-delete delegate
  // --------------------------------------------------------------------------
  router.delete('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const delegateId = req.params.id;

    // Verify user owns this delegate
    const delegates = db.getDelegatesForUser(req.userId);
    const delegate = delegates.find(d => d.id === delegateId);
    if (!delegate) {
      return res.status(404).json({ error: 'Delegate not found' });
    }

    const deleted = await db.softDeleteDelegate(delegateId);
    if (!deleted) {
      return res.status(404).json({ error: 'Delegate not found or already deleted' });
    }

    res.json({ success: true });
  });

  return router;
}
