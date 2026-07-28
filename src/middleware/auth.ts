import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth.js';
import { ApiErrorCode } from './errorHandler.js';
import { warn, info, debug } from '../utils/logger.js';
import { z } from 'zod';
import { isRevoked } from '../redis/jwtRevocationStore.js';
import { authJwtVerifyDurationSeconds } from '../metrics/businessMetrics.js';
import { getApiKeyFromRequest, findRecordByRawKey } from '../lib/apiKey.js';


/**
 * Middleware to authenticate via API key (X-API-Key header).
 * If a valid API key is present, attaches keyScopes to req.
 * If no API key is present, proceeds without setting keyScopes.
 * If an invalid API key is present, returns 401.
 */
export async function authenticateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requestId = req.correlationId;
  const rawKey = getApiKeyFromRequest(req.headers);

  if (!rawKey) {
    return next();
  }

  try {
    const record = await getApiKeyRecord(rawKey);
    
    if (!record) {
      warn('API key authentication failed — key not found', { requestId });
      res.status(401).json({
        error: {
          code: ApiErrorCode.UNAUTHORIZED,
          message: 'Invalid API key',
          requestId,
        },
      });
      return;
    }

    if (!record.active) {
      warn('API key authentication failed — key is revoked', { keyId: record.id, requestId });
      res.status(401).json({
        error: {
          code: ApiErrorCode.UNAUTHORIZED,
          message: 'API key has been revoked',
          requestId,
        },
      });
      return;
    }

    (req as any).keyScopes = record.scopes;
    (req as any).keyId = record.id;
    
    info('API key authenticated', { keyId: record.id, requestId });
    return next();
  } catch (error) {
    warn('API key authentication error', { 
      error: error instanceof Error ? error.message : String(error), 
      requestId 
    });
    res.status(401).json({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Authentication failed',
        requestId,
      },
    });
    return;
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
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const requestId = req.correlationId;

  debug('Authentication middleware triggered', { hasAuthHeader: !!authHeader, requestId });

  if (!authHeader) {
    return next();
  }

  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) {
    warn('Invalid Authorization header format', { requestId });
    return next();
  }

  try {
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
    return;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.correlationId;
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

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.correlationId;
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

export function requireScope(...requiredScopes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.correlationId;
    const isApiKeyAuth = (req as any).keyId !== undefined;
    const isJwtAuth = req.user !== undefined;
    if (!isApiKeyAuth && !isJwtAuth) {
      warn('Scope check failed: no authenticated principal', { path: req.path, requestId });
      res.status(401).json({
        error: {
          code: ApiErrorCode.UNAUTHORIZED,
          message: 'Authentication required to access this resource',
          requestId,
        },
      });
      return;
    }
    let scopes: string[] = [];
    if (isApiKeyAuth) {
      scopes = (req as any).keyScopes ?? [];
    } else if (isJwtAuth) {
      scopes = (req.user as any).permissions ?? [];
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      warn('Scope check failed: no scopes found on principal', { path: req.path, requestId });
      res.status(403).json({
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message: 'Principal does not have required scopes',
          requestId,
        },
      });
      return;
    }
    const hasRequiredScope = requiredScopes.some(scope => scopes.includes(scope));
    if (!hasRequiredScope) {
      warn('Insufficient scopes', { required: requiredScopes, have: scopes, path: req.path, requestId });
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
