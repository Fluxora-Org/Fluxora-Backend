import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateNextRetryTime,
  isRetryableStatusCode,
  shouldRetry,
  formatRetryPolicy,
} from './retry.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

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
  const retries = Array.from({ length: 10 }, () =>
    calculateNextRetryTime(0, policy, now),
  );

  // All should be within ±10% of 1000ms
  const minExpected = now + 900;
  const maxExpected = now + 1100;

  for (const retry of retries) {
    assert.ok(retry >= minExpected && retry <= maxExpected,
      `Retry ${retry} outside bounds [${minExpected}, ${maxExpected}]`);
  }

  // Should have some variation (not all the same)
  const uniqueRetries = new Set(retries);
  assert.ok(uniqueRetries.size > 1, 'Jitter should produce variation');
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
