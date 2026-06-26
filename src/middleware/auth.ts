import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth.js';
import { ApiErrorCode } from './errorHandler.js';
import { warn, info, debug } from '../utils/logger.js';
import { z } from 'zod';
import { isRevoked } from '../redis/jwtRevocationStore.js';
import { authJwtVerifyDurationSeconds } from '../metrics/businessMetrics.js';
import { getApiKeyFromRequest, getApiKeyRecord } from '../lib/apiKey.js';


/**
 * Middleware to authenticate via API key (X-API-Key header).
 * If a valid API key is present, attaches keyScopes to req.
 * If no API key is present, proceeds without setting keyScopes.
 * If an invalid API key is present, returns 401.
 */
export async function authenticateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requestId = req.id ?? req.correlationId;
  const rawKey = getApiKeyFromRequest(req.headers);

  if (!rawKey) {
    // No API key provided — proceed (may be authenticated via JWT instead)
    return next();
  }

  try {
    const record = getApiKeyRecord(rawKey);
    
    if (!record) {
      warn('API y authentication failed — key not found', { requestId });
      return res.status(401).json({
        error: {
          code: ApiErrorCode.UNAUTHORIZED,
          message: 'Invalid API key',
          requestId,
        },
      });
    }

    if (!record.active) {
      warn('API key authentication failed — key is revoked', { keyId: record.id, requestId });
      return res.status(401).json({
        error: {
          code: ApiErrorCode.UNAUTHORIZED,
          message: 'API key has been revoked',
          requestId,
        },
      });
    }

    // Attach scopes to request for scope middleware to check
    (req as any).keyScopes = record.scopes;
    (req as any).keyId = record.id;
    
    info('API key authenticated', { keyId: record.id, requestId });
    return next();
  } catch (error) {
    warn('API key authentication error', { 
      error: error instanceof Error ? error.message : String(error), 
      requestId 
    });
    return res.status(401).json({
      error: {
        code: ApiError.UNAUTHORIZED,
        message: 'Authentication failed',
        requestId,
      },
    });
  }
}

export enum Permission {
  STREAMS_READ = 'streams:read',
  STREAMS_WRITE = 'streams:write',
  ADMIN_PAUSE = 'admin:pause',
  ADMIN_REINDEX = 'admin:reindex',
  INDEXER_REPLAY = 'indexer:replay',
  DLQ_LIST = 'dlq:list',
  DLQ_READ = 'dlq:read',
  DLQ_REPLAY = 'dlq:replay',
  DLQ_DELETE = 'dlq:delete',
  DLQ_CONSUMER_RESUME = 'dlq:consumer:resume',
  AUDIT_READ = 'audit:read',
  AUDIT_WRITE = 'audit:write',
}

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  operator: [
    Permission.STREAMS_READ,
    Permission.STREAMS_WRITE,
    Permission.DLQ_LIST,
    Permission.DLQ_READ,
    Permission.DLQ_REPLAY,
    Permission.DLQ_DELETE,
    Permission.DLQ_CONSUMER_RESUME,
    Permission.AUDIT_READ,
  ],
  viewer: [Permission.STREAMS_READ],
  admin: Object.values(Permission) as Permission[],
};

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

  debug('Authentication middleware triggered', { hasAuthHeader: !!authHeader, requestId });

  if (!authHeader) {
    // No credentials — proceed as anonymous
    return next();
  }

  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) {
    warn('Invalid Authorization header format', { requestId });
    return next();
  }

  try {
    // 1. Verify signature and expiry (cryptographic check).
    // Record latency around the verify call so p50/p95/p99 latency and the
    // outcome split are observable from Prometheus. The outcome label is the
    // ONLY label emitted; no token, jti, address, or subject is recorded.
    const endJwtVerifyTimer = authJwtVerifyDurationSeconds.startTimer();
    let jwtVerifyOutcome: 'success' | 'failure' = 'success';
    let payload: unknown;
    try {
      payload = verifyToken(token) as unknown;
    } catch (verifyErr) {
      jwtVerifyOutcome = 'failure';
      throw verifyErr;
    } finally {
      endJwtVerifyTimer({ outcome: jwtVerifyOutcome });
    }

    // 2. Check revocation list (immediate invalidation check)
    const jti = (payload as any)?.jti;
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
    const parsed = tokenSchema.parse(payload);
    req.user = parsed as any;
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
export function requirePermission(permission: Permission) {
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

    const permissions: string[] = (req.user as any).permissions ?? [];
    if (!Array.isArray(permissions) || !permissions.includes(permission)) {
      warn('Insufficient permissions', { required: permission, have: permissions, path: req.path, requestId });
      res.status(403).json({
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message: 'Insufficient permissions to access this resource',
          requestId,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Require that the API key includes a specific scope.
 * Used for API key-based authentication (not JWT).
 * Must be used after the API key is authenticated and attached to req.
 * 
 * @param requiredScope - The scope required (e.g., 'streams:read', 'streams:write')
 * @returns Middleware function that enforces the scope
 */
export function requireScope(...requiredScopes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.id ?? req.correlationId;

    // Check if API key scopes are attached to the request
    const keyScopes: string[] = (req as any).keyScopes ?? [];

    if (!Array.isArray(keyScopes) || keyScopes.length === 0) {
      warn('Scope check failed: no API key scopes found', { path: req.path, requestId });
      res.status(403).json({
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message: 'API key does not have required scopes',
          requestId,
        },
      });
      return;
    }

    // Check if the key has at least one of the required scopes
    const hasRequiredScope = requiredScopes.some(scope => keyScopes.includes(scope));

    if (!hasRequiredScope) {
      warn('Insufficient scopes', { required: requiredScopes, have: keyScopes, path: req.path, requestId });
      res.status(403).json({
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message: `Insufficient scopes. Required: ${requiredScopes.join(' or ')}`,
          requestId,
        },
      });
      return;
    }

    next();
  };
}