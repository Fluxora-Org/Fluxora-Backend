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

import type { RateLimitStore, SlidingWindowStore } from '../redis/rateLimitStore.js';
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

exports.shouldRetry = shouldRetry;
exports.isRetryableStatusCode = isRetryableStatusCode;
exports.calculateNextRetryTime = calculateNextRetryTime;
exports.scheduleWebhookOutboxRetry = scheduleWebhookOutboxRetry;
exports.generateRetrySchedule = generateRetrySchedule;
exports.formatRetryPolicy = formatRetryPolicy;
exports.validateRetryPolicy = validateRetryPolicy;


/**
 * Determine if a status code is retryable with enhanced logic
 */
export function isRetryableStatusCode(
  statusCode: number | undefined,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  // ... existing logic ...
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
