import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { errorResponse } from '../utils/response.js';

/**
 * Allowed HTTP methods for method override.
 * Only idempotent or partial mutation methods are supported for POST overrides.
 */
const ALLOWED_OVERRIDE_METHODS = new Set(['PATCH', 'PUT', 'DELETE']);

/**
 * Unauthenticated or public path prefixes where HTTP method override
 * is strictly disabled to prevent unintended method mutations on public endpoints.
 */
const PUBLIC_PATH_PREFIXES = [
  '/health',
  '/api/auth',
  '/internal/webhooks',
  '/internal/indexer',
  '/docs',
  '/metrics',
];

/**
 * Validates whether the raw override string matches an allowed HTTP method.
 *
 * @param raw - Unsanitized input from header or query string.
 * @returns The normalized uppercase method if allowed, or `null` if unsupported/invalid.
 */
export function validateOverrideMethod(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
      raw = raw[0];
    } else {
      return null;
    }
  }

  const str = (raw as string).trim().toUpperCase();
  if (!str || !ALLOWED_OVERRIDE_METHODS.has(str)) {
    return null;
  }

  return str;
}

/**
 * Checks whether a request has an authenticated identity or credential header.
 *
 * @param req - Express Request object.
 * @returns `true` if authentication is present or credentials exist.
 */
function isAuthenticatedRequest(req: Request): boolean {
  const hasUser = Boolean(req.user || (req as any).keyId || (req as any).keyScopes);
  const hasCredentialHeader = Boolean(req.headers.authorization || req.headers['x-api-key']);
  return hasUser || hasCredentialHeader;
}

/**
 * Extracts a safe user/client identifier for structured audit logging.
 *
 * @param req - Express Request object.
 * @returns Sanitized string identifier for the requesting user/client.
 */
function getAuditUserId(req: Request): string {
  if (req.user) {
    const u = req.user as { address?: string; sub?: string; role?: string };
    return u.address || u.sub || u.role || 'authenticated_user';
  }
  if ((req as any).keyId) {
    return `key:${(req as any).keyId}`;
  }
  return 'credential_header_present';
}

/**
 * Logs structured audit details when an HTTP method is successfully overridden.
 *
 * @param req - Express Request object.
 * @param originalMethod - The original HTTP method (always 'POST').
 * @param effectiveMethod - The new effective HTTP method (PATCH, PUT, or DELETE).
 */
export function logMethodOverride(
  req: Request,
  originalMethod: string,
  effectiveMethod: string,
): void {
  const correlationId = req.correlationId;
  const user = getAuditUserId(req);
  logger.info('HTTP method overridden', correlationId, {
    event: 'http_method_override',
    originalMethod,
    effectiveMethod,
    user,
    path: req.path,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Express middleware that rewrites `req.method` for `POST` requests to `PATCH`, `PUT`,
 * or `DELETE` when specified by `X-HTTP-Method-Override` header or `_method` query parameter.
 *
 * Security & Scoping Rules:
 * - Executes ONLY for `POST` requests.
 * - Ignores public endpoints, health checks, login routes, and webhooks.
 * - Requires authentication context or credential headers.
 * - Rejects unsupported methods (GET, POST, OPTIONS, HEAD, TRACE, CONNECT, arbitrary strings) with HTTP 400.
 * - Header (`X-HTTP-Method-Override`) takes precedence over query parameter (`_method`).
 *
 * @param req - Express Request object.
 * @param res - Express Response object.
 * @param next - Express NextFunction callback.
 */
export function methodOverrideMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // 1. Exit immediately if not a POST request
  if (req.method !== 'POST') {
    return next();
  }

  // 2. Read override value from header or query string (header takes precedence)
  const headerValue = req.headers['x-http-method-override'];
  const queryValue = req.query._method;
  const rawOverride = headerValue !== undefined && headerValue !== '' ? headerValue : queryValue;

  // Exit immediately if no override value exists
  if (!rawOverride || (typeof rawOverride === 'string' && rawOverride.trim() === '')) {
    return next();
  }

  // 3. Skip method override on public or unauthenticated endpoints
  const path = req.path || req.originalUrl || '';
  if (path === '/' || PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  // Skip method override if request lacks authentication context or credential headers
  if (!isAuthenticatedRequest(req)) {
    return next();
  }

  // 4. Validate method against allowlist (PATCH, PUT, DELETE)
  const validatedMethod = validateOverrideMethod(rawOverride);
  if (!validatedMethod) {
    const requestId = req.correlationId ?? (res.locals['requestId'] as string | undefined);
    const rawStr = Array.isArray(rawOverride) ? String(rawOverride[0]) : String(rawOverride);
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        `Unsupported method override: ${rawStr}. Only PATCH, PUT, and DELETE are supported.`,
        undefined,
        requestId,
      ),
    );
    return;
  }

  // 5. Log audit trail and rewrite method
  const originalMethod = req.method;
  logMethodOverride(req, originalMethod, validatedMethod);

  req.method = validatedMethod;
  next();
}
