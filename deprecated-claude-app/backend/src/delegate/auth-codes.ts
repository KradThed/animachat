// Pending authorization codes for delegate PKCE login flow.
// Single-instance only. For multi-instance: migrate to signed JWT or shared Redis store.

import crypto from 'crypto';

// =============================================================================
// Types
// =============================================================================

interface PendingCode {
  code: string;
  userId: string;
  delegateId: string;
  namespace: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
  createdAt: number;
  expiresAt: number;
}

// =============================================================================
// Store
// =============================================================================

const CODE_TTL_MS = 120_000; // 2 minutes
const CLEANUP_INTERVAL_MS = 30_000; // 30 seconds

const pendingCodes = new Map<string, PendingCode>();

// Periodic cleanup of expired codes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingCodes) {
    if (now > entry.expiresAt) {
      pendingCodes.delete(code);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupInterval.unref(); // Don't prevent process exit

// =============================================================================
// Rate Limiter for exchange endpoint
// =============================================================================

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateLimitByIp = new Map<string, { count: number; resetAt: number }>();

export function checkExchangeRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitByIp.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitByIp.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true; // allowed
  }

  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// =============================================================================
// redirect_uri Validator
// =============================================================================

/**
 * Validate a redirect_uri for the delegate PKCE flow.
 * Strict rules: http only, 127.0.0.1 only (not localhost — DNS rebinding risk),
 * port 1024-65535, path /callback exactly, no query/hash/userinfo.
 */
export function validateRedirectUri(uri: string): { valid: true; port: number } | { valid: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Must use http (not https)' };
  }
  if (parsed.hostname !== '127.0.0.1') {
    return { valid: false, reason: 'Host must be 127.0.0.1' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'No userinfo allowed' };
  }

  const port = parseInt(parsed.port, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    return { valid: false, reason: 'Port must be 1024-65535' };
  }

  if (parsed.pathname !== '/callback') {
    return { valid: false, reason: 'Path must be /callback' };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, reason: 'No query string or hash allowed' };
  }

  return { valid: true, port };
}

// =============================================================================
// Auth Code Operations
// =============================================================================

/**
 * Create a pending authorization code.
 * Returns the generated code string.
 */
export function createAuthCode(
  userId: string,
  delegateId: string,
  namespace: string,
  codeChallenge: string,
  redirectUri: string,
  state: string,
): string {
  const code = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();

  pendingCodes.set(code, {
    code,
    userId,
    delegateId,
    namespace,
    codeChallenge,
    redirectUri,
    state,
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
  });

  return code;
}

/**
 * Consume a pending authorization code with PKCE verification.
 * Returns the pending code data if valid, null otherwise.
 * Single-use: code is deleted from the map on consumption.
 */
export function consumeAuthCode(
  code: string,
  codeVerifier: string,
): PendingCode | null {
  const entry = pendingCodes.get(code);
  if (!entry) return null;

  // Always delete to prevent reuse (even if verification fails)
  pendingCodes.delete(code);

  // Check expiration
  if (Date.now() > entry.expiresAt) return null;

  // PKCE: verify SHA256(code_verifier) === stored code_challenge
  const computedChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  if (computedChallenge !== entry.codeChallenge) return null;

  return entry;
}
