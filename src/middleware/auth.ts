import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth.js';
import { ApiErrorCode } from './errorHandler.js';
import { warn, info, debug } from '../utils/logger.js';
import { z } from 'zod';

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
    Permission.AUDIT_READ,
  ],
  viewer: [Permission.STREAMS_READ],
  admin: Object.values(Permission) as Permission[],
};

const tokenSchema = z.object({
  address: z.string(),
  role: z.string(),
  permissions: z.array(z.nativeEnum(Permission)),
});

/**
 * Middleware to optionally authenticate a request via JWT.
 * If a valid token is present, it attaches the user payload to `req.user`.
 * If an invalid token is present, it returns 401.
 * If no token is present, it proceeds without `req.user`.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
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
    const payload = verifyToken(token) as unknown;
    // Validate token shape and permissions claim strictly here.
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
