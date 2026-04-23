/**
 * Enhanced webhook retry policy and backoff calculation
 * Supports multiple backoff strategies and jitter algorithms
 */

import type { WebhookRetryPolicy, WebhookDeliveryAttempt } from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

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

/**
 * Calculate backoff delay based on strategy and algorithm
 */
export function calculateBackoffDelay(
  attemptNumber: number,
  policy: EnhancedRetryPolicy,
): number {
  const { backoffStrategy = 'exponential', initialBackoffMs, backoffMultiplier, maxBackoffMs } = policy;
  
  let baseDelay: number;
  
  switch (backoffStrategy) {
    case 'linear':
      baseDelay = initialBackoffMs + (attemptNumber * initialBackoffMs);
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

/**
 * Apply jitter to delay based on algorithm
 */
export function applyJitter(
  delayMs: number,
  policy: EnhancedRetryPolicy,
): number {
  const { jitterPercent = 10, jitterAlgorithm = 'full' } = policy;
  const jitterRange = delayMs * (jitterPercent / 100);
  
  switch (jitterAlgorithm) {
    case 'equal':
      // Equal jitter: delay/2 + random(0, delay/2)
      const halfDelay = delayMs / 2;
      return halfDelay + Math.random() * halfDelay;
      
    case 'decorrelated':
      // Decorrelated jitter: random(0, delay * 3)
      return Math.random() * (delayMs * 3);
      
    case 'full':
    default:
      // Full jitter: random(0, delay)
      const jitter = Math.random() * jitterRange;
      return Math.max(0, delayMs - jitterRange/2 + jitter);
  }
}

/**
 * Calculate the next retry time with enhanced backoff and jitter
 */
export function calculateNextRetryTime(
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): number {
  if (attemptNumber >= policy.maxAttempts) {
    return 0; // No more retries
  }

  const baseDelay = calculateBackoffDelay(attemptNumber, policy);
  const jitteredDelay = applyJitter(baseDelay, policy);
  
  return now + jitteredDelay;
}

/**
 * Generate full retry schedule for a delivery
 */
export function generateRetrySchedule(
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): RetrySchedule[] {
  const schedule: RetrySchedule[] = [];
  
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const delayMs = calculateBackoffDelay(attempt - 1, policy);
    const jitteredDelay = applyJitter(delayMs, policy);
    
    schedule.push({
      attemptNumber: attempt,
      delayMs: jitteredDelay,
      retryAt: now + jitteredDelay,
    });
  }
  
  return schedule;
}

/**
 * Determine if a status code is retryable with enhanced logic
 */
export function isRetryableStatusCode(
  statusCode: number | undefined,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (statusCode === undefined) {
    return true; // Network errors are retryable
  }
  
  // Check if status code is in retryable list
  if (policy.retryableStatusCodes.includes(statusCode)) {
    return true;
  }
  
  // Additional retryable conditions
  switch (statusCode) {
    case 408: // Request Timeout
    case 429: // Too Many Requests
    case 500: // Internal Server Error
    case 502: // Bad Gateway
    case 503: // Service Unavailable
    case 504: // Gateway Timeout
      return true;
      
    case 413: // Payload Too Large
    case 414: // URI Too Long
    case 431: // Request Header Fields Too Large
      return false; // These are unlikely to be fixed by retrying
      
    default:
      // 4xx errors (except specific ones above) are not retryable
      return statusCode >= 500;
  }
}

/**
 * Enhanced retry decision logic with circuit breaker consideration
 */
export function shouldRetry(
  attempt: WebhookDeliveryAttempt,
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  consecutiveFailures: number = 0,
): boolean {
  // Don't retry if we've exhausted attempts
  if (attemptNumber >= policy.maxAttempts) {
    return false;
  }

  // Circuit breaker logic
  if (policy.circuitBreakerThreshold && consecutiveFailures >= policy.circuitBreakerThreshold) {
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
 * Check if delivery should be sent to dead-letter queue
 */
export function shouldSendToDLQ(
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  createdAt: number = Date.now(),
): boolean {
  // Send to DLQ if max attempts exceeded
  if (attemptNumber >= policy.maxAttempts) {
    return true;
  }
  
  // Send to DLQ if too old (optional)
  if (policy.deadLetterAfterMs) {
    const age = Date.now() - createdAt;
    if (age > policy.deadLetterAfterMs) {
      return true;
    }
  }
  
  return false;
}

/**
 * Calculate circuit breaker reset time
 */
export function calculateCircuitBreakerResetTime(
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): number {
  if (!policy.circuitBreakerResetMs) {
    return 0;
  }
  
  return now + policy.circuitBreakerResetMs;
}

/**
 * Format enhanced retry policy for logging/debugging
 */
export function formatRetryPolicy(policy: EnhancedRetryPolicy): string {
  const base = `max_attempts=${policy.maxAttempts}, initial_backoff=${policy.initialBackoffMs}ms, ` +
    `multiplier=${policy.backoffMultiplier}x, max_backoff=${policy.maxBackoffMs}ms, ` +
    `jitter=${policy.jitterPercent}%, timeout=${policy.timeoutMs}ms`;
  
  const enhanced = [];
  if (policy.backoffStrategy) enhanced.push(`strategy=${policy.backoffStrategy}`);
  if (policy.jitterAlgorithm) enhanced.push(`jitter=${policy.jitterAlgorithm}`);
  if (policy.deadLetterAfterMs) enhanced.push(`dlq_after=${policy.deadLetterAfterMs}ms`);
  if (policy.circuitBreakerThreshold) enhanced.push(`circuit_breaker=${policy.circuitBreakerThreshold}`);
  
  return enhanced.length > 0 ? `${base}, ${enhanced.join(', ')}` : base;
}

/**
 * Validate retry policy configuration
 */
export function validateRetryPolicy(policy: EnhancedRetryPolicy): string[] {
  const errors: string[] = [];
  
  if (policy.maxAttempts < 1) {
    errors.push('maxAttempts must be at least 1');
  }
  
  if (policy.initialBackoffMs < 100) {
    errors.push('initialBackoffMs must be at least 100ms');
  }
  
  if (policy.backoffMultiplier < 1) {
    errors.push('backoffMultiplier must be at least 1');
  }
  
  if (policy.maxBackoffMs < policy.initialBackoffMs) {
    errors.push('maxBackoffMs must be greater than initialBackoffMs');
  }
  
  if (policy.jitterPercent < 0 || policy.jitterPercent > 100) {
    errors.push('jitterPercent must be between 0 and 100');
  }
  
  if (policy.timeoutMs < 1000) {
    errors.push('timeoutMs must be at least 1000ms');
  }
  
  if (policy.deadLetterAfterMs && policy.deadLetterAfterMs < 60000) {
    errors.push('deadLetterAfterMs must be at least 60000ms (1 minute)');
  }
  
  return errors;
}
