import type { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/response.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const READ_METHODS = new Set(['GET', 'HEAD']);

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

/**
 * Middleware that rejects read requests whose Accept header does not allow a
 * JSON response.
 *
 * - No Accept header -> pass through
 * - `application/json`, `application/*+json`, and wildcard media ranges -> pass through
 * - Any unacceptable response type -> 406 with standard error envelope
 *
 * The response intentionally avoids reflecting the raw Accept header.
 */
export function requireJsonAccept(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!READ_METHODS.has(req.method)) {
    next();
    return;
  }

  if (req.accepts(['application/json', 'application/*+json'])) {
    next();
    return;
  }

  const requestId = req.id ?? (res.locals['requestId'] as string | undefined);
  res.status(406).json(
    errorResponse(
      'NOT_ACCEPTABLE',
      'Accept header must allow application/json',
      undefined,
      requestId,
    ),
  );
}
