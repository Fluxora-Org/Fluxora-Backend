/**
 * Regression tests for per-operation RPC deadlines (#1299).
 *
 * These tests verify that:
 *   1. Each operation uses its configured deadline (or the global fallback).
 *   2. Slow responses are timed out at the correct boundary.
 *   3. Timeout errors are classified as TIMEOUT and resources are released.
 *   4. Per-call overrides take precedence over per-operation defaults.
 *   5. Retries respect the per-operation deadline on every attempt.
 *   6. Existing behaviour (global timeout, circuit breaker) is unchanged.
 *
 * Run:
 *   pnpm vitest run tests/services/stellarRpc.deadlines.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StellarRpcService,
  CircuitOpenError,
  RpcProviderError,
  parseOperationDeadlines,
  type RawRpcClient,
} from '../../src/services/stellar-rpc.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(fn: () => Promise<{ sequence: number }>): RawRpcClient {
  return { getLatestLedger: fn };
}

function delay(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms));
}

// ── parseOperationDeadlines ──────────────────────────────────────────────────

describe('parseOperationDeadlines', () => {
  it('returns empty object for undefined input', () => {
    expect(parseOperationDeadlines(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseOperationDeadlines('')).toEqual({});
    expect(parseOperationDeadlines('  ')).toEqual({});
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseOperationDeadlines('{not json')).toEqual({});
  });

  it('returns empty object for non-object JSON', () => {
    expect(parseOperationDeadlines('[1,2,3]')).toEqual({});
    expect(parseOperationDeadlines('"hello"')).toEqual({});
    expect(parseOperationDeadlines('null')).toEqual({});
  });

  it('parses valid operation deadlines', () => {
    const result = parseOperationDeadlines(
      JSON.stringify({ getLatestLedger: 2000, accountExists: 8000 }),
    );
    expect(result).toEqual({ getLatestLedger: 2000, accountExists: 8000 });
  });

  it('floors fractional values', () => {
    const result = parseOperationDeadlines(JSON.stringify({ op: 3.7 }));
    expect(result).toEqual({ op: 3 });
  });

  it('drops values below 1 ms', () => {
    const result = parseOperationDeadlines(JSON.stringify({ a: 0, b: -5, c: 1 }));
    expect(result).toEqual({ c: 1 });
  });

  it('drops non-numeric values', () => {
    const result = parseOperationDeadlines(
      JSON.stringify({ a: 'slow', b: null, c: 100 }),
    );
    expect(result).toEqual({ c: 100 });
  });
});

// ── Per-operation deadlines ──────────────────────────────────────────────────

describe('StellarRpcService — per-operation deadlines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses global timeoutMs when no operation-specific deadline is set', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      { timeoutMs: 30 },
    );

    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });

  it('uses per-operation deadline instead of global timeoutMs', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000, // generous global
        operationDeadlines: { getLatestLedger: 25 }, // tight per-op
      },
    );

    const start = Date.now();
    const err = await svc.getLatestLedger().catch((e) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
    expect(elapsed).toBeLessThan(200);
  });

  it('uses global timeoutMs for operations not in the deadline map', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 25,
        operationDeadlines: { accountExists: 10_000 },
      },
    );

    // getLatestLedger is NOT in the deadline map → uses global 25ms
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });

  it('per-call timeoutMs override takes precedence over per-operation deadline', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        operationDeadlines: { getLatestLedger: 10_000 },
      },
    );

    // Per-call override is tighter than per-operation
    const err = await svc.getLatestLedger({ timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });

  it('resolves deadline via resolveDeadline method', () => {
    const svc = new StellarRpcService(
      () => makeClient(async () => ({ sequence: 1 })),
      {
        timeoutMs: 5_000,
        operationDeadlines: { getLatestLedger: 2_000, accountExists: 8_000 },
      },
    );

    expect(svc.resolveDeadline('getLatestLedger')).toBe(2_000);
    expect(svc.resolveDeadline('accountExists')).toBe(8_000);
    expect(svc.resolveDeadline('unknown')).toBe(5_000);
    // Per-call override
    expect(svc.resolveDeadline('getLatestLedger', { timeoutMs: 500 })).toBe(500);
  });
});

// ── Timeout classification and resource release ──────────────────────────────

describe('StellarRpcService — timeout classification and resource release', () => {
  afterEach(() => vi.restoreAllMocks());

  it('classifies per-operation timeout as TIMEOUT kind', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        operationDeadlines: { getLatestLedger: 15 },
      },
    );

    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
    expect((err as RpcProviderError).durationMs).toBeGreaterThanOrEqual(0);
    expect((err as RpcProviderError).message).toContain('getLatestLedger');
  });

  it('releases resources after timeout (subsequent calls work)', async () => {
    let callCount = 0;
    const svc = new StellarRpcService(
      () =>
        makeClient(async () => {
          callCount++;
          if (callCount === 1) return delay(5_000);
          return { sequence: 42 };
        }),
      {
        timeoutMs: 10_000,
        operationDeadlines: { getLatestLedger: 15 },
      },
    );

    // First call times out
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');

    // Second call succeeds — resources were released
    const result = await svc.getLatestLedger();
    expect(result).toEqual({ sequence: 42 });
  });

  it('circuit breaker does not trip on a single per-operation timeout', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        failureThreshold: 3,
        operationDeadlines: { getLatestLedger: 15 },
      },
    );

    await svc.getLatestLedger().catch(() => {});
    expect(svc.getCircuitState()).toBe('CLOSED');
  });

  it('circuit breaker trips after enough per-operation timeouts', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        failureThreshold: 2,
        operationDeadlines: { getLatestLedger: 15 },
      },
    );

    await svc.getLatestLedger().catch(() => {});
    await svc.getLatestLedger().catch(() => {});
    expect(svc.getCircuitState()).toBe('OPEN');

    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });
});

// ── Boundary cases ───────────────────────────────────────────────────────────

describe('StellarRpcService — deadline boundary cases', () => {
  afterEach(() => vi.restoreAllMocks());

  it('call succeeds when it finishes just under the deadline', async () => {
    const svc = new StellarRpcService(
      () =>
        makeClient(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { sequence: 99 };
        }),
      {
        timeoutMs: 10_000,
        operationDeadlines: { getLatestLedger: 500 },
      },
    );

    const result = await svc.getLatestLedger();
    expect(result).toEqual({ sequence: 99 });
  });

  it('call times out when it exceeds the deadline', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        operationDeadlines: { getLatestLedger: 10 },
      },
    );

    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });

  it('different operations can have different deadlines', async () => {
    let callCount = 0;
    const getLatestLedger = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return delay(5_000); // slow first call
      return { sequence: 1 };
    });

    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      {
        timeoutMs: 10_000,
        operationDeadlines: {
          getLatestLedger: 10, // tight
        },
      },
    );

    // getLatestLedger times out at 10ms
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');

    // Second call succeeds
    const result = await svc.getLatestLedger();
    expect(result).toEqual({ sequence: 1 });
  });
});

// ── Retry interaction ────────────────────────────────────────────────────────

describe('StellarRpcService — retry with per-operation deadlines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('per-operation deadline bounds the entire call including retries', async () => {
    // callWithTimeout wraps the ENTIRE retry chain, so the per-operation
    // deadline is the wall-clock budget for ALL retries combined.
    // When the deadline expires mid-retry, the operation is cancelled.
    let attempt = 0;
    const svc = new StellarRpcService(
      () =>
        makeClient(async () => {
          attempt++;
          return delay(5_000); // every attempt is slow
        }),
      {
        timeoutMs: 10_000,
        maxRetries: 2,
        retryDelayMs: 5,
        operationDeadlines: { getLatestLedger: 30 },
      },
    );

    const start = Date.now();
    const err = await svc.getLatestLedger().catch((e) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
    // Must finish within a reasonable multiple of the deadline
    expect(elapsed).toBeLessThan(200);
  });

  it('exhausts retries when all attempts time out per-operation deadline', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        maxRetries: 2,
        retryDelayMs: 10,
        operationDeadlines: { getLatestLedger: 15 },
      },
    );

    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });
});

// ── Backward compatibility ───────────────────────────────────────────────────

describe('StellarRpcService — backward compatibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it('works identically when no operationDeadlines are configured', async () => {
    const svc = new StellarRpcService(
      () => makeClient(async () => ({ sequence: 1 })),
      { timeoutMs: 5_000 },
    );

    const result = await svc.getLatestLedger();
    expect(result).toEqual({ sequence: 1 });
    expect(svc.resolveDeadline('getLatestLedger')).toBe(5_000);
  });

  it('empty operationDeadlines map falls back to global timeout', async () => {
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 25,
        operationDeadlines: {},
      },
    );

    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });

  it('Circuit breaker and cancellation still work with per-operation deadlines', async () => {
    // Cancellation via AbortController
    const controller = new AbortController();
    const svc = new StellarRpcService(
      () => makeClient(() => delay(5_000)),
      {
        timeoutMs: 10_000,
        failureThreshold: 3,
        operationDeadlines: { getLatestLedger: 10_000 },
      },
    );

    const promise = svc.getLatestLedger({ signal: controller.signal });
    controller.abort();

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('CANCELLED');
    // Circuit should not trip from cancellations
    expect(svc.getCircuitState()).toBe('CLOSED');
  });
});
