import { Request, Response, NextFunction } from 'express';
import { verifyToken, UserPayload } from '../lib/auth.js';
import { getApiKeyFromRequest, isValidApiKey } from '../lib/apiKey.js';
import { ApiError, ApiErrorCode } from './errorHandler.js';
import { warn, info, debug } from '../utils/logger.js';

/**
 * Middleware to optionally authenticate a request via JWT.
 * If a valid token is present, it attaches the user payload to `req.user`.
 * If an invalid token is present, it returns 401.
 * If no token is present, it proceeds without `req.user`.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const requestId = (req as any).id || (req as any).correlationId;
  const apiKey = getApiKeyFromRequest(req.headers as Record<string, string | string[] | undefined>);

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
    const payload = verifyToken(token);
    req.user = payload;
    info('User authenticated via JWT', { address: payload.address, requestId });
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
  const requestId = (req as any).id || (req as any).correlationId;
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
