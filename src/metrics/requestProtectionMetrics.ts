/**
 * Metrics for the requestProtection middleware.
 *
 * Exports prom-client Counters that are incremented whenever the request
 * protection middleware refuses a request:
 *   - `bodySizeLimitMiddleware` → HTTP 413 (Payload Too Large)
 *   - `jsonDepthLimitMiddleware` / `jsonDepthMiddleware` → HTTP 400 (too deeply nested)
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

/**
 * Typed error thrown when a metric mutation function receives invalid
 * input. The `field` property lets the caller tell which argument was rejected
 * and the `code` property identifies the kind of validation failure.
 */
export type InvalidMetricInputCode =
  |'wrong_type'
  | 'empty_value'
  | 'too_long'
  | 'not_finite'
  | 'negative';

export class InvalidMetricInputError extends Error {
  public readonly code: InvalidMetricInputCode;
  public readonly field: string;

  constructor(code: InvalidMetricInputCode, field: string, message: string) {
    super(message);
    this.name = 'InvalidMetricInputError';
    this.code = code;
    this.field = field;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Maximum accepted length for the `consumerHash` label. */
const MAX_CONSUMER_HASH_LENGTH = 256;

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
export const requestRefusedTotal =
  (registry.getSingleMetric('fluxora_request_refused_total') as Counter<'path' | 'reason'>) ||
  new Counter( {
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

/**
 * Counter incremented once for every HTTP 400 rejection caused by JSON nesting
 * exceeding the configured depth limit. Labelled by `path` (route template).
 *
 * @example
 * // Alert on nesting-bomb probes.
 * increase(fluxora_request_body_too_deep_total[5m]) > 20
 */

export const requestBodyTooLargeTotal =
  (registry.getSingleMetric('fluxora_request_body_too_large_total') as Counter<'path'>) ||
  new Counter({
    name: 'fluxora_request_body_too_large_total',
    help: 'Total number of requests rejected with HTTP 413 due to body size exceeding the configured limit, labeled by normalized route path',
    labelNames: ['path'] as const,
    registers: [registry],
  });

export const requestBodyTooDeepTotal =
  (registry.getSingleMetric('fluxora_request_body_too_deep_total') as Counter<'path'>) ||
  new Counter(  {
    name: 'fluxora_request_body_too_deep_total',
    help: 'Total number of requests rejected with HTTP 400 because the JSON body nesting depth exceeded the configured limit, labeled by normalized route path',
    labelNames: ['path'] as const,
    registers: [registry],
  });

/**
 * Token-bucket fill level for the webhook outbound rate limiter.
 *
 * An Gauge per consumer endpoint that shows how many tokens remain in the
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
  (registry.getSingleMetric('fluxora_webhook_rate_limiter_bucket_fill') as Gauge<'consumer_hash'>)  ||
  new Gauge({
    name: 'fluxora_webhook_rate_limiter_bucket_fill',
    help: 'Current token-bucket fill level for outbound webhook rate limiter, labeled by consumer hash',
    labelNames: ['consumer_hash'] as const,
    registers: [registry],
  });

/**
 * Update the bucket-fill gauge for a given consumer.
 *
 * Validates inputs before touching the prom-client registry so that a
 * malformed, empty or oversized value cannot corrupt the metric state.
 *
 * @throws {InvalidMetricInputError} when `consumerHash` or `fillLevel` is invalid.
 *
 * @param consumerHash - SHA-256 prefix of the consumer endpoint URL.
 * @param fillLevel    - Current number of tokens in the bucket (may be fractional).
 */
export function updateWebhookBucketFill(consumerHash: string, fillLevel: number): void {
  if (typeof consumerHash !== 'string') {
    throw new InvalidMetricInputError(
      'wrong_type',
      'consumerHash',
      'consumerHash must be a string',
    );
  }
  if (consumerHash.trim().length === 0) {
    throw new InvalidMetricInputError(
      'empty_value',
      'consumerHash',
      'consumerHash must be a non-empty string',
    );
  }
  if (consumerHash.length > MAX_CONSUMER_HASH_LENGTH) {
    throw new InvalidMetricInputError(
      'too_long',
      'consumerHash',
      `consumerHash must be at most ${MAX_CONSUMER_HASH_LENGTH} characters`,
    );
  }
  if (typeof fillLevel !== 'number' || !Number.isFinite(fillLevel)) {
    throw new InvalidMetricInputError(
      'not_finite',
      'fillLevel',
      'fillLevel must be a finite number',
    );
  }
  if (fillLevel < 0) {
    throw new InvalidMetricInputError(
      'negative',
      'fillLevel',
      'fillLevel must be non-negative',
    );
  }
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
  registry.removeSingleMetric('fluxora_request_body_too_deep_total');
  registry.removeSingleMetric('fluxora_webhook_rate_limiter_bucket_fill');
}