import type { Request, Response, NextFunction } from 'express';
import { info } from '../utils/logger.js';
import { ApiErrorCode, validationError } from './errorHandler.js';

/**
 * Middleware that rewrites req.method to the value of X-HTTP-Method-Override
 * (or ?_method=) when the original request is a POST.
 * Restricted to a safe allowlist (PATCH, DELETE, PUT) and only for authenticated requests.
 */
export function methodOverrideMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only override POST requests
  if (req.method !== 'POST') {
    return next();
  }

  // Retrieve override method from header or query string
  const overrideMethod = req.headers['x-http-method-override'] || req.query._method;
  if (!overrideMethod) {
    return next();
  }

  // Only apply to authenticated requests (indicated by the presence of auth headers)
  const hasAuth = Boolean(req.headers.authorization || req.headers['x-api-key']);
  if (!hasAuth) {
    return next();
  }

  const method = (Array.isArray(overrideMethod) ? overrideMethod[0] : overrideMethod) as string;
  const upperMethod = method.toUpperCase();

  const allowed = ['PATCH', 'DELETE', 'PUT'];
  if (!allowed.includes(upperMethod)) {
    // Requirements state we must reject override attempts to unsupported methods with a 400
    res.status(400).json({
      error: {
        code: ApiErrorCode.VALIDATION_ERROR,
        message: 'Unsupported method override',
      }
    });
    return;
  }

  info('HTTP method overridden', {
    originalMethod: 'POST',
    effectiveMethod: upperMethod,
    path: req.path,
    requestId: req.id,
  });

  req.method = upperMethod;
  next();
}
