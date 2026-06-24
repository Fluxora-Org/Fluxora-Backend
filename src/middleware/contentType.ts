import type { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/response.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Middleware that rejects POST/PUT/PATCH requests carrying a non-JSON
 * Content-Type with a 415 Unsupported Media Type response.
 *
 * - No Content-Type header → pass through (proxies may strip it)
 * - `application/json` and `application/json; charset=*` → pass through
 * - `application/*+json` vendor media types → pass through
 * - Any other Content-Type → 415 with standard error envelope
 *
 * Only applies to write methods (POST, PUT, PATCH). GET, HEAD, DELETE,
 * and other methods are unaffected.
 */
export function requireJsonContentType(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!WRITE_METHODS.has(req.method)) {
    next();
    return;
  }

  const contentType = req.headers['content-type'];
  if (!contentType) {
    next();
    return;
  }

  const mediaType = contentType.split(';')[0].trim().toLowerCase();

  const isJson =
    mediaType === 'application/json' || mediaType.endsWith('+json');

  if (isJson) {
    next();
    return;
  }

  const requestId = req.id ?? (res.locals['requestId'] as string | undefined);
  res.status(415).json(
    errorResponse(
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
      undefined,
      requestId,
    ),
  );
}
