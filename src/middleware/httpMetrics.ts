import type { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../metrics.js';
import { sanitizeMetricLabels } from '../pii/secretPatterns.js';

/** Single label for requests that never matched an Express route. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Resolve the Prometheus `route` label from the matched Express route template.
 *
 * Uses `baseUrl + route.path` (the pattern, e.g. `/users/:id`) so path
 * parameters never appear as distinct series. Unmatched requests share one
 * fixed label to keep cardinality bounded.
import { normalizeRouteLabel } from '../metrics/cardinality.js';

/**
 * Normalise the matched route so cardinality stays bounded.
 *
 * Prefers the Express route template when available. Falls back to the raw
 * path only after running it through {@link normalizeRouteLabel}, which
 * buckets UUIDs, numeric ids, Stellar addresses, and other high-cardinality
 * segments so path parameters cannot grow the Prometheus series set without
 * limit.
 *
 * @see docs/observability/metric-cardinality.md
 */
export function resolveRoute(req: Request): string {
  if (!req.route?.path) {
    return UNMATCHED_ROUTE;
  }

  const raw = `${req.baseUrl ?? ''}${req.route.path}`;

  // Collapse trailing slash to keep label cardinality predictable,
  // but preserve the bare root path "/".
  const collapsed =
    raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;

  // Express route templates already use `:param` placeholders — leave them.
  // Unmatched / fallback paths may contain real ids; bucket those.
  if (req.route?.path) {
    return collapsed.length > 1 && collapsed.endsWith('/')
      ? collapsed.slice(0, -1)
      : collapsed;
  }

  return normalizeRouteLabel(collapsed);
}

/**
 * Express middleware that records per-request metrics.
 *
 * Captures:
 * - `http_requests_total` counter (method, route, status_code)
 * - `http_request_duration_seconds` histogram (method, route, status_code)
 *
 * Must be mounted **before** route handlers so the `finish` listener
 * fires after the response has been fully written.
 */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const route = resolveRoute(req);
    // Defence-in-depth: never let secret-shaped values become Prometheus labels.
    const labels = sanitizeMetricLabels({
      method: req.method,
      route,
      status_code: String(res.statusCode),
    });

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });

  next();
}
