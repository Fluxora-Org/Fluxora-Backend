/**
 * Enhanced webhook retry policy and backoff calculation.
 * Supports multiple backoff strategies and jitter algorithms.
 *
 * Rate-limiting integration:
 * `attemptWebhookDeliveryWithRateLimit` wraps every outbound delivery attempt
 * with a per-consumer-URL sliding-window check. When the limit is exceeded the
 * attempt is deferred (re-enqueued with a penalty delay) rather than dropped,
 * so no delivery is silently lost.
 */

import { WebhookRateLimiter, RateLimitConfig } from '../redis/webhookRateLimit.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import type { WebhookDeliveryAttempt, WebhookRetryPolicy } from './types.js';

export type BackoffStrategy = 'exponential' | 'linear' | 'fixed';
export type JitterAlgorithm = 'full' | 'equal' | 'decorrelated';

export interface EnhancedRetryPolicy extends WebhookRetryPolicy {
  backoffStrategy?: BackoffStrategy;
  jitterAlgorithm?: JitterAlgorithm;
  deadLetterAfterMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

export interface RetrySchedule {
  attemptNumber: number;
  delayMs: number;
  retryAt: number;
}

export interface WebhookOutboxRetryInput {
  /** The actual consumer endpoint URL — used as the rate-limit key. */
  consumerUrl: string;
  streamId: string;
  eventType: string;
  payload: unknown;
  attemptNumber: number;
  policy?: EnhancedRetryPolicy;
  now?: number;
}

export interface WebhookOutboxRetryPlan {
  shouldRetry: boolean;
  attemptNumber: number;
  retryAt: Date | null;
  payload: unknown;
  /** True when the attempt was deferred due to rate limiting. */
  rateLimited?: boolean;
}

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

/** Calculate raw backoff delay (before jitter) for a given attempt number. */
export function calculateBackoffDelay(
  attemptNumber: number,
  policy: EnhancedRetryPolicy,
): number {
  const { backoffStrategy = 'exponential', initialBackoffMs, backoffMultiplier, maxBackoffMs } = policy;

  let baseDelay: number;
  switch (backoffStrategy) {
    case 'linear':
      baseDelay = initialBackoffMs + attemptNumber * initialBackoffMs;
      break;
    case 'fixed':
      baseDelay = initialBackoffMs;
      break;
    case 'exponential':
    default:
      baseDelay = initialBackoffMs * Math.pow(backoffMultiplier, attemptNumber);
      break;
  }

  return Math.min(baseDelay, maxBackoffMs);
}

/** Apply jitter to a delay value. */
export function applyJitter(delayMs: number, policy: EnhancedRetryPolicy): number {
  const { jitterPercent = 10, jitterAlgorithm = 'full' } = policy;
  const jitterRange = delayMs * (jitterPercent / 100);

  switch (jitterAlgorithm) {
    case 'equal': {
      const half = delayMs / 2;
      return half + Math.random() * half;
    }
    case 'decorrelated':
      return Math.random() * delayMs * 3;
    case 'full':
    default:
      return Math.max(0, delayMs - jitterRange / 2 + Math.random() * jitterRange);
  }
}

/**
 * Calculate the absolute timestamp (ms) at which the next retry should fire.
 * Returns 0 when the attempt number has reached or exceeded maxAttempts.
 */
export function calculateNextRetryTime(
  attemptNumber: number,
  policy: WebhookRetryPolicy,
  now: number = Date.now(),
): number {
  if (attemptNumber >= policy.maxAttempts) return 0;

  const enhanced = policy as EnhancedRetryPolicy;
  const baseDelay = calculateBackoffDelay(attemptNumber, {
    ...DEFAULT_RETRY_POLICY,
    ...enhanced,
  });
  const jittered = applyJitter(baseDelay, { ...DEFAULT_RETRY_POLICY, ...enhanced });
  return now + jittered;
}

// ---------------------------------------------------------------------------
// Rate-limited delivery attempt
// ---------------------------------------------------------------------------

/**
 * Wrap a webhook delivery attempt with a per-consumer-URL rate-limit check.
 *
 * - If the consumer is within its rate limit the normal retry schedule is
 *   returned and the attempt is recorded in Redis.
 * - If the limit is exceeded the attempt is deferred: `shouldRetry` is true,
 *   `rateLimited` is true, and `retryAt` is set to `now + retryAfterMs` so
 *   the outbox row is re-enqueued durably rather than dropped.
 *
 * Redis unavailability is fail-open: the attempt proceeds normally so a Redis
 * outage does not silently halt all webhook deliveries.
 *
 * @param input          - Retry context including the consumer endpoint URL.
 * @param rateLimiter    - Sliding-window rate limiter backed by Redis.
 * @param rateLimitConfig - `{ limit, windowMs }` — typically derived from
 *                          `WEBHOOK_RETRY_RPS` env var.
 */
export async function attemptWebhookDeliveryWithRateLimit(
  input: WebhookOutboxRetryInput,
  rateLimiter: WebhookRateLimiter,
  rateLimitConfig: RateLimitConfig,
): Promise<WebhookOutboxRetryPlan> {
  const now = input.now ?? Date.now();

  const { canAttempt, retryAfterMs } = await rateLimiter.checkLimit(
    input.consumerUrl,
    rateLimitConfig,
  );

  if (!canAttempt) {
    // Defer: re-enqueue with a penalty delay so the outbox row is durable.
    const penaltyMs = retryAfterMs ?? rateLimitConfig.windowMs;
    return {
      shouldRetry: true,
      attemptNumber: input.attemptNumber,
      retryAt: new Date(now + penaltyMs),
      payload: input.payload,
      rateLimited: true,
    };
  }

  return scheduleWebhookOutboxRetry(input);
}

// ---------------------------------------------------------------------------
// Outbox retry scheduling
// ---------------------------------------------------------------------------

/**
 * Build the durable retry row data for a failed webhook_outbox delivery.
 *
 * The outbox table does not have dedicated retry columns, so retries are
 * represented as a new unprocessed row with `created_at` set to the next due
 * time. The dispatcher only claims rows whose `created_at` is in the past.
 */
export function scheduleWebhookOutboxRetry(
  input: WebhookOutboxRetryInput,
): WebhookOutboxRetryPlan {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  const nextAttemptNumber = input.attemptNumber + 1;

  if (input.attemptNumber >= policy.maxAttempts) {
    return {
      shouldRetry: false,
      attemptNumber: input.attemptNumber,
      retryAt: null,
      payload: input.payload,
    };
  }

  const now = input.now ?? Date.now();
  const retryAt = new Date(calculateNextRetryTime(input.attemptNumber, policy, now));
  const sourcePayload =
    typeof input.payload === 'object' && input.payload !== null
      ? (input.payload as Record<string, unknown>)
      : { data: input.payload };

  return {
    shouldRetry: true,
    attemptNumber: nextAttemptNumber,
    retryAt,
    payload: {
      ...sourcePayload,
      _webhookRetry: {
        attemptNumber: nextAttemptNumber,
        previousAttemptAt: new Date(now).toISOString(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Retry schedule generation
// ---------------------------------------------------------------------------

/** Generate the full retry schedule for a delivery (useful for previewing). */
export function generateRetrySchedule(
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): RetrySchedule[] {
  return Array.from({ length: policy.maxAttempts }, (_, i) => {
    const delayMs = applyJitter(calculateBackoffDelay(i, policy), policy);
    return { attemptNumber: i + 1, delayMs, retryAt: now + delayMs };
  });
}

// ---------------------------------------------------------------------------
// Retry decision helpers
// ---------------------------------------------------------------------------

/** Return true if the HTTP status code warrants a retry. */
export function isRetryableStatusCode(
  statusCode: number | undefined,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (statusCode === undefined) return true; // network error

  if (policy.retryableStatusCodes.includes(statusCode)) return true;

  // Non-retryable payload/header size errors.
  if (statusCode === 413 || statusCode === 414 || statusCode === 431) return false;

  return statusCode >= 500;
}

/** Return true if another delivery attempt should be made. */
export function shouldRetry(
  attempt: WebhookDeliveryAttempt,
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  consecutiveFailures: number = 0,
): boolean {
  if (attemptNumber >= policy.maxAttempts) return false;

  if (policy.circuitBreakerThreshold && consecutiveFailures >= policy.circuitBreakerThreshold) {
    return false;
  }

  if (attempt.statusCode === undefined) return true;

  return isRetryableStatusCode(attempt.statusCode, policy);
}

/** Return true if the delivery should be moved to the dead-letter queue. */
export function shouldSendToDLQ(
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  createdAt: number = Date.now(),
): boolean {
  if (attemptNumber >= policy.maxAttempts) return true;

  if (policy.deadLetterAfterMs && Date.now() - createdAt > policy.deadLetterAfterMs) {
    return true;
  }

  return false;
}

/** Return the absolute timestamp at which the circuit breaker should reset. */
export function calculateCircuitBreakerResetTime(
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): number {
  return policy.circuitBreakerResetMs ? now + policy.circuitBreakerResetMs : 0;
}

/** Return a human-readable summary of the retry policy (for logging). */
export function formatRetryPolicy(policy: EnhancedRetryPolicy): string {
  const base =
    `max_attempts=${policy.maxAttempts}, initial_backoff=${policy.initialBackoffMs}ms, ` +
    `multiplier=${policy.backoffMultiplier}x, max_backoff=${policy.maxBackoffMs}ms, ` +
    `jitter=${policy.jitterPercent}%, timeout=${policy.timeoutMs}ms`;

  const extras: string[] = [];
  if (policy.backoffStrategy) extras.push(`strategy=${policy.backoffStrategy}`);
  if (policy.jitterAlgorithm) extras.push(`jitter=${policy.jitterAlgorithm}`);
  if (policy.deadLetterAfterMs) extras.push(`dlq_after=${policy.deadLetterAfterMs}ms`);
  if (policy.circuitBreakerThreshold) extras.push(`circuit_breaker=${policy.circuitBreakerThreshold}`);

  return extras.length > 0 ? `${base}, ${extras.join(', ')}` : base;
}

/** Return a list of validation errors for the policy, or an empty array if valid. */
export function validateRetryPolicy(policy: EnhancedRetryPolicy): string[] {
  const errors: string[] = [];

  if (policy.maxAttempts < 1) errors.push('maxAttempts must be at least 1');
  if (policy.initialBackoffMs < 100) errors.push('initialBackoffMs must be at least 100ms');
  if (policy.backoffMultiplier < 1) errors.push('backoffMultiplier must be at least 1');
  if (policy.maxBackoffMs < policy.initialBackoffMs)
    errors.push('maxBackoffMs must be greater than initialBackoffMs');
  if (policy.jitterPercent < 0 || policy.jitterPercent > 100)
    errors.push('jitterPercent must be between 0 and 100');
  if (policy.timeoutMs < 1000) errors.push('timeoutMs must be at least 1000ms');
  if (policy.deadLetterAfterMs && policy.deadLetterAfterMs < 60000)
    errors.push('deadLetterAfterMs must be at least 60000ms (1 minute)');

  return errors;
}
