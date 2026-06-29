/**
 * Metrics for the requestProtection middleware.
 *
 * Exports a prom-client Counter that is incremented whenever the
 * `bodySizeLimitMiddleware` rejects a request with HTTP 413 (Payload Too Large).
 *
 * Label:
 *   `path` — normalized route template (e.g. `/api/streams`), derived from
 *             `req.route?.path ?? req.path`. Raw `req.originalUrl` is intentionally
 *             avoided to prevent high-cardinality / user-data leakage in the label set.
 *
 * @module metrics/requestProtectionMetrics
 *
 * @security
 * - The `path` label uses the route template, not the raw URL, to prevent
 *   path parameters (e.g. stream IDs, Stellar addresses) or query strings from
 *   appearing in metric label values (cardinality explosion / data leakage).
 *
 * Usage — alert example (PromQL):
 *   increase(fluxora_request_body_too_large_total[5m]) > 50
 */

import { Counter } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Counter incremented once for every HTTP 413 rejection produced by
 * `bodySizeLimitMiddleware`. Labelled by `path` (route template).
 *
 * @example
 * // Alert on DoS probes — fire when more than 50 oversized payloads
 * // arrive within a 5-minute window on any single route.
 * increase(fluxora_request_body_too_large_total[5m]) > 50
 */
export const requestBodyTooLargeTotal =
  (registry.getSingleMetric('fluxora_request_body_too_large_total') as Counter<'path'>) ||
  new Counter({
    name: 'fluxora_request_body_too_large_total',
    help: 'Total number of requests rejected with HTTP 413 due to body size exceeding the configured limit, labeled by normalized route path',
    labelNames: ['path'] as const,
    registers: [registry],
  });

/**
 * De-register the counter. Intended only for test teardown — do not call in
 * production code as it cannot be safely re-registered without restarting the
 * process.
 */
export function deRegisterRequestProtectionMetrics(): void {
  registry.removeSingleMetric('fluxora_request_body_too_large_total');
}
