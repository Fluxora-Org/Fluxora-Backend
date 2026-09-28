import { test, expect, vi } from 'vitest';
import {
  calculateNextRetryTime,
  isRetryableStatusCode,
  shouldRetry,
  formatRetryPolicy,
  generateRetrySchedule,
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

test('calculateNextRetryTime: applies jitter within bounds', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterPercent: 10,
  };

  // Run multiple times to verify jitter is applied
  const retries = Array.from({ length: 10 }, () => calculateNextRetryTime(0, policy, now));

  // Full jitter schedules within the full [0, raw backoff] window.
  const minExpected = now;
  const maxExpected = now + 1000;

  for (const retry of retries) {
    assert.ok(
      retry >= minExpected && retry <= maxExpected,
      `Retry ${retry} outside bounds [${minExpected}, ${maxExpected}]`
    );
  }

  // Should have some variation (not all the same)
  const uniqueRetries = new Set(retries);
  assert.ok(uniqueRetries.size > 1, 'Jitter should produce variation');
});

test('calculateNextRetryTime: supports deterministic full jitter', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterAlgorithm: 'full' as const,
    random: () => 0.25,
  };

  const retry = calculateNextRetryTime(1, policy, now);

  assert.equal(retry, now + 500);
});

test('calculateNextRetryTime: decorrelated jitter uses previous delay state', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 5000,
    jitterAlgorithm: 'decorrelated' as const,
    previousDelayMs: 2000,
    random: () => 0.5,
  };

  const retry = calculateNextRetryTime(2, policy, now);

  assert.equal(retry, now + 3000);
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

// ---------------------------------------------------------------------------
// Jitter algorithms: seeded/deterministic delays (full, decorrelated)
// ---------------------------------------------------------------------------

test('calculateNextRetryTime: full jitter is deterministic and reproducible for a seeded random fn', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterAlgorithm: 'full' as const,
    random: () => 0.42,
  };

  // attempt 2: exponential = 1000 * 2^2 = 4000, capped = 4000, delay = 0.42 * 4000 = 1680
  const first = calculateNextRetryTime(2, policy, now);
  const second = calculateNextRetryTime(2, policy, now);

  assert.equal(first, now + 1680);
  assert.equal(second, first);
});

test('calculateNextRetryTime: decorrelated jitter is deterministic and reproducible for a seeded random fn', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterAlgorithm: 'decorrelated' as const,
    previousDelayMs: 3000,
    random: () => 0.25,
  };

  // maxJitter = min(60000, 3000*3) = 9000, range = 8000, delay = 1000 + 0.25*8000 = 3000
  const first = calculateNextRetryTime(3, policy, now);
  const second = calculateNextRetryTime(3, policy, now);

  assert.equal(first, now + 3000);
  assert.equal(second, first);
});

test('generateRetrySchedule: decorrelated jitter chains previousDelayMs across attempts and is reproducible', () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    maxAttempts: 3,
    jitterAlgorithm: 'decorrelated' as const,
    random: () => 0.5,
  };

  const scheduleA = generateRetrySchedule(policy, 0);
  const scheduleB = generateRetrySchedule(policy, 0);

  assert.deepEqual(scheduleA, scheduleB);
  // attempt 1 (i=0): previousDelay defaults to baseDelayMs=1000 -> maxJitter=3000, range=2000, delay=1000+0.5*2000=2000
  assert.equal(scheduleA[0].delayMs, 2000);
  // attempt 2 (i=1): previousDelayMs carried = 2000 -> maxJitter=6000, range=5000, delay=1000+0.5*5000=3500
  assert.equal(scheduleA[1].delayMs, 3500);
});

test('calculateNextRetryTime: defaults "now" to the current time when omitted', () => {
  const fixedNow = 1_700_000_000_000;
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
  try {
    const policy = { ...DEFAULT_RETRY_POLICY, initialBackoffMs: 1000, jitterPercent: 0 };
    assert.equal(calculateNextRetryTime(0, policy), fixedNow + 1000);
  } finally {
    vi.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// Retryable status classification: 5xx / 4xx / 429
// ---------------------------------------------------------------------------

test('isRetryableStatusCode: does not retry on 5xx codes outside the configured retryable set', () => {
  const policy = DEFAULT_RETRY_POLICY;

  assert.ok(!isRetryableStatusCode(501, policy));
  assert.ok(!isRetryableStatusCode(505, policy));
});

test('isRetryableStatusCode: 4xx client errors are non-retryable except 429', () => {
  const policy = DEFAULT_RETRY_POLICY;

  assert.ok(!isRetryableStatusCode(400, policy));
  assert.ok(!isRetryableStatusCode(401, policy));
  assert.ok(!isRetryableStatusCode(403, policy));
  assert.ok(!isRetryableStatusCode(404, policy));
  assert.ok(!isRetryableStatusCode(422, policy));
  assert.ok(isRetryableStatusCode(429, policy));
});

test('429 rate limit is retryable and follows standard exponential backoff', () => {
  // Note: Retry-After header parsing is handled in webhooks/service.ts, not
  // this module — calculateNextRetryTime here always applies the policy's
  // own exponential-backoff schedule regardless of status code.
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
    jitterPercent: 0,
  };
  const attempt = { attemptNumber: 1, timestamp: Date.now(), statusCode: 429 };

  assert.ok(isRetryableStatusCode(429, policy));
  assert.ok(shouldRetry(attempt, 1, policy));
  assert.equal(calculateNextRetryTime(1, policy, now), now + 2000);
});

// ---------------------------------------------------------------------------
// Terminal attempts
// ---------------------------------------------------------------------------

test('calculateNextRetryTime: returns 0 for any attempt number at or beyond maxAttempts', () => {
  const now = 1000000;
  const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 };

  assert.equal(calculateNextRetryTime(5, policy, now), 0);
  assert.equal(calculateNextRetryTime(6, policy, now), 0);
  assert.equal(calculateNextRetryTime(100, policy, now), 0);
});

test('shouldRetry: returns false for any attempt number at or beyond maxAttempts', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 };
  const attempt = { attemptNumber: 3, timestamp: Date.now(), statusCode: 503 };

  assert.ok(!shouldRetry(attempt, 3, policy));
  assert.ok(!shouldRetry(attempt, 4, policy));
});

// ---------------------------------------------------------------------------
// Boundary: maxBackoffMs ceiling
// ---------------------------------------------------------------------------

test('calculateNextRetryTime: full jitter delay is capped at maxBackoffMs even at random()=1 and high attempt numbers', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
    maxAttempts: 10,
    jitterAlgorithm: 'full' as const,
    random: () => 1,
  };

  // attempt 6: exponential = 1000 * 2^6 = 64000, far beyond maxBackoffMs
  const retry = calculateNextRetryTime(6, policy, now);
  assert.equal(retry, now + 10000);
});

test('calculateNextRetryTime: decorrelated jitter delay is capped at maxBackoffMs even with a large previousDelayMs', () => {
  const now = 1000000;
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    initialBackoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
    jitterAlgorithm: 'decorrelated' as const,
    previousDelayMs: 50000,
    random: () => 1,
  };

  const retry = calculateNextRetryTime(1, policy, now);
  assert.equal(retry, now + 10000);
});
