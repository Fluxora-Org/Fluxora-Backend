/**
 * Webhook retry policy and backoff calculation
 */

import type { WebhookRetryPolicy, WebhookDeliveryAttempt } from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

/**
 * Calculate the next retry time based on attempt number and policy
 */
export function calculateNextRetryTime(
  attemptNumber: number,
  policy: WebhookRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): number {
  if (attemptNumber >= policy.maxAttempts) {
    return 0; // No more retries
  }

  // Exponential backoff: initialBackoff * (multiplier ^ attemptNumber)
  const exponentialBackoff = policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, attemptNumber);
  const cappedBackoff = Math.min(exponentialBackoff, policy.maxBackoffMs);

  // Add jitter: ±jitterPercent
  const jitterRange = cappedBackoff * (policy.jitterPercent / 100);
  const jitter = (Math.random() - 0.5) * 2 * jitterRange;
  const backoffWithJitter = Math.max(0, cappedBackoff + jitter);

  return now + backoffWithJitter;
}

/**
 * Determine if a status code is retryable
 */
export function isRetryableStatusCode(
  statusCode: number | undefined,
  policy: WebhookRetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (statusCode === undefined) {
    return true; // Network errors are retryable
  }
  return policy.retryableStatusCodes.includes(statusCode);
}

/**
 * Determine if a delivery should be retried
 */
export function shouldRetry(
  attempt: WebhookDeliveryAttempt,
  attemptNumber: number,
  policy: WebhookRetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  // Don't retry if we've exhausted attempts
  if (attemptNumber >= policy.maxAttempts) {
    return false;
  }

  // Retry on network errors (no statusCode)
  if (attempt.statusCode === undefined) {
    return true;
  }

  // Retry on specific status codes
  return isRetryableStatusCode(attempt.statusCode, policy);
}

/**
 * Format retry policy for logging/debugging
 */
export function formatRetryPolicy(policy: WebhookRetryPolicy): string {
  return `max_attempts=${policy.maxAttempts}, initial_backoff=${policy.initialBackoffMs}ms, ` +
    `multiplier=${policy.backoffMultiplier}x, max_backoff=${policy.maxBackoffMs}ms, ` +
    `jitter=${policy.jitterPercent}%, timeout=${policy.timeoutMs}ms`;
}
