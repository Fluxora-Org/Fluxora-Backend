import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { errorResponse } from '../utils/response.js';
import { ApiErrorCode } from './errorHandler.js';
import { getApiKeyFromRequest } from '../lib/apiKey.js';
import { warn } from '../utils/logger.js';

/** Cookie name used to deliver the double-submit CSRF token to browser clients. */
export const CSRF_COOKIE_NAME = 'fluxora_csrf';

/** Header name expected on mutating browser-originated requests containing the CSRF token. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Fixed HMAC key used for constant-time CSRF token comparison.
 * Matches the pattern in `src/webhooks/signature.ts` where both inputs are
 * HMAC-hashed before comparison to eliminate timing side-channels from
 * variable-length inputs.
 */
const CSRF_COMPARE_KEY = 'fluxora-csrf-compare';

/**
 * Helper function to parse raw Cookie header string into a record of key-value pairs.
 * Decodes URI components and handles multi-cookie headers safely.
 *
 * @param cookieHeader - Raw Cookie header from Request
 * @returns Record of parsed cookie key-value pairs
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (key) {
        try {
          cookies[key] = decodeURIComponent(value);
        } catch {
          cookies[key] = value;
        }
      }
    }
  }
  return cookies;
}

/**
 * Determines whether an incoming HTTP request is authenticated via a browser cookie session.
 *
 * Security Requirement:
 * Double-Submit CSRF checks must apply ONLY to cookie-session-authenticated requests
 * (e.g. dashboard web clients). API-key (`X-API-Key`) or Bearer token (`Authorization: Bearer ...`)
 * requests do not use ambient browser cookies and MUST NOT be subjected to CSRF checks.
 *
 * Evaluation Rules:
 * 1. If the request includes a non-blank Authorization header (e.g., `Bearer <jwt>`),
 *    the request is API-authenticated → return false.
 * 2. If the request includes an `X-API-Key` **header**, return false.
 * 3. If the request includes an `x-api-key` **query parameter**, return false.
 * 4. If the request carries at least one cookie in `req.headers.cookie`, return true.
 * 5. Otherwise return false (no credential, no cookie = unauthenticated entirely).
 *
 * Note on rule 1: an Authorization header that is present but consists only of
 * whitespace is treated as absent, so such requests are not bypassed by this rule
 * and continue to rules 2-5.
 *
 * @param req - Express Request object
 * @returns boolean indicating if request is cookie-session authenticated
 */
export function isCookieAuthenticated(req: Request): boolean {
  // Rule 1 — Bearer / Authorization header (non-blank)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.trim().length > 0) {
    return false;
  }

  // Rule 2 — API Key in request headers (e.g. X-API-Key: flx_...)
  const apiKeyFromHeader = getApiKeyFromRequest(req.headers);
  if (apiKeyFromHeader) {
    return false;
  }

  // Rule 3 — API Key supplied as a query parameter (?x-api-key=flx_...)
  // req.query values are strings or string arrays after Express URL parsing.
  const queryApiKey = req.query?.['x-api-key'];
  const normalizedQueryKey = Array.isArray(queryApiKey) ? queryApiKey[0] : queryApiKey;
  if (normalizedQueryKey && typeof normalizedQueryKey === 'string' && normalizedQueryKey.trim().length > 0) {
    return false;
  }

  // Rule 4 — Presence of at least one cookie → treat as browser/cookie-session request
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || cookieHeader.trim().length === 0) {
    return false;
  }

  return true;
}

/**
 * Compares two CSRF token strings in constant time to protect against timing attacks.
 * Both inputs are HMAC-SHA256-hashed before comparison using `crypto.timingSafeEqual`,
 * matching the constant-time verification pattern used in `src/webhooks/signature.ts`.
 * This eliminates timing side-channels from variable-length inputs.
 *
 * @param tokenA - First CSRF token string (e.g. from cookie)
 * @param tokenB - Second CSRF token string (e.g. from header)
 * @returns true if tokens are identical in constant time, false otherwise
 */
export function safeCompareCsrfTokens(tokenA?: string, tokenB?: string): boolean {
  if (!tokenA || !tokenB) return false;
  const hashA = createHmac('sha256', CSRF_COMPARE_KEY).update(tokenA).digest('hex');
  const hashB = createHmac('sha256', CSRF_COMPARE_KEY).update(tokenB).digest('hex');
  return timingSafeEqual(Buffer.from(hashA, 'utf8'), Buffer.from(hashB, 'utf8'));
}

/**
 * Generates a cryptographically strong random CSRF token string (32 random bytes, hex encoded).
 *
 * @returns Hex-encoded random CSRF token string
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Sets the double-submit CSRF cookie on an Express response object.
 *
 * @param res - Express Response object
 * @param token - CSRF token string
 * @param options - Cookie options overrides
 */
export function setCsrfCookie(
  res: Response,
  token: string,
  options: { sameSite?: 'strict' | 'lax' | 'none'; secure?: boolean; path?: string } = {},
): void {
  const { sameSite = 'lax', secure = false, path = '/' } = options;
  const cookieParts = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];
  if (secure) {
    cookieParts.push('Secure');
  }
  res.append('Set-Cookie', cookieParts.join('; '));
}

/**
 * Express middleware enforcing Double-Submit CSRF Cookie protection for browser-originated mutating requests.
 *
 * Enforcement Rules:
 * - Safe HTTP methods (GET, HEAD, OPTIONS) bypass CSRF checks.
 * - Non-cookie-authenticated requests (Bearer JWT or API Key) bypass CSRF checks.
 * - Cookie-authenticated mutating requests (POST, PUT, PATCH, DELETE) MUST present:
 *   1. The `fluxora_csrf` cookie in `req.headers.cookie`.
 *   2. The `X-CSRF-Token` (or `x-csrf-token`) header in `req.headers`.
 * - Both token values are compared in constant time using `safeCompareCsrfTokens`.
 * - Missing or mismatched tokens result in a 403 Forbidden error response envelope.
 *
 * @param req - Express Request object
 * @param res - Express Response object
 * @param next - Express NextFunction callback
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 1. Safe HTTP methods bypass CSRF check
  const isMutatingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
  if (!isMutatingMethod) {
    return next();
  }

  // 2. Only enforce for cookie-authenticated session requests
  if (!isCookieAuthenticated(req)) {
    return next();
  }

  const requestId = req.id ?? req.correlationId;

  // 3. Extract cookie token and header token
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE_NAME];

  // Header names in req.headers are lowercased by Express
  const headerTokenRaw = req.headers[CSRF_HEADER_NAME] ?? req.headers['x-csrf-token'];
  const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : headerTokenRaw;

  // 4. Trim whitespace from extracted token values to prevent whitespace-only
  //    tokens from passing presence checks (a whitespace-only string is truthy
  //    but is not a valid token).
  const cookieTokenTrimmed = cookieToken?.trim();
  const headerTokenTrimmed = headerToken?.trim();

  // 5. Validate presence of both tokens (after trimming)
  if (!cookieTokenTrimmed || !headerTokenTrimmed) {
    warn('CSRF token missing', { requestId, method: req.method, path: req.path, ip: req.ip });
    res.status(403).json(
      errorResponse(
        ApiErrorCode.FORBIDDEN,
        'CSRF token missing: fluxora_csrf cookie and X-CSRF-Token header are required for cookie-authenticated requests',
        undefined,
        requestId,
      ),
    );
    return;
  }

  // 6. Compare tokens in constant time
  if (!safeCompareCsrfTokens(cookieTokenTrimmed, headerTokenTrimmed)) {
    warn('CSRF token mismatch', { requestId, method: req.method, path: req.path, ip: req.ip });
    res.status(403).json(
      errorResponse(
        ApiErrorCode.FORBIDDEN,
        'CSRF token mismatch: provided X-CSRF-Token header does not match fluxora_csrf cookie',
        undefined,
        requestId,
      ),
    );
    return;
  }

  return next();
}
