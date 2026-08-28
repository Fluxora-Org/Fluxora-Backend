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
import { payloadTooLarge, requestTimeout, validationError } from './errorHandler.js';
import { requestBodyTooLargeTotal } from '../metrics/requestProtectionMetrics.js';

/**
 * Derive a normalized route path label for metrics.
 *
 * Uses `req.route.path` when Express has matched a route (most accurate), falling
 * back to `req.path` when the middleware fires before routing (e.g. the fast-path
 * Content-Length check). Raw `req.originalUrl` is never used — it would expose
 * path parameters and query strings in the Prometheus label, causing cardinality
 * explosion and potential data leakage.
 *
 * @internal
 */
function normalizedPath(req: Request): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const routePath = (req as unknown as { route?: { path?: string } }).route?.path;
  return typeof routePath === 'string' ? routePath : req.path;
}

// ── Idempotency-Key constants ─────────────────────────────────────────────────

/** Minimum and maximum byte length for an Idempotency-Key value. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Allowed characters: alphanumeric, colon, underscore, hyphen. */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9:_-]+$/;

/** 
 * Default raw payload limit: 256 KiB 
 * Default decompressed payload limit: 256 KiB
 */
export const DEFAULT_RAW_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_DECOMPRESSED_LIMIT_BYTES = 256 * 1024;

export interface RouteLimit {
  pathPrefix: string;
  rawLimit: number;
  decompressedLimit: number;
}

export const ROUTE_LIMITS: RouteLimit[] = [
  {
    pathPrefix: '/internal/webhooks',
    rawLimit: 2 * 1024 * 1024, // 2 MiB raw
    decompressedLimit: 10 * 1024 * 1024, // 10 MiB decompressed
  },
  {
    pathPrefix: '/api/uploads',
    rawLimit: 10 * 1024 * 1024, // 10 MiB raw
    decompressedLimit: 50 * 1024 * 1024, // 50 MiB decompressed
  }
];

export function getRawLimit(req: Request): number {
  for (const route of ROUTE_LIMITS) {
    if (req.path.startsWith(route.pathPrefix)) {
      return route.rawLimit;
    }
  }
  return DEFAULT_RAW_LIMIT_BYTES;
}

export function getDecompressedLimit(req: Request): number {
  for (const route of ROUTE_LIMITS) {
    if (req.path.startsWith(route.pathPrefix)) {
      return route.decompressedLimit;
    }
  }
  return DEFAULT_DECOMPRESSED_LIMIT_BYTES;
}

/**
 * Enforce raw body size limit before the body is parsed.
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
  const limit = getRawLimit(req);

  // Fast path: reject via Content-Length before reading any bytes.
  const clHeader = req.headers['content-length'];
  if (clHeader !== undefined) {
    const cl = parseInt(clHeader, 10);
    if (!Number.isNaN(cl) && cl > limit) {
      /**
       * Increment the oversized-body counter so SREs can alert on sudden spikes
       * in 413 responses (potential DoS probe or misconfigured client).
       * @see src/metrics/requestProtectionMetrics.ts
       */
      requestBodyTooLargeTotal.inc({ path: normalizedPath(req) });
      next(payloadTooLarge(`Request body exceeds the ${limit}-byte limit`));
      return;
    }
  }

  // Slow path: count raw stream bytes for chunked / no Content-Length requests.
  let received = 0;
  let rejected = false;

  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    received += chunk.length;
    if (received > limit) {
      rejected = true;
      /**
       * Increment the oversized-body counter for the stream-based slow path.
       * @see src/metrics/requestProtectionMetrics.ts
       */
      requestBodyTooLargeTotal.inc({ path: normalizedPath(req) });
      next(payloadTooLarge(`Request body exceeds the ${limit}-byte limit`));
      req.socket.destroy();
    }
  });

  next();
}

import express from 'express';

const defaultJsonParser = express.json({ limit: DEFAULT_DECOMPRESSED_LIMIT_BYTES });
const routeParsers = ROUTE_LIMITS.map(r => ({
  prefix: r.pathPrefix,
  parser: express.json({ limit: r.decompressedLimit })
}));

export function dynamicJsonParser(req: Request, res: Response, next: NextFunction): void {
  for (const { prefix, parser } of routeParsers) {
    if (req.path.startsWith(prefix)) {
      return parser(req, res, next);
    }
  }
  return defaultJsonParser(req, res, next);
}

/**
 * Validate JSON nesting depth after express.json() has parsed the body.
 * Rejects with 400 if depth exceeds maxDepth.
 */
export function jsonDepthMiddleware(maxDepth = 10): (req: Request, _res: Response, next: NextFunction) => void {
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
export function requestTimeoutMiddleware(timeoutMs: number): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    req.socket.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
        next(requestTimeout(`Request timed out after ${timeoutMs}ms`));
        return;
      }
      req.socket.destroy();
    });
    res.on('finish', () => req.socket.setTimeout(0));
    next();
  };
}
