/**
 * Metrics for the requestProtection middleware.
 *
 * Exports prom-client Counters that track request refusals from various
 * protection mechanisms: body size limits, JSON depth validation, and rate limiting.
 *
 * Labels:
 *   `path` — normalized route template (e.g. `/api/streams`), derived from
 *             `req.route?.path ?? req.path`. Raw `req.originalUrl` is intentionally
 *             avoided to prevent high-cardinality / user-data leakage in the label set.
 *   `reason` — the specific protection mechanism that refused the request:
 *               `body_too_large`, `json_depth_exceeded`, `rate_limit_exceeded`
 *
 * @module metrics/requestProtectionMetrics
 *
 * @security
 * - The `path` label uses the route template, not the raw URL, to prevent
 *   path parameters (e.g. stream IDs, Stellar addresses) or query strings from
 *   appearing in metric label values (cardinality explosion / data leakage).
 * - The `reason` label has bounded cardinality (3 possible values).
 *
 * Usage — alert example (PromQL):
 *   increase(fluxora_request_refused_total[5m]) > 50
 */

import { Counter, Gauge } from 'prom-client';
import { registry } from '../metrics.js';
import { assertCollectorLabels } from './cardinality.js';

/**
 * Counter incremented once for every request refused by protection mechanisms.
 * Labelled by `path` (route template) and `reason` (protection type).
 *
 * Reason values:
 *   - `body_too_large`: Request body exceeded configured size limit (HTTP 413)
 *   - `json_depth_exceeded`: JSON nesting depth exceeded maximum (HTTP 400)
 *   - `rate_limit_exceeded`: Rate limit quota exceeded (HTTP 429)
 *
 * @example
 * // Alert on DoS probes — fire when more than 50 requests are refused
 * // within a 5-minute window on any single route.
 * increase(fluxora_request_refused_total[5m]) > 50
 *
 * @example
 * // Alert specifically on rate limit spikes
 * increase(fluxora_request_refused_total{reason="rate_limit_exceeded"}[5m]) > 100
 *
 * @example
 * // Alert on body size limit violations (potential DoS)
 * increase(fluxora_request_refused_total{reason="body_too_large"}[5m]) > 20
 */
assertCollectorLabels(['path']);
assertCollectorLabels(['reason']);

export const requestRefusedTotal =
  (registry.getSingleMetric('fluxora_request_refused_total') as Counter<'path' | 'reason'>) ||
  new Counter({
    name: 'fluxora_request_refused_total',
    help: 'Total number of requests refused by protection mechanisms, labeled by normalized route path and refusal reason',
    labelNames: ['path', 'reason'] as const,
    registers: [registry],
  });

/**
 * Counter incremented once for every HTTP 413 rejection produced by
 * `bodySizeLimitMiddleware`. Labelled by `path` (route template).
 *
 * @deprecated Use requestRefusedTotal with reason='body_too_large' instead.
 * Kept for backward compatibility.
 */
assertCollectorLabels(['path']);

export const requestBodyTooLargeTotal =
  (registry.getSingleMetric('fluxora_request_body_too_large_total') as Counter<'path'>) ||
  new Counter({
    name: 'fluxora_request_body_too_large_total',
    help: 'Total number of requests rejected with HTTP 413 due to body size exceeding the configured limit, labeled by normalized route path',
    labelNames: ['path'] as const,
    registers: [registry],
  });

/**
 * Token-bucket fill level for the webhook outbound rate limiter.
 *
 * A Gauge per consumer endpoint that shows how many tokens remain in the
 * bucket. When the gauge approaches 0 the consumer is being throttled;
 * when it stays near the configured burst maximum the consumer is idle.
 *
 * Label:
 *   `consumer_hash` — SHA-256 prefix of the consumer endpoint URL (16 hex chars).
 *     Hashed to bound label-cardinality and avoid leaking endpoint URLs.
 *
 * @security
 * - The `consumer_hash` label is a one-way hash of the URL, not the raw URL,
 *   preventing endpoint URLs (which could contain private IPs or internal
 *   service names) from appearing in metric label values.
 */
export const webhookRateLimiterBucketFill =
  (registry.getSingleMetric('fluxora_webhook_rate_limiter_bucket_fill') as Gauge<'consumer_hash'>) ||
  new Gauge({
    name: 'fluxora_webhook_rate_limiter_bucket_fill',
    help: 'Current token-bucket fill level for outbound webhook rate limiter, labeled by consumer hash',
    labelNames: ['consumer_hash'] as const,
    registers: [registry],
  });

/**
 * Update the bucket-fill gauge for a given consumer.
 *
 * @param consumerHash - SHA-256 prefix of the consumer endpoint URL.
 * @param fillLevel    - Current number of tokens in the bucket (may be fractional).
 */
export function updateWebhookBucketFill(consumerHash: string, fillLevel: number): void {
  webhookRateLimiterBucketFill.set({ consumer_hash: consumerHash }, fillLevel);
}

/**
 * De-register the counters. Intended only for test teardown — do not call in
 * production code as it cannot be safely re-registered without restarting the
 * process.
 */
export function deRegisterRequestProtectionMetrics(): void {
  registry.removeSingleMetric('fluxora_request_refused_total');
  registry.removeSingleMetric('fluxora_request_body_too_large_total');
  registry.removeSingleMetric('fluxora_webhook_rate_limiter_bucket_fill');
}
