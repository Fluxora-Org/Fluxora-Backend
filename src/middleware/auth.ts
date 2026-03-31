import { Request, Response, NextFunction } from 'express';
import { verifyToken, UserPayload } from '../lib/auth.js';
import { getApiKeyFromRequest, isValidApiKey } from '../lib/apiKey.js';
import { ApiError, ApiErrorCode } from './errorHandler.js';
import { warn, info, debug } from '../utils/logger.js';

/**
 * Middleware to optionally authenticate a request via JWT or API Key.
 * If a valid token/key is present, it attaches relevant data to `req.user`.
 * If an invalid token/key is present, it returns 401.
 * If neither is present, it proceeds without `req.user`.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const requestId = (req as any).id || (req as any).correlationId;
  const apiKey = getApiKeyFromRequest(req.headers as Record<string, string | string[] | undefined>);

  debug('Authentication middleware triggered', { hasAuthHeader: !!authHeader, requestId });

  // 1. Try API Key first (common for server-to-server)
  const apiKey = getApiKeyFromRequest(req.headers as Record<string, string | string[] | undefined>);
  if (apiKey) {
    if (isValidApiKey(apiKey)) {
      req.user = { address: 'system', role: 'service' } as any;
      info('Service authenticated via API Key', { requestId });
      return next();
    }
    
    warn('Invalid API Key provided', { requestId });
    res.status(401).json({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Invalid API Key',
        requestId,
      },
    });
    return;
  }

  // 2. Try JWT if no API Key or if preference is given to JWT
  if (authHeader) {
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
      return;
    }
  }

  // 3. No credentials provided
  next();
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
