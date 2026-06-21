import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth.js';
import { ApiErrorCode } from './errorHandler.js';
import { warn, info, debug } from '../utils/logger.js';
import { z } from 'zod';
import { isRevoked } from '../redis/jwtRevocationStore.js';
import { findApiKeyRecord, getApiKeyFromRequest } from '../lib/apiKey.js';
import { errorResponse } from '../utils/response.js';
import { Permission, ROLE_PERMISSIONS } from '../lib/permissions.js';
import type { UserPayload } from '../lib/auth.js';

export { Permission, ROLE_PERMISSIONS };

const tokenSchema = z.object({
  address: z.string(),
  role: z.string(),
  permissions: z.array(z.nativeEnum(Permission)),
  jti: z.string().optional(),
});

/**
 * Middleware to optionally authenticate a request via JWT.
 * If a valid token is present, it attaches the user payload to `req.user`.
 * If an invalid token is present, it returns 401.
 * If no token is present, it proceeds without `req.user`.
 *
 * @security
 * - Verifies JWT signature first (cryptographic integrity)
 * - Checks Redis revocation list second (immediate invalidation)
 * - Validates token shape third (schema enforcement)
 * - Revoked tokens return 401 with code TOKEN_REVOKED
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const requestId = req.id ?? req.correlationId;
  const rawApiKey = getApiKeyFromRequest(req.headers);

  debug('Authentication middleware triggered', {
    hasAuthHeader: !!authHeader,
    hasApiKey: !!rawApiKey,
    requestId,
  });

  if (!authHeader) {
    if (authenticateApiKey(req, res, next, rawApiKey)) return;
    // No credentials — proceed as anonymous
    return next();
  }

  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) {
    warn('Invalid Authorization header format', { requestId });
    if (authenticateApiKey(req, res, next, rawApiKey)) return;
    return next();
  }

  try {
    // 1. Verify signature and expiry (cryptographic check)
    const payload = verifyToken(token);

    // 2. Check revocation list (immediate invalidation check)
    const jti = (payload as { jti?: string }).jti;
    if (jti) {
      const revoked = await isRevoked(jti);
      if (revoked) {
        warn('JWT rejected — token revoked', { jti, requestId });
        res.status(401).json({
          error: {
            code: ApiErrorCode.UNAUTHORIZED,
            message: 'token_revoked',
            requestId,
          },
        });
        return;
      }
    }

    // 3. Validate token shape and permissions claim
    const parsed = tokenSchema.parse(payload) as UserPayload;
    req.user = parsed;
    info('User authenticated via JWT', { address: parsed.address, requestId });
    return next();
  } catch (error) {
    warn('JWT authentication failed', { error: error instanceof Error ? error.message : String(error), requestId });
    res.status(401).json({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired authentication token',
        requestId,
      },
    });
  }
}

function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
  rawApiKey: string | undefined,
): boolean {
  const requestId = req.id ?? req.correlationId;
  if (!rawApiKey) return false;

  const record = findApiKeyRecord(rawApiKey);
  if (!record) {
    warn('API key authentication failed', { requestId });
    res.status(401).json(
      errorResponse(
        ApiErrorCode.UNAUTHORIZED,
        'Invalid API key',
        undefined,
        requestId,
      ),
    );
    return true;
  }

  req.user = {
    address: `api-key:${record.id}`,
    role: 'service',
    permissions: record.scopes,
  };
  req.apiKey = {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
  };

  info('Service authenticated via API key', {
    apiKeyId: record.id,
    prefix: record.prefix,
    scopes: record.scopes,
    requestId,
  });
  next();
  return true;
}

/**
 * Middleware to require authentication.
 * Must be used after `authenticate` middleware.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.id ?? req.correlationId;
  if (!req.user) {
    warn('Anonymous access denied to protected route', { path: req.path, requestId });
    res.status(401).json({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Authentication required to access this resource',
        requestId,
      },
    });
    return;
  }
  next();
}

/**
 * Require that the authenticated token includes a specific permission.
 * Must be used after `authenticate` and typically after `requireAuth`.
 */
export function requirePermission(permission: Permission): ReturnType<typeof requireScope> {
  return requireScope(permission);
}

/**
 * Require that the authenticated principal includes a specific scope.
 * Missing, empty, or malformed scope sets fail closed with 403.
 * Must be used after `authenticate` and typically after `requireAuth`.
 */
export function requireScope(scope: Permission | string): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.id ?? req.correlationId;

    if (!req.user) {
      warn('Permission check failed: no authenticated user', { path: req.path, requestId });
      res.status(401).json({
        error: {
          code: ApiErrorCode.UNAUTHORIZED,
          message: 'Authentication required to access this resource',
          requestId,
        },
      });
      return;
    }

    const permissions = req.user.permissions ?? [];
    if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.includes(scope)) {
      warn('Insufficient permissions', { required: scope, have: permissions, path: req.path, requestId });
      res.status(403).json(
        errorResponse(
          ApiErrorCode.FORBIDDEN,
          'Insufficient permissions to access this resource',
          { requiredScope: scope },
          requestId,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Enforce a scope only when credentials were supplied. Public routes can use
 * this to keep anonymous access while rejecting under-scoped credentials.
 */
export function requireScopeIfAuthenticated(
  scope: Permission | string,
): (req: Request, res: Response, next: NextFunction) => void {
  const requireScopedPrincipal = requireScope(scope);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next();
      return;
    }
    requireScopedPrincipal(req, res, next);
  };
}
