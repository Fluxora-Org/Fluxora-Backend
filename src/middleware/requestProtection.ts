// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
/**
 * Request protection middleware for Fluxora Backend.
 *
 * Provides:
 *   1. Body size enforcement — Content-Length fast path + raw stream byte counting
 *   2. JSON depth validation — streaming pre-parse scan + post-parse check
 *   3. Request timeout protection
 *   4. Idempotency-Key header validation — format + character-set enforcement
 *
 * All error responses use the same { error: { code, message } } envelope as the
 * rest of the app (via ApiError / errorHandler).
 *
 * Every limit is enforced *while* the body is being read, never after:
 *   - Content-Length requests are refused before a single byte is read.
 *   - Chunked / no Content-Length requests are refused the moment the running
 *     byte count crosses the limit; the socket is paused so neither this
 *     middleware nor express.json() keeps buffering the rest of the payload.
 *   - Deeply nested JSON is refused by an incremental depth scan of the raw
 *     stream, before the body is fully read and before JSON.parse() runs.
 *
 * Wire-up order in app.ts:
 *   app.use(bodySizeLimitMiddleware)   ← before express.json()
 *   app.use(jsonDepthLimitMiddleware)  ← before express.json()
 *   app.use(express.json(...))
 *   app.use(jsonDepthMiddleware)       ← after express.json() (defence in depth)
 *
 * Limits are configurable: MAX_REQUEST_SIZE lowers the default raw/decompressed
 * cap and MAX_JSON_DEPTH sets the nesting limit (see docs/request-limits.md).
 *
 * Idempotency-Key rules (RFC-aligned):
 *   - Required on POST /api/streams (enforced at route level via requireIdempotencyKey)
 *   - 1–128 characters
 *   - Allowed charset: A-Z a-z 0-9 : _ -
 *   - Keys are treated as opaque strings; UUID format is recommended but not required
 */

import type { Request, Response, NextFunction } from 'express';
import { payloadTooLarge, requestTimeout, validationError } from './errorHandler.js';
import { requestBodyTooLargeTotal, requestBodyTooDeepTotal } from '../metrics/requestProtectionMetrics.js';
import { normalizeRouteLabel } from '../metrics/cardinality.js';
import { getConfig } from '../config/env-config.js';

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
  const routePath = (req as unknown as { route?: { path?: string } }).route?.path;
  // Prefer the Express route template (already bounded). Fallback paths may
  // contain path parameters — run them through the cardinality normaliser.
  if (typeof routePath === 'string') {
    return routePath;
  }
  return normalizeRouteLabel(req.path);
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
 * Default JSON nesting depth limit: 20 (overridden by MAX_JSON_DEPTH)
 */
export const DEFAULT_RAW_LIMIT_BYTES = 256 * 1024;
export const BODY_LIMIT_BYTES = DEFAULT_RAW_LIMIT_BYTES;
export const DEFAULT_DECOMPRESSED_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_JSON_MAX_DEPTH = 20;

/**
 * Read `MAX_REQUEST_SIZE` from the validated configuration.
 *
 * It acts as an operator-tunable *cap* on the built-in default: an operator may
 * lower the default raw/decompressed limit without a code change, but raising
 * it above the built-in default stays a deliberate, reviewable edit in
 * {@link ROUTE_LIMITS} / the constants above.
 *
 * Falls back to the built-in default when configuration has not been
 * initialised (e.g. a bare unit test importing this module directly).
 */
function configuredMaxRequestSizeBytes(fallback: number): number {
  try {
    const configured = getConfig().maxRequestSizeBytes;
    return Number.isFinite(configured) && configured > 0 ? Math.min(fallback, configured) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read `MAX_JSON_DEPTH` from the validated configuration, falling back to
 * {@link DEFAULT_JSON_MAX_DEPTH} when configuration has not been initialised.
 */
export function configuredJsonMaxDepth(): number {
  try {
    const configured = getConfig().maxJsonDepth;
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_JSON_MAX_DEPTH;
  } catch {
    return DEFAULT_JSON_MAX_DEPTH;
  }
}

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
  return configuredMaxRequestSizeBytes(DEFAULT_RAW_LIMIT_BYTES);
}

export function getDecompressedLimit(req: Request): number {
  for (const route of ROUTE_LIMITS) {
    if (req.path.startsWith(route.pathPrefix)) {
      return route.decompressedLimit;
    }
  }
  return configuredMaxRequestSizeBytes(DEFAULT_DECOMPRESSED_LIMIT_BYTES);
}

// ── Mid-stream refusal ────────────────────────────────────────────────────────

/**
 * Per-request marker so the size guard and the depth guard can never both
 * call `next(err)` for the same request (a second call after the response has
 * been flushed would blow up with ERR_HTTP_HEADERS_SENT).
 */
const REFUSED = Symbol('fluxora.requestProtectionRefused');

/** True once one of the guards has refused this request. */
function alreadyRefused(req: Request): boolean {
  return (req as Request & { [REFUSED]?: boolean })[REFUSED] === true;
}

/**
 * Refuse a request while its body is still in flight.
 *
 * The important part is that we stop *reading* before responding:
 *   - `req.pause()` keeps the remaining payload out of process memory, so a
 *     hostile 1 GiB chunked upload is bounded by the limit, not by its size.
 *   - `Connection: close` lets Node close the socket once the (small) refusal
 *     response has been flushed. The socket is deliberately **not** destroyed
 *     eagerly: an immediate destroy resets the connection and the client never
 *     sees the 413/400 that was just written.
 */
function refuseDuringBodyRead(
  req: Request,
  res: Response,
  next: NextFunction,
  error: unknown,
): void {
  const marked = req as Request & { [REFUSED]?: boolean };
  if (alreadyRefused(req)) return;
  marked[REFUSED] = true;

  if (!req.readableEnded) req.pause();

  if (!res.headersSent) {
    res.setHeader('Connection', 'close');
  }

  next(error);
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
  // The limit is applied *during* the read: as soon as the running total crosses
  // it the stream is paused and the request refused, so the tail of the payload
  // is never buffered by this process (or by express.json() downstream).
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
      refuseDuringBodyRead(
        req,
        res,
        next,
        payloadTooLarge(`Request body exceeds the ${limit}-byte limit`),
      );
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

/**
 * Run a JSON parser, translating body-parser's internal 413 into the app's
 * error envelope.
 *
 * A decompressed payload that grows past the limit (zip bomb, or simply a
 * large compressed body) is refused by `raw-body` with a plain
 * `entity.too.large` error. Without this translation the client receives a
 * 413 whose body is a generic INTERNAL_ERROR and the refusal never reaches
 * `fluxora_request_body_too_large_total`.
 */
function runJsonParser(
  parser: express.RequestHandler,
  limit: number,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  parser(req, res, (err?: unknown) => {
    if (err && (err as { type?: string }).type === 'entity.too.large') {
      // A size guard may already have refused this request while the last
      // chunk was in flight; don't answer (or count) it twice.
      if (alreadyRefused(req)) return;
      requestBodyTooLargeTotal.inc({ path: normalizedPath(req) });
      next(payloadTooLarge(`Decompressed request body exceeds the ${limit}-byte limit`));
      return;
    }
    next(err);
  });
}

export function dynamicJsonParser(req: Request, res: Response, next: NextFunction): void {
  for (const { prefix, parser } of routeParsers) {
    if (req.path.startsWith(prefix)) {
      return runJsonParser(parser, getDecompressedLimit(req), req, res, next);
    }
  }
  return runJsonParser(defaultJsonParser, getDecompressedLimit(req), req, res, next);
}

// ── JSON nesting depth ────────────────────────────────────────────────────────

const CHAR_QUOTE = 0x22; // "
const CHAR_BACKSLASH = 0x5c; // \
const CHAR_OPEN_BRACE = 0x7b; // {
const CHAR_OPEN_BRACKET = 0x5b; // [
const CHAR_CLOSE_BRACE = 0x7d; // }
const CHAR_CLOSE_BRACKET = 0x5d; // ]

/**
 * Incremental JSON nesting-depth scanner.
 *
 * Fed the raw request stream, it reports an overflow as soon as the nesting
 * passes `maxDepth` — the remaining bytes of the body are never read, and
 * JSON.parse() never runs. It is deliberately *not* a JSON validator: express
 * still owns syntax validation. The scanner only tracks container nesting and
 * string/escape state so that braces inside string values are not counted.
 */
export class JsonDepthScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private overflowed = false;

  constructor(private readonly maxDepth: number) {}

  /** Number of currently open containers. */
  get currentDepth(): number {
    return this.depth;
  }

  /** True once a chunk pushed the nesting past `maxDepth`. */
  get overflow(): boolean {
    return this.overflowed;
  }

  /**
   * Feed the next raw chunk.
   *
   * @returns `false` when the depth limit has been exceeded (and the caller
   * should stop reading), `true` otherwise.
   */
  push(chunk: Buffer): boolean {
    if (this.overflowed) return false;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === CHAR_BACKSLASH) this.escaped = true;
        else if (c === CHAR_QUOTE) this.inString = false;
        continue;
      }
      if (c === CHAR_QUOTE) {
        this.inString = true;
        continue;
      }
      if (c === CHAR_OPEN_BRACE || c === CHAR_OPEN_BRACKET) {
        this.depth += 1;
        if (this.depth > this.maxDepth) {
          this.overflowed = true;
          return false;
        }
        continue;
      }
      if (c === CHAR_CLOSE_BRACE || c === CHAR_CLOSE_BRACKET) {
        this.depth = this.depth > 0 ? this.depth - 1 : 0;
      }
    }
    return true;
  }
}

/**
 * Only JSON payloads can be depth-scanned on the wire.
 *
 * Bodies sent with `Content-Encoding` are skipped: the bytes on the socket are
 * compressed, so the scanner would read noise. The decompressed size is still
 * bounded by `dynamicJsonParser` and `jsonDepthMiddleware` runs after parsing.
 */
function isScannableJsonRequest(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  if (req.headers['content-encoding'] !== undefined) return false;
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && contentType.includes('json');
}

/**
 * Refuse overly nested JSON *before* the body is fully read or parsed.
 *
 * Complements {@link jsonDepthMiddleware}: this one runs on the raw stream in
 * front of express.json(), so a hostile nesting bomb is rejected while it is
 * still arriving instead of after the whole (already materialised) object graph
 * exists in memory.
 */
export function jsonDepthLimitMiddleware(
  maxDepth: number = configuredJsonMaxDepth(),
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isScannableJsonRequest(req)) {
      next();
      return;
    }

    const scanner = new JsonDepthScanner(maxDepth);
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      if (scanner.push(chunk)) return;
      rejected = true;
      /**
       * Increment the too-deep counter so deeply nested payloads are visible
       * alongside size refusals.
       * @see src/metrics/requestProtectionMetrics.ts
       */
      requestBodyTooDeepTotal.inc({ path: normalizedPath(req) });
      refuseDuringBodyRead(
        req,
        res,
        next,
        validationError(`JSON nesting depth exceeds the maximum of ${maxDepth}`),
      );
    });

    next();
  };
}

/**
 * Validate JSON nesting depth after express.json() has parsed the body.
 * Rejects with 400 if depth exceeds maxDepth.
 *
 * Kept as a second line of defence: it also covers compressed bodies, which the
 * streaming scan above deliberately skips.
 */
export function jsonDepthMiddleware(
  maxDepth = configuredJsonMaxDepth(),
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
      try {
        checkDepth(req.body, maxDepth, 0);
      } catch {
        requestBodyTooDeepTotal.inc({ path: normalizedPath(req) });
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
