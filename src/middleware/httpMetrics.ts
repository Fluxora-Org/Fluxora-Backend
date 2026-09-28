import type { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../metrics.js';
import { sanitizeMetricLabels } from '../pii/secretPatterns.js';
import { normalizeRouteLabel } from '../metrics/cardinality.js';

/** Single label for requests that never matched an Express route. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Resolve the Prometheus `route` label from the matched Express route template.
 *
 * Uses `baseUrl + route.path` (the pattern, e.g. `/users/:id`) so path
 * parameters never appear as distinct series. Unmatched requests share one
 * fixed label to keep cardinality bounded.

/**
 * Resolve the Prometheus `route` label from the matched Express route template.
 *
 * Unmatched requests use one fixed label so arbitrary paths cannot create
 * unbounded Prometheus series.
 */
export function resolveRoute(req: Request): string {
  if (!req.route?.path) {
    return UNMATCHED_ROUTE;
  }

  const raw = `${req.baseUrl ?? ''}${req.route.path}`;

  // Collapse trailing slash to keep label cardinality predictable,
  // but preserve the bare root path "/".
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
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
