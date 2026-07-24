import { test, expect } from 'vitest';
import {
  calculateNextRetryTime,
  isRetryableStatusCode,
  shouldRetry,
  formatRetryPolicy,
  calculateBackoffDelay,
  applyJitter,
  scheduleWebhookOutboxRetry,
  shouldSendToDLQ,
  validateRetryPolicy,
  generateRetrySchedule,
  resolveCircuitBreakerDeferral,
  countsTowardCircuitBreaker,
  calculateCircuitBreakerResetTime,
  calculateBackoffDelay,
  applyJitter,
} from './retry.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

// node:test → vitest assert-compat shim (see store.test.ts for rationale).
const assert = {
  equal: (actual: unknown, expected: unknown): void => {
    expect(actual).toEqual(expected);
  },
  notEqual: (actual: unknown, expected: unknown): void => {
    expect(actual).not.toEqual(expected);
  },
  deepEqual: (actual: unknown, expected: unknown): void => {
    expect(actual).toEqual(expected);
  },
  ok: (value: unknown, msg?: string): void => {
    expect(value, msg).toBeTruthy();
  },
  match: (value: string, pattern: RegExp): void => {
    expect(value).toMatch(pattern);
  },
};

test('calculateNextRetryTime: exponential backoff with jitter', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterPercent: 0, // No jitter for deterministic test
  };

  // Attempt 0: 1000ms
  const retry0 = calculateNextRetryTime(0, policy, now);
  assert.equal(retry0, now + 1000);

  // Attempt 1: 2000ms
  const retry1 = calculateNextRetryTime(1, policy, now);
  assert.equal(retry1, now + 2000);

  // Attempt 2: 4000ms
  const retry2 = calculateNextRetryTime(2, policy, now);
  assert.equal(retry2, now + 4000);

  // Attempt 3: 8000ms
  const retry3 = calculateNextRetryTime(3, policy, now);
  assert.equal(retry3, now + 8000);

  // Attempt 4: 16000ms
  const retry4 = calculateNextRetryTime(4, policy, now);
  assert.equal(retry4, now + 16000);
});

test('calculateNextRetryTime: respects max backoff', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
    jitterPercent: 0,
    maxAttempts: 10, // Allow more attempts for this test
  };

  // Attempt 5: would be 32000ms, but capped at 10000ms
  const retry5 = calculateNextRetryTime(5, policy, now);
  assert.equal(retry5, now + 10000);
});

test('calculateNextRetryTime: no retry after max attempts', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: 5,
  };

  const retryAfterMax = calculateNextRetryTime(5, policy, now);
  assert.equal(retryAfterMax, 0);
});

test('calculateNextRetryTime: applies jitter within bounds (full jitter)', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterPercent: 10,
    jitterAlgorithm: 'full',
  };

  // Full jitter: [delay - jitterRange/2, delay + jitterRange/2]
  const jitterRange = 1000 * (10 / 100);
  const minExpected = now + 1000 - jitterRange / 2;
  const maxExpected = now + 1000 + jitterRange / 2;

  // Run multiple times to verify jitter stays within bounds
  for (let i = 0; i < 100; i++) {
    const retry = calculateNextRetryTime(0, policy, now);
    assert.ok(
      retry >= minExpected && retry <= maxExpected,
      `Retry ${retry} outside bounds [${minExpected}, ${maxExpected}]`
    );
  }
});

test('applyJitter: full jitter within bounds', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    jitterPercent: 20,
    jitterAlgorithm: 'full',
  };

  const delayMs = 1000;
  const jitterRange = delayMs * (20 / 100);
  const minDelay = delayMs - jitterRange / 2;
  const maxDelay = delayMs + jitterRange / 2;

  for (let i = 0; i < 100; i++) {
    const jittered = applyJitter(delayMs, policy);
    assert.ok(
      jittered >= minDelay && jittered <= maxDelay,
      `Jittered delay ${jittered} outside bounds [${minDelay}, ${maxDelay}]`
    );
  }
});

test('applyJitter: equal jitter within bounds', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    jitterAlgorithm: 'equal',
  };

  const delayMs = 1000;
  const minDelay = delayMs / 2;
  const maxDelay = delayMs;

  for (let i = 0; i < 100; i++) {
    const jittered = applyJitter(delayMs, policy);
    assert.ok(
      jittered >= minDelay && jittered <= maxDelay,
      `Jittered delay ${jittered} outside bounds [${minDelay}, ${maxDelay}]`
    );
  }
});

test('applyJitter: decorrelated jitter within bounds', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    jitterAlgorithm: 'decorrelated',
  };

  const delayMs = 1000;
  const minDelay = 0;
  const maxDelay = delayMs * 3;

  for (let i = 0; i < 100; i++) {
    const jittered = applyJitter(delayMs, policy);
    assert.ok(
      jittered >= minDelay && jittered <= maxDelay,
      `Jittered delay ${jittered} outside bounds [${minDelay}, ${maxDelay}]`
    );
  }
});

test('calculateNextRetryTime: supports deterministic full jitter', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterAlgorithm: 'full' as const,
    jitterPercent: 10,
    random: () => 0.5,
  };

  const retry = calculateNextRetryTime(0, policy, now);
  // Full jitter: 1000 - (1000*0.1)/2 + 0.5*(1000*0.1) = 1000 - 50 + 50 = 1000
  assert.equal(retry, now + 1000);
});

test('calculateNextRetryTime: deterministic equal jitter', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    jitterAlgorithm: 'equal' as const,
    random: () => 0.5,
  };

  const retry = calculateNextRetryTime(0, policy, now);
  // Equal jitter: 500 + 0.5*500 = 750
  assert.equal(retry, now + 750);
});

test('calculateNextRetryTime: deterministic decorrelated jitter', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    jitterAlgorithm: 'decorrelated' as const,
    random: () => 0.5,
  };

  const retry = calculateNextRetryTime(0, policy, now);
  // Decorrelated jitter: 0.5*1000*3 = 1500
  assert.equal(retry, now + 1500);
});

test('isRetryableStatusCode: retries on 5xx errors', () => {
  const policy = DEFAULT_RETRY_POLICY;

  assert.ok(isRetryableStatusCode(500, policy));
  assert.ok(isRetryableStatusCode(502, policy));
  assert.ok(isRetryableStatusCode(503, policy));
  assert.ok(isRetryableStatusCode(504, policy));
});

test('isRetryableStatusCode: retries on 429 (rate limit)', () => {
  const policy = DEFAULT_RETRY_POLICY;
  assert.ok(isRetryableStatusCode(429, policy));
});

test('isRetryableStatusCode: retries on 408 (timeout)', () => {
  const policy = DEFAULT_RETRY_POLICY;
  assert.ok(isRetryableStatusCode(408, policy));
});

test('isRetryableStatusCode: does not retry on 4xx errors', () => {
  const policy = DEFAULT_RETRY_POLICY;

  assert.ok(!isRetryableStatusCode(400, policy));
  assert.ok(!isRetryableStatusCode(401, policy));
  assert.ok(!isRetryableStatusCode(403, policy));
  assert.ok(!isRetryableStatusCode(404, policy));
});

test('isRetryableStatusCode: does not retry on 2xx/3xx', () => {
  const policy = DEFAULT_RETRY_POLICY;

  assert.ok(!isRetryableStatusCode(200, policy));
  assert.ok(!isRetryableStatusCode(201, policy));
  assert.ok(!isRetryableStatusCode(204, policy));
  assert.ok(!isRetryableStatusCode(301, policy));
  assert.ok(!isRetryableStatusCode(302, policy));
});

test('isRetryableStatusCode: retries on undefined (network error)', () => {
  const policy = DEFAULT_RETRY_POLICY;
  assert.ok(isRetryableStatusCode(undefined, policy));
});

test('shouldRetry: retries on network error', () => {
  const policy = DEFAULT_RETRY_POLICY;
  const attempt = {
    attemptNumber: 1,
    timestamp: Date.now(),
  };

  assert.ok(shouldRetry(attempt, 1, policy));
});

test('shouldRetry: retries on retryable status code', () => {
  const policy = DEFAULT_RETRY_POLICY;
  const attempt = {
    attemptNumber: 1,
    timestamp: Date.now(),
    statusCode: 503,
  };

  assert.ok(shouldRetry(attempt, 1, policy));
});

test('shouldRetry: does not retry on non-retryable status code', () => {
  const policy = DEFAULT_RETRY_POLICY;
  const attempt = {
    attemptNumber: 1,
    timestamp: Date.now(),
    statusCode: 404,
  };

  assert.ok(!shouldRetry(attempt, 1, policy));
});

test('shouldRetry: does not retry after max attempts', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: 3,
  };
  const attempt = {
    attemptNumber: 3,
    timestamp: Date.now(),
    statusCode: 503,
  };

  assert.ok(!shouldRetry(attempt, 3, policy));
});

test('scheduleWebhookOutboxRetry: should retry when below max attempts', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    jitterPercent: 0,
  };
  const input = {
    streamId: 'test',
    eventType: 'test',
    payload: { test: true },
    attemptNumber: 0,
    policy,
    now,
  };

  const plan = scheduleWebhookOutboxRetry(input);
  assert.equal(plan.shouldRetry, true);
  assert.equal(plan.attemptNumber, 1);
  assert.equal(plan.retryAt?.getTime(), now + 1000);
});

test('scheduleWebhookOutboxRetry: should not retry when at max attempts', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: 3,
  };
  const input = {
    streamId: 'test',
    eventType: 'test',
    payload: { test: true },
    attemptNumber: 3,
    policy,
    now,
  };

  const plan = scheduleWebhookOutboxRetry(input);
  assert.equal(plan.shouldRetry, false);
  assert.equal(plan.attemptNumber, 3);
  assert.equal(plan.retryAt, null);
});

test('shouldSendToDLQ: returns true when max attempts reached', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: 5,
  };
  assert.equal(shouldSendToDLQ(5, policy), true);
});

test('shouldSendToDLQ: returns false when below max attempts', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: 5,
  };
  assert.equal(shouldSendToDLQ(4, policy), false);
});

test('formatRetryPolicy: returns readable policy string', () => {
  const policy = DEFAULT_RETRY_POLICY;
  const formatted = formatRetryPolicy(policy);

  assert.ok(formatted.includes('max_attempts=5'));
  assert.ok(formatted.includes('initial_backoff=1000ms'));
  assert.ok(formatted.includes('multiplier=2x'));
  assert.ok(formatted.includes('max_backoff=60000ms'));
  assert.ok(formatted.includes('jitter=10%'));
  assert.ok(formatted.includes('timeout=30000ms'));
});

test('validateRetryPolicy: validates policy correctly', () => {
  // Valid policy
  const validPolicy = { ...DEFAULT_RETRY_POLICY };
  assert.deepEqual(validateRetryPolicy(validPolicy), []);

  // Invalid policy - maxAttempts <1
  const invalidPolicy1 = { ...DEFAULT_RETRY_POLICY, maxAttempts: 0 };
  assert.ok(validateRetryPolicy(invalidPolicy1).includes('maxAttempts must be at least 1'));

  // Invalid policy - initialBackoffMs <100
  const invalidPolicy2 = { ...DEFAULT_RETRY_POLICY, initialBackoffMs: 99 };
  assert.ok(validateRetryPolicy(invalidPolicy2).includes('initialBackoffMs must be at least 100ms'));

  // Invalid policy - backoffMultiplier <1
  const invalidPolicy3 = { ...DEFAULT_RETRY_POLICY, backoffMultiplier: 0.5 };
  assert.ok(validateRetryPolicy(invalidPolicy3).includes('backoffMultiplier must be at least 1'));

  // Invalid policy - maxBackoffMs < initialBackoffMs
  const invalidPolicy4 = { ...DEFAULT_RETRY_POLICY, maxBackoffMs: 500 };
  assert.ok(validateRetryPolicy(invalidPolicy4).includes('maxBackoffMs must be greater than initialBackoffMs'));

  // Invalid policy - jitterPercent <0
  const invalidPolicy5 = { ...DEFAULT_RETRY_POLICY, jitterPercent: -1 };
  assert.ok(validateRetryPolicy(invalidPolicy5).includes('jitterPercent must be between 0 and 100'));

  // Invalid policy - jitterPercent >100
  const invalidPolicy6 = { ...DEFAULT_RETRY_POLICY, jitterPercent: 101 };
  assert.ok(validateRetryPolicy(invalidPolicy6).includes('jitterPercent must be between 0 and 100'));

  // Invalid policy - timeoutMs <1000
  const invalidPolicy7 = { ...DEFAULT_RETRY_POLICY, timeoutMs: 999 };
  assert.ok(validateRetryPolicy(invalidPolicy7).includes('timeoutMs must be at least 1000ms'));

  // Invalid policy - deadLetterAfterMs <60000
  const invalidPolicy8 = { ...DEFAULT_RETRY_POLICY, deadLetterAfterMs: 59999 };
  assert.ok(validateRetryPolicy(invalidPolicy8).includes('deadLetterAfterMs must be at least 60000ms (1 minute)'));
});

test('generateRetrySchedule: generates retry schedule correctly', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 4000,
    jitterPercent: 0,
    maxAttempts: 3,
  };
  const schedule = generateRetrySchedule(policy, now);
  assert.equal(schedule.length, 3);
  assert.equal(schedule[0].attemptNumber, 1);
  assert.equal(schedule[0].delayMs, 1000);
  assert.equal(schedule[0].retryAt, now + 1000);
  assert.equal(schedule[1].attemptNumber, 2);
  assert.equal(schedule[1].delayMs, 2000);
  assert.equal(schedule[1].retryAt, now + 2000);
  assert.equal(schedule[2].attemptNumber, 3);
  assert.equal(schedule[2].delayMs, 4000);
  assert.equal(schedule[2].retryAt, now + 4000);
});

test('calculateCircuitBreakerResetTime: calculates reset time correctly', () => {
  const now = 1000000;
  const policyWithReset = { ...DEFAULT_RETRY_POLICY, circuitBreakerResetMs: 30000 };
  const resetTime = calculateCircuitBreakerResetTime(policyWithReset, now);
  assert.equal(resetTime, now + 30000);

  const policyWithoutReset = { ...DEFAULT_RETRY_POLICY };
  const resetTimeWithout = calculateCircuitBreakerResetTime(policyWithoutReset, now);
  assert.equal(resetTimeWithout, 0);
});

test('countsTowardCircuitBreaker: determines if attempt counts towards circuit breaker', () => {
  const policy = DEFAULT_RETRY_POLICY;

  // 200 OK with no error - doesn't count
  const okAttempt = { statusCode: 200, error: undefined };
  assert.ok(!countsTowardCircuitBreaker(okAttempt as any, policy));

  // 500 error - counts
  const errorAttempt = { statusCode: 500, error: new Error('test') };
  assert.ok(countsTowardCircuitBreaker(errorAttempt as any, policy));

  // No status code (network error) - counts
  const networkErrorAttempt = { statusCode: undefined, error: new Error('network') };
  assert.ok(countsTowardCircuitBreaker(networkErrorAttempt as any, policy));
});

test('resolveCircuitBreakerDeferral: resolves deferral time correctly', () => {
  const now = 1000000;
  const policy = DEFAULT_RETRY_POLICY;

  // Breaker with resetAt in future
  const breakerWithReset = { state: 'open' as const, allowed: false, resetAt: now + 5000, consecutiveFailures: 3 };
  const deferral1 = resolveCircuitBreakerDeferral(breakerWithReset, policy, now);
  assert.equal(deferral1.getTime(), now + 5000);

  // Breaker in half-open state
  const breakerHalfOpen = { state: 'half-open' as const, allowed: false, resetAt: null, consecutiveFailures: 1 };
  const deferral2 = resolveCircuitBreakerDeferral(breakerHalfOpen, policy, now);
  assert.equal(deferral2.getTime(), now + 1000);
});

test('calculateBackoffDelay: calculates delay for all strategies', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, initialBackoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 10000 };
  
  // Exponential
  const exponentialDelay = calculateBackoffDelay(2, { ...policy, backoffStrategy: 'exponential' });
  assert.equal(exponentialDelay, 4000);

  // Linear
  const linearDelay = calculateBackoffDelay(2, { ...policy, backoffStrategy: 'linear' });
  assert.equal(linearDelay, 3000);

  // Fixed
  const fixedDelay = calculateBackoffDelay(2, { ...policy, backoffStrategy: 'fixed' });
  assert.equal(fixedDelay, 1000);

  // Capped
  const cappedDelay = calculateBackoffDelay(5, { ...policy, backoffStrategy: 'exponential', maxBackoffMs: 5000 });
  assert.equal(cappedDelay, 5000);
});

test('applyJitter: applies all jitter algorithms correctly', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, initialBackoffMs: 1000, jitterPercent: 20, random: () => 0.5 };
  
  // Full jitter
  const fullJitterDelay = applyJitter(1000, { ...policy, jitterAlgorithm: 'full' });
  assert.equal(fullJitterDelay, 1000); // because jitter range is 200, -100 + 0.5*200 = 0

  // Equal jitter
  const equalJitterDelay = applyJitter(1000, { ...policy, jitterAlgorithm: 'equal' });
  assert.equal(equalJitterDelay, 750);

  // Decorrelated jitter
  const decorrelatedJitterDelay = applyJitter(1000, { ...policy, jitterAlgorithm: 'decorrelated' });
  assert.equal(decorrelatedJitterDelay, 1500);
});
