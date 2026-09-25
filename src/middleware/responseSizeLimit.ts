/**
 * Response size guard for Fluxora Backend (#1555).
 *
 * `bodySizeLimitMiddleware` (requestProtection.ts) bounds what clients send us.
 * This middleware is the response-side counterpart: every buffered response
 * body — anything sent through `res.send()` or `res.json()` — is measured
 * before it leaves the process, and a body over the endpoint's byte limit is
 * never sent. It is replaced with a small 500 error envelope instead:
 *
 *   { success: false, error: { code: 'INTERNAL_ERROR',
 *       message: 'Response exceeded the <n>-byte limit for this endpoint',
 *       details: { reason: 'RESPONSE_TOO_LARGE', limitBytes: <n> } } }
 *
 * That makes an unbounded response impossible by construction: even a handler
 * that forgets to paginate cannot ship an arbitrarily large payload to the
 * client. Pagination (limit ≤ 100) remains the primary bound on collections;
 * this is the backstop. Per-endpoint limits are documented in
 * docs/response-limits.md.
 *
 * Streamed responses (`res.write()` — SSE, NDJSON/CSV exports) do not pass
 * through `res.send()`. They are bounded by their own explicit caps (page
 * counts, backpressure), also listed in docs/response-limits.md.
 *
 * Observability: `fluxora_response_too_large_total{route}` counts replaced
 * responses, labelled with the matched route template (never the raw URL), and
 * a warn log records the route, limit and actual size. Body content is never
 * logged.
 *
 * Wire-up: `app.use(responseSizeLimitMiddleware)` before any router, so it
 * wraps `res.send` for every route.
 */

import type { Request, Response, NextFunction } from 'express';
import { Counter } from 'prom-client';
import { registry } from '../metrics.js';
import { ApiErrorCode } from '../errors.js';
import { errorResponse } from '../utils/response.js';
import { warn } from '../lib/logger.js';

/** Default cap for any buffered response body: 1 MiB. */
export const DEFAULT_RESPONSE_LIMIT_BYTES = 1024 * 1024;

export interface ResponseRouteLimit {
  /** Matches the exact path or any sub-path (`/metrics`, `/metrics/...`). */
  pathPrefix: string;
  maxBytes: number;
  /** Why this endpoint needs more than the default — kept next to the number. */
  reason: string;
}

/**
 * Endpoints allowed to exceed the 1 MiB default. Everything else gets
 * DEFAULT_RESPONSE_LIMIT_BYTES. Keep docs/response-limits.md in sync.
 */
export const RESPONSE_ROUTE_LIMITS: readonly ResponseRouteLimit[] = [
  {
    pathPrefix: '/metrics',
    maxBytes: 8 * 1024 * 1024,
    reason: 'Prometheus exposition text grows with the number of series; admin-authenticated scrape only.',
  },
  {
    pathPrefix: '/openapi.json',
    maxBytes: 2 * 1024 * 1024,
    reason: 'Static OpenAPI document (~45 KiB today); headroom for spec growth.',
  },
];

/** Byte limit for a request path (the full path, before routers rewrite req.url). */
export function getResponseLimit(path: string): number {
  for (const route of RESPONSE_ROUTE_LIMITS) {
    if (path === route.pathPrefix || path.startsWith(`${route.pathPrefix}/`)) {
      return route.maxBytes;
    }
  }
  return DEFAULT_RESPONSE_LIMIT_BYTES;
}

/**
 * Byte length of a body handed to `res.send()`, or `null` when it is not yet
 * serialised (objects, arrays, booleans, numbers). Express turns those into a
 * JSON string and calls `res.send()` again, where the string is measured.
 */
export function bodyByteLength(body: unknown): number | null {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (body instanceof Uint8Array) return body.byteLength; // includes Buffer
  return null;
}

export const responseTooLargeTotal =
  (registry.getSingleMetric('fluxora_response_too_large_total') as Counter<'route'>) ||
  new Counter({
    name: 'fluxora_response_too_large_total',
    help: 'Responses replaced with a 500 because the body exceeded the endpoint response size limit, labeled by route template',
    labelNames: ['route'] as const,
    registers: [registry],
  });

/** Route template for metrics/logs — never the raw URL (cardinality, PII). */
function routeLabel(req: Request): string {
  const routePath = (req as unknown as { route?: { path?: unknown } }).route?.path;
  return typeof routePath === 'string' ? `${req.baseUrl}${routePath}` : 'unmatched';
}

export function responseSizeLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Resolved now: inside a router `req.path` is relative to the mount point.
  const limit = getResponseLimit(req.path);
  const originalSend = res.send;
  let replaced = false;

  res.send = ((body?: unknown): Response => {
    if (replaced) return originalSend.call(res, body);

    const size = bodyByteLength(body);
    if (size === null || size <= limit) return originalSend.call(res, body);

    replaced = true;
    const route = routeLabel(req);
    responseTooLargeTotal.inc({ route });
    warn('Response body exceeded the endpoint size limit and was not sent', {
      route,
      limitBytes: limit,
      bodyBytes: size,
      requestId: req.correlationId,
    });

    if (res.headersSent) {
      // Too late to change the status; drop the connection rather than stream
      // an over-limit body.
      res.destroy();
      return res;
    }

    res.status(500);
    res.removeHeader('Content-Length');
    res.removeHeader('ETag');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return originalSend.call(
      res,
      JSON.stringify(
        errorResponse(
          ApiErrorCode.INTERNAL_ERROR,
          `Response exceeded the ${limit}-byte limit for this endpoint`,
          { reason: 'RESPONSE_TOO_LARGE', limitBytes: limit },
          req.correlationId,
        ),
      ),
    );
  }) as Response['send'];

  next();
}
