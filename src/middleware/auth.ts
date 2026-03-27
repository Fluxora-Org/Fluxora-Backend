import { Request, Response, NextFunction } from 'express';
import { verifyToken, UserPayload } from '../lib/auth.js';
import { ApiError, ApiErrorCode } from './errorHandler.js';
import { warn, info } from '../utils/logger.js';

/**
 * Middleware to optionally authenticate a request via JWT.
 * If a valid token is present, it attaches the user payload to `req.user`.
 * If an invalid token is present, it returns 401.
 * If no token is present, it proceeds without `req.user`.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const requestId = (req as any).id || req.correlationId;

  if (!authHeader) {
    next();
    return;
  }

  const [type, token] = authHeader.split(' ');

  if (type !== 'Bearer' || !token) {
    warn('Invalid Authorization header format', { requestId });
    next(); // Or should we fail? Requirement says "Optional". 
    // But if they PROVIDE a header, it should be valid.
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    info('User authenticated', { address: payload.address, requestId });
    next();
  } catch (error) {
    warn('Authentication failed', { error: error instanceof Error ? error.message : String(error), requestId });
    res.status(401).json({
      error: {
        code: ApiErrorCode.UNAUTHORIZED || 'UNAUTHORIZED',
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
  const requestId = (req as any).id || req.correlationId;

  if (!req.user) {
    warn('Anonymous access denied to protected route', { path: req.path, requestId });
    res.status(401).json({
      error: {
        code: ApiErrorCode.UNAUTHORIZED || 'UNAUTHORIZED',
        message: 'Authentication required to access this resource',
        requestId,
      },
    });
    return;
  }

  next();
}
