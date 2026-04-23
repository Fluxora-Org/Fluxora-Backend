/**
 * Request protection middleware for Fluxora Backend.
 *
 * Provides:
 *   1. Body size enforcement — Content-Length fast path + raw stream byte counting
 *   2. JSON depth validation — applied after express.json()
 *   3. Request timeout protection
 *   4. Idempotency-Key header validation — format + character-set enforcement
 *
 * All error responses use the same { error: { code, message } } envelope as the
 * rest of the app (via ApiError / errorHandler).
 *
 * Wire-up order in app.ts:
 *   app.use(bodySizeLimitMiddleware)   ← before express.json()
 *   app.use(express.json(...))
 *   app.use(jsonDepthMiddleware)       ← after express.json()
 *
 * Idempotency-Key rules (RFC-aligned):
 *   - Required on POST /api/streams (enforced at route level via requireIdempotencyKey)
 *   - 1–128 characters
 *   - Allowed charset: A-Z a-z 0-9 : _ -
 *   - Keys are treated as opaque strings; UUID format is recommended but not required
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiErrorCode, payloadTooLarge, validationError } from './errorHandler.js';

// ── Idempotency-Key constants ─────────────────────────────────────────────────

/** Minimum and maximum byte length for an Idempotency-Key value. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Allowed characters: alphanumeric, colon, underscore, hyphen. */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9:_-]+$/;

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

// ── Idempotency-Key validation ────────────────────────────────────────────────

/**
 * Parse and validate an Idempotency-Key header value.
 *
 * Returns the trimmed key on success, or throws an ApiError (400) on failure.
 * This is a pure helper — it does NOT read from req directly so it can be
 * unit-tested without an Express context.
 */
export function parseIdempotencyKeyHeader(headerValue: unknown): string {
  if (Array.isArray(headerValue) || typeof headerValue !== 'string') {
    throw validationError(
      'Idempotency-Key header is required and must be a single string value',
    );
  }
  const trimmed = headerValue.trim();
  if (trimmed.length < IDEMPOTENCY_KEY_MIN_LENGTH || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validationError(
      `Idempotency-Key must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  if (!IDEMPOTENCY_KEY_REGEX.test(trimmed)) {
    throw validationError(
      'Idempotency-Key must contain only letters, digits, colon, underscore, or hyphen',
    );
  }
  return trimmed;
}

/**
 * Express middleware that enforces the presence and format of the
 * Idempotency-Key header on the current route.
 *
 * Usage — apply directly to any route that requires idempotency:
 *
 *   router.post('/', requireIdempotencyKey, asyncHandler(async (req, res) => { … }))
 *
 * On success the validated key is attached to `res.locals.idempotencyKey`
 * so downstream handlers can read it without re-parsing.
 */
export function requireIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const key = parseIdempotencyKeyHeader(req.headers['idempotency-key']);
    res.locals['idempotencyKey'] = key;
    next();
  } catch (err) {
    next(err);
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
