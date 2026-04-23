/**
 * Request protection middleware for Fluxora Backend.
 *
 * Provides:
 *   1. Body size enforcement — Content-Length fast path + raw stream byte counting
 *   2. JSON depth validation — applied after express.json()
 *   3. Request timeout protection
 *
 * All 413 responses use the same { error: { code, message } } envelope as the
 * rest of the app (via ApiError / errorHandler).
 *
 * Wire-up order in app.ts:
 *   app.use(bodySizeLimitMiddleware)   ← before express.json()
 *   app.use(express.json(...))
 *   app.use(jsonDepthMiddleware)       ← after express.json()
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiErrorCode, payloadTooLarge, validationError } from './errorHandler.js';

/** 256 KiB — matches the webhook contract and express.json limit. */
export const BODY_LIMIT_BYTES = 256 * 1024;

/**
 * Enforce BODY_LIMIT_BYTES before the body is parsed.
 *
 * Two-layer check:
 *   1. Content-Length header (fast path — no bytes read)
 *   2. Raw stream byte counting (catches chunked / no Content-Length requests)
 */
export function bodySizeLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Fast path: reject via Content-Length before reading any bytes.
  const clHeader = req.headers['content-length'];
  if (clHeader !== undefined) {
    const cl = parseInt(clHeader, 10);
    if (!Number.isNaN(cl) && cl > BODY_LIMIT_BYTES) {
      next(payloadTooLarge(`Request body exceeds the ${BODY_LIMIT_BYTES}-byte limit`));
      return;
    }
  }

  // Slow path: count raw stream bytes for chunked / no Content-Length requests.
  let received = 0;
  let rejected = false;

  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    received += chunk.length;
    if (received > BODY_LIMIT_BYTES) {
      rejected = true;
      next(payloadTooLarge(`Request body exceeds the ${BODY_LIMIT_BYTES}-byte limit`));
      req.socket.destroy();
    }
  });

  next();
}

/**
 * Validate JSON nesting depth after express.json() has parsed the body.
 * Rejects with 400 if depth exceeds maxDepth.
 */
export function jsonDepthMiddleware(maxDepth = 10) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
      try {
        checkDepth(req.body, maxDepth, 0);
      } catch {
        next(validationError(`JSON nesting depth exceeds the maximum of ${maxDepth}`));
        return;
      }
    }
    next();
  };
}

function checkDepth(value: unknown, max: number, current: number): void {
  if (current > max) throw new Error('depth exceeded');
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      checkDepth(v, max, current + 1);
    }
  }
}

/**
 * Enforce a socket-level request timeout.
 * Responds 408 if the socket is idle for longer than timeoutMs.
 */
export function requestTimeoutMiddleware(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    req.socket.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        next(
          Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), {
            statusCode: 408,
            code: ApiErrorCode.INTERNAL_ERROR,
          }),
        );
      }
      req.socket.destroy();
    });
    res.on('finish', () => req.socket.setTimeout(0));
    next();
  };
}
