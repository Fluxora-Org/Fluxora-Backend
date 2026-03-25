import type { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../metrics.js';

/**
 * Normalise the matched route so cardinality stays bounded.
 * Falls back to the raw path only when no Express route was matched,
 * which keeps the label set predictable for Prometheus.
 */
function resolveRoute(req: Request): string {
  const raw = req.route?.path
    ? `${req.baseUrl}${req.route.path}`
    : req.originalUrl.split('?')[0];

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
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });

  next();
}
