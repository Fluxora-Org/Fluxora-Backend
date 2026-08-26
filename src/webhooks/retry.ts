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

import type { IWebhookRateLimiter, RateLimitConfig } from '../redis/webhookRateLimit.js';
import type {
  CircuitBreakerPolicy,
  WebhookCircuitBreakerCheckResult,
  WebhookCircuitBreakerStore,
} from '../redis/webhookCircuitBreakerStore.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import type { WebhookDeliveryAttempt, WebhookRetryPolicy } from './types.js';

export interface EnhancedRetryPolicy extends WebhookRetryPolicy {
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
  consumerUrl?: string;
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

import { calculateNextRetryDelay } from '../lib/retry.js';

/** Determine if a status code is retryable with enhanced logic. */
/**
 * Determine whether an HTTP status code should trigger a retry.
 *
 * Retryable classes (transient failures safe to retry):
 *   - `undefined`   — no status code, i.e. a network error or timeout
 *   - `408`         — Request Timeout
 *   - `425`         — Too Early
 *   - `429`         — Too Many Requests (rate-limited by consumer)
 *   - `500`         — Internal Server Error
 *   - `502`         — Bad Gateway
 *   - `503`         — Service Unavailable
 *   - `504`         — Gateway Timeout
 *
 * Non-retryable classes (permanent failures; retrying would waste resources
 * and could amplify load on a misconfigured or auth-rejecting consumer):
 *   - `4xx` auth/validation codes (400, 401, 403, 404, 422, …)
 *   - `2xx` / `3xx` — delivery succeeded or was redirected
 *
 * The set is configurable via `policy.retryableStatusCodes` so operators can
 * tune it per-consumer without code changes.
 */
export function isRetryableStatusCode(
  statusCode: number | undefined,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY
): boolean {
  if (statusCode === undefined) return true;
  return policy.retryableStatusCodes.includes(statusCode);
}

/**
 * Calculate the absolute timestamp (ms since epoch) at which the next retry
 * should be attempted, or 0 if the attempt number has reached maxAttempts.
 */
export function calculateNextRetryTime(
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): number {
  if (attemptNumber >= policy.maxAttempts) return 0;
  const delayMs = calculateNextRetryDelay(attemptNumber, {
    baseDelayMs: policy.initialBackoffMs,
    maxDelayMs: policy.maxBackoffMs,
    maxAttempts: policy.maxAttempts,
  });
  return now + delayMs;
}

/**
 * Generate the full retry schedule for a policy — one entry per attempt.
 */
export function generateRetrySchedule(
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now(),
): RetrySchedule[] {
  return Array.from({ length: policy.maxAttempts }, (_, i) => {
    const delayMs = calculateNextRetryDelay(i, {
      baseDelayMs: policy.initialBackoffMs,
      maxDelayMs: policy.maxBackoffMs,
      maxAttempts: policy.maxAttempts,
    });
    return { attemptNumber: i + 1, delayMs, retryAt: now + delayMs };
  });
}

/** Attach retry metadata to an outbox payload and return the next retry time. */
export function scheduleWebhookOutboxRetry(input: WebhookOutboxRetryInput): WebhookOutboxRetryPlan {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  const nextAttemptNumber = input.attemptNumber + 1;

  if (nextAttemptNumber > policy.maxAttempts) {
    return {
      shouldRetry: false,
      attemptNumber: input.attemptNumber,
      retryAt: null,
      payload: input.payload,
    };
  }

  const payload =
    typeof input.payload === 'object' && input.payload !== null && !Array.isArray(input.payload)
      ? {
          ...(input.payload as Record<string, unknown>),
          _webhookRetry: { attemptNumber: nextAttemptNumber },
        }
      : { _webhookRetry: { attemptNumber: nextAttemptNumber } };

  return {
    shouldRetry: true,
    attemptNumber: nextAttemptNumber,
    retryAt: new Date(calculateNextRetryTime(input.attemptNumber, policy, input.now)),
    payload,
  };
}

/** Return true if another delivery attempt should be made. */
export function shouldRetry(
  attempt: WebhookDeliveryAttempt,
  attemptNumber: number,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  consecutiveFailures: number = 0
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
  createdAt: number = Date.now()
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
  now: number = Date.now()
): number {
  return policy.circuitBreakerResetMs ? now + policy.circuitBreakerResetMs : 0;
}

/** Short backoff when another instance holds the half-open probe lock. */
export const HALF_OPEN_CONTENTION_DEFERRAL_MS = 1_000;

/**
 * Resolve when a gated delivery should be retried.
 * Half-open contention uses a short deferral so outbox rows are never dropped.
 */
export function resolveCircuitBreakerDeferral(
  breaker: Pick<WebhookCircuitBreakerCheckResult, 'state' | 'resetAt'>,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  now: number = Date.now()
): Date {
  if (breaker.resetAt !== null && breaker.resetAt > now) {
    return new Date(breaker.resetAt);
  }
  if (breaker.state === 'half-open') {
    return new Date(now + HALF_OPEN_CONTENTION_DEFERRAL_MS);
  }
  const resetAt = calculateCircuitBreakerResetTime(policy, now);
  return new Date(Math.max(resetAt, now + HALF_OPEN_CONTENTION_DEFERRAL_MS));
}

/** Return true when a failed attempt should increment the circuit-breaker failure count. */
export function countsTowardCircuitBreaker(
  attempt: WebhookDeliveryAttempt,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY
): boolean {
  if (
    attempt.statusCode !== undefined &&
    attempt.statusCode >= 200 &&
    attempt.statusCode < 300 &&
    !attempt.error
  ) {
    return false;
  }
  if (attempt.statusCode === undefined) return true;
  return isRetryableStatusCode(attempt.statusCode, policy);
}

/** Return a human-readable summary of the retry policy (for logging). */
export function formatRetryPolicy(policy: EnhancedRetryPolicy): string {
  const base =
    `max_attempts=${policy.maxAttempts}, initial_backoff=${policy.initialBackoffMs}ms, ` +
    `multiplier=${policy.backoffMultiplier}x, max_backoff=${policy.maxBackoffMs}ms, ` +
    `jitter=decorrelated, timeout=${policy.timeoutMs}ms`;

  const extras: string[] = [];
  if (policy.deadLetterAfterMs) extras.push(`dlq_after=${policy.deadLetterAfterMs}ms`);
  if (policy.circuitBreakerThreshold)
    extras.push(`circuit_breaker=${policy.circuitBreakerThreshold}`);

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
  if (policy.timeoutMs < 1000) errors.push('timeoutMs must be at least 1000ms');
  if (policy.deadLetterAfterMs && policy.deadLetterAfterMs < 60000)
    errors.push('deadLetterAfterMs must be at least 60000ms (1 minute)');

  return errors;
}

export interface WebhookDeliveryGateDeps {
  rateLimiter?: IWebhookRateLimiter;
  circuitBreakerStore?: WebhookCircuitBreakerStore;
  rateLimitConfig?: RateLimitConfig;
}

export interface WebhookDeliveryGateResult {
  canDeliver: boolean;
  retryAt: Date | null;
  rateLimited?: boolean;
  circuitBreakerOpen?: boolean;
  consecutiveFailures: number;
}

function augmentPayloadWithRetry(payload: unknown, attemptNumber: number): unknown {
  const base: Record<string, unknown> =
    typeof payload === 'object' && payload !== null
      ? { ...(payload as Record<string, unknown>) }
      : { value: payload };
  base['_webhookRetry'] = { attemptNumber };
  return base;
}

/**
 * Evaluate rate-limit and circuit-breaker gates before an outbound webhook attempt.
 */
export async function checkWebhookDeliveryGate(
  consumerUrl: string,
  policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
  deps: WebhookDeliveryGateDeps = {},
  now: number = Date.now()
): Promise<WebhookDeliveryGateResult> {
  const circuitBreakerStore = deps.circuitBreakerStore ?? getWebhookCircuitBreakerStore();

  const breaker = await circuitBreakerStore.checkAndClaimAttempt(consumerUrl, policy, now);
  if (!breaker.allowed) {
    return {
      canDeliver: false,
      retryAt: resolveCircuitBreakerDeferral(breaker, policy, now),
      circuitBreakerOpen: breaker.state === 'open' || breaker.state === 'half-open',
      consecutiveFailures: breaker.consecutiveFailures,
    };
  }

  if (deps.rateLimiter && deps.rateLimitConfig) {
    const limit = await deps.rateLimiter.checkLimit(consumerUrl, deps.rateLimitConfig);
    if (!limit.canAttempt) {
      return {
        canDeliver: false,
        retryAt: new Date(now + (limit.retryAfterMs ?? deps.rateLimitConfig.windowMs)),
        rateLimited: true,
        consecutiveFailures: breaker.consecutiveFailures,
      };
    }
  }

  return {
    canDeliver: true,
    retryAt: null,
    consecutiveFailures: breaker.consecutiveFailures,
  };
}

/**
 * Wrap a webhook delivery with per-consumer rate limiting and circuit-breaker protection.
 */
export async function attemptWebhookDeliveryWithRateLimit(
  input: WebhookOutboxRetryInput,
  deliver: () => Promise<WebhookDeliveryAttempt>,
  deps: WebhookDeliveryGateDeps = {}
): Promise<WebhookOutboxRetryPlan & { attempt?: WebhookDeliveryAttempt }> {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  const now = input.now ?? Date.now();
  // consumerUrl is optional on the input but is the rate-limit and
  // circuit-breaker key; fall back to the stream id so callers that omit it
  // still get per-stream isolation rather than a shared global bucket.
  const consumerKey = input.consumerUrl ?? input.streamId;
  const gate = await checkWebhookDeliveryGate(consumerKey, policy, deps, now);

  if (!gate.canDeliver) {
    return {
      shouldRetry: true,
      attemptNumber: input.attemptNumber + 1,
      retryAt: gate.retryAt,
      payload: input.payload,
      rateLimited: gate.rateLimited,
    };
  }

  const attempt = await deliver();
  const circuitBreakerStore = deps.circuitBreakerStore ?? getWebhookCircuitBreakerStore();
  const success =
    attempt.statusCode !== undefined &&
    attempt.statusCode >= 200 &&
    attempt.statusCode < 300 &&
    !attempt.error;

  let consecutiveFailures = gate.consecutiveFailures;
  if (success) {
    const breakerRecord = await circuitBreakerStore.recordSuccess(
      consumerKey,
      policy as CircuitBreakerPolicy
    );
    consecutiveFailures = breakerRecord.consecutiveFailures;
  } else if (countsTowardCircuitBreaker(attempt, policy)) {
    const breakerRecord = await circuitBreakerStore.recordFailure(
      consumerKey,
      policy as CircuitBreakerPolicy,
      now
    );
    consecutiveFailures = breakerRecord.consecutiveFailures;
  }

  const retryable = shouldRetry(attempt, input.attemptNumber, policy, consecutiveFailures);
  if (!retryable) {
    return {
      shouldRetry: false,
      attemptNumber: input.attemptNumber + 1,
      retryAt: null,
      payload: input.payload,
      attempt,
    };
  }

  const retryAtMs = calculateNextRetryTime(input.attemptNumber, policy, now);

  return {
    shouldRetry: true,
    attemptNumber: input.attemptNumber + 1,
    retryAt: new Date(retryAtMs),
    payload: augmentPayloadWithRetry(input.payload, input.attemptNumber + 1),
    attempt,
  };
}
