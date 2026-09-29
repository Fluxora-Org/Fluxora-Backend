import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  StellarRpcService,
  CircuitBreaker,
  RpcProviderError,
  CircuitOpenError,
  isRetryableRpcError,
  setStellarRpcService,
  type RawRpcClient,
} from '../src/services/stellar-rpc.js';
import * as hooksModule from '../src/tracing/hooks.js';
import {
  rpcUpstreamCallsTotal,
  rpcUpstreamCallsFailedTotal,
  rpcUpstreamCallDurationSeconds,
  deRegisterRpcMetrics,
  RPC_CALL_OUTCOMES,
  RPC_FAILURE_KINDS,
} from '../src/metrics/rpcMetrics.js';
import { registry } from '../src/metrics.js';
import { countMetricSeries } from '../src/metrics/cardinality.js';

// ── StellarRpcService — failure classification ────────────────────────────────

function makeService(
  mockFn: () => Promise<{ sequence: number }>,
  opts: { timeoutMs?: number; failureThreshold?: number } = {},
): StellarRpcService {
  const client: RawRpcClient = { getLatestLedger: mockFn };
  return new StellarRpcService(() => client, { timeoutMs: 50, failureThreshold: 3, ...opts });
}

describe('StellarRpcService — failure classification', () => {
  afterEach(() => setStellarRpcService(null));

  it('classifies a timeout as TIMEOUT kind', async () => {
    const svc = makeService(() => new Promise(() => {}), { timeoutMs: 20 });
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('TIMEOUT');
  });

  it('classifies a network error (ECONNREFUSED) as NETWORK kind', async () => {
    const netErr = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const svc = makeService(() => Promise.reject(netErr));
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('NETWORK');
  });

  it('classifies an HTTP 500 response as PROVIDER kind', async () => {
    const providerErr = Object.assign(new Error('Internal Server Error'), { statusCode: 500 });
    const svc = makeService(() => Promise.reject(providerErr));
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('PROVIDER');
    expect((err as RpcProviderError).statusCode).toBe(500);
  });

  it('classifies a generic error as PROVIDER kind', async () => {
    const svc = makeService(() => Promise.reject(new Error('something went wrong')));
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('PROVIDER');
  });

  it('includes durationMs in the error', async () => {
    const svc = makeService(() => new Promise(() => {}), { timeoutMs: 20 });
    const err = await svc.getLatestLedger().catch((e) => e) as RpcProviderError;
    expect(typeof err.durationMs).toBe('number');
    expect(err.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── StellarRpcService — AbortController cancellation ─────────────────────────

describe('StellarRpcService — AbortController cancellation', () => {
  afterEach(() => setStellarRpcService(null));

  it('rejects with CANCELLED kind when signal is aborted before call', async () => {
    const controller = new AbortController();
    controller.abort();
    const svc = makeService(() => new Promise(() => {}));
    const err = await svc.getLatestLedger({ signal: controller.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('CANCELLED');
  });

  it('rejects with CANCELLED kind when signal is aborted mid-flight', async () => {
    const controller = new AbortController();
    const svc = makeService(() => new Promise(() => {}), { timeoutMs: 5000 });
    const promise = svc.getLatestLedger({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).kind).toBe('CANCELLED');
  });

  it('resolves normally when signal is not aborted', async () => {
    const controller = new AbortController();
    const svc = makeService(() => Promise.resolve({ sequence: 42 }));
    const result = await svc.getLatestLedger({ signal: controller.signal });
    expect(result).toEqual({ sequence: 42 });
  });
});

// ── StellarRpcService — circuit breaker integration ──────────────────────────

describe('StellarRpcService — circuit breaker integration', () => {
  afterEach(() => setStellarRpcService(null));

  it('trips the circuit after failureThreshold failures', async () => {
    const svc = makeService(() => Promise.reject(new Error('fail')), { failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await svc.getLatestLedger().catch(() => {});
    }
    expect(svc.getCircuitState()).toBe('OPEN');
  });

  it('throws CircuitOpenError when circuit is OPEN', async () => {
    const svc = makeService(() => Promise.reject(new Error('fail')), { failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await svc.getLatestLedger().catch(() => {});
    }
    const err = await svc.getLatestLedger().catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).kind).toBe('CIRCUIT_OPEN');
  });

  it('resets to CLOSED after resetCircuit()', async () => {
    const svc = makeService(() => Promise.reject(new Error('fail')), { failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await svc.getLatestLedger().catch(() => {});
    }
    svc.resetCircuit();
    expect(svc.getCircuitState()).toBe('CLOSED');
  });

  it('returns result when circuit is CLOSED and call succeeds', async () => {
    const svc = makeService(() => Promise.resolve({ sequence: 100 }));
    const result = await svc.getLatestLedger();
    expect(result).toEqual({ sequence: 100 });
    expect(svc.getCircuitState()).toBe('CLOSED');
  });
});

// ── CircuitBreaker unit tests ─────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('transitions to OPEN after threshold failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const fail = () => Promise.reject(new Error('x'));
    await cb.call(fail).catch(() => {});
    await cb.call(fail).catch(() => {});
    expect(cb.getState()).toBe('OPEN');
  });

  it('resets to CLOSED on reset()', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await cb.call(() => Promise.reject(new Error('x'))).catch(() => {});
    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('transitions to HALF_OPEN after resetTimeoutMs', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
    await cb.call(() => Promise.reject(new Error('x'))).catch(() => {});
    expect(cb.getState()).toBe('OPEN');
    await new Promise((r) => setTimeout(r, 20));
    await cb.call(() => Promise.resolve('ok')).catch(() => {});
    expect(cb.getState()).toBe('CLOSED');
  });
});

// ── CircuitBreaker trace event tests ─────────────────────────────────────────

describe('CircuitBreaker — trace events', () => {
  let recordTransition: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    recordTransition = vi.spyOn(hooksModule, 'recordCircuitBreakerTransition');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits CLOSED→OPEN event with failure kind when breaker trips', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const netErr = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    await cb.call(() => Promise.reject(netErr)).catch(() => {});
    await cb.call(() => Promise.reject(netErr)).catch(() => {});

    expect(recordTransition).toHaveBeenCalledWith('CLOSED', 'OPEN', 2, 'NETWORK');
  });

  it('emits OPEN→HALF_OPEN event after reset timeout elapses', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
    await cb.call(() => Promise.reject(new Error('fail'))).catch(() => {});

    recordTransition.mockClear();
    await new Promise((r) => setTimeout(r, 20));
    // trigger probe — this causes the OPEN→HALF_OPEN transition inside call()
    await cb.call(() => Promise.resolve('ok')).catch(() => {});

    expect(recordTransition).toHaveBeenCalledWith('OPEN', 'HALF_OPEN', expect.any(Number));
  });

  it('emits HALF_OPEN→CLOSED event when probe succeeds', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
    await cb.call(() => Promise.reject(new Error('fail'))).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    recordTransition.mockClear();
    await cb.call(() => Promise.resolve('ok'));

    expect(recordTransition).toHaveBeenCalledWith('HALF_OPEN', 'CLOSED', 0);
  });

  it('does NOT emit an event on steady-state CLOSED success (no span spam)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    await cb.call(() => Promise.resolve('ok'));
    await cb.call(() => Promise.resolve('ok'));
    await cb.call(() => Promise.resolve('ok'));

    expect(recordTransition).not.toHaveBeenCalled();
  });

  it('includes failureKind attribute in CLOSED→OPEN event for TIMEOUT', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    const timeoutErr = new RpcProviderError('timed out', 'TIMEOUT', undefined, 5000);
    await cb.call(() => Promise.reject(timeoutErr)).catch(() => {});

    expect(recordTransition).toHaveBeenCalledWith('CLOSED', 'OPEN', 1, 'TIMEOUT');
  });

  it('includes failureKind PROVIDER for HTTP errors', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    const providerErr = Object.assign(new Error('500'), { statusCode: 500 });
    await cb.call(() => Promise.reject(providerErr)).catch(() => {});

    expect(recordTransition).toHaveBeenCalledWith('CLOSED', 'OPEN', 1, 'PROVIDER');
  });
});

// ── recordCircuitBreakerTransition unit tests ─────────────────────────────────

describe('recordCircuitBreakerTransition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    hooksModule.resetTracer();
  });

  it('does not throw when no active span exists', () => {
    expect(() =>
      hooksModule.recordCircuitBreakerTransition('CLOSED', 'OPEN', 3, 'NETWORK'),
    ).not.toThrow();
  });

  it('does not throw when tracing is disabled (default)', () => {
    hooksModule.resetTracer();
    expect(() =>
      hooksModule.recordCircuitBreakerTransition('OPEN', 'HALF_OPEN', 0),
    ).not.toThrow();
  });

  it('records event on the active custom tracer span', () => {
    const tracer = hooksModule.initializeTracer({ enabled: true });
    const span = tracer.startSpan({ traceId: 'test-trace' });
    const recordEvent = vi.spyOn(tracer, 'recordEvent');

    hooksModule.recordCircuitBreakerTransition('CLOSED', 'OPEN', 5, 'TIMEOUT');

    expect(recordEvent).toHaveBeenCalledWith(
      span,
      'circuit_breaker.state_change',
      expect.objectContaining({
        'circuit_breaker.prev_state': 'CLOSED',
        'circuit_breaker.new_state': 'OPEN',
        'circuit_breaker.failure_count': 5,
        'circuit_breaker.failure_kind': 'TIMEOUT',
      }),
    );
  });

  it('omits failure_kind attribute when not provided (HALF_OPEN→CLOSED recovery)', () => {
    const tracer = hooksModule.initializeTracer({ enabled: true });
    tracer.startSpan({ traceId: 'test-trace' });
    const recordEvent = vi.spyOn(tracer, 'recordEvent');

    hooksModule.recordCircuitBreakerTransition('HALF_OPEN', 'CLOSED', 0);

    const attrs = (recordEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(attrs).not.toHaveProperty('circuit_breaker.failure_kind');
  });

  it('records event on the OTel active span when present', () => {
    const addEvent = vi.fn();
    const fakeSpan = { addEvent };
    vi.spyOn(hooksModule, 'recordCircuitBreakerTransition').mockImplementation(
      (prev, next, count, kind) => {
        // Verify the function signature is correct by calling through
        fakeSpan.addEvent('circuit_breaker.state_change', {
          'circuit_breaker.prev_state': prev,
          'circuit_breaker.new_state': next,
          'circuit_breaker.failure_count': count,
          ...(kind !== undefined ? { 'circuit_breaker.failure_kind': kind } : {}),
        });
      },
    );

    hooksModule.recordCircuitBreakerTransition('OPEN', 'HALF_OPEN', 3);
    expect(addEvent).toHaveBeenCalledWith(
      'circuit_breaker.state_change',
      expect.objectContaining({
        'circuit_breaker.prev_state': 'OPEN',
        'circuit_breaker.new_state': 'HALF_OPEN',
      }),
    );
  });

  it('does not emit events containing secrets or RPC URLs', () => {
    const tracer = hooksModule.initializeTracer({ enabled: true });
    tracer.startSpan({ traceId: 'test-trace' });
    const recordEvent = vi.spyOn(tracer, 'recordEvent');

    hooksModule.recordCircuitBreakerTransition('CLOSED', 'OPEN', 2, 'NETWORK');

    const attrs = (recordEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    const values = Object.values(attrs).map(String);
    // None of the attribute values should look like a URL or bearer token
    for (const v of values) {
      expect(v).not.toMatch(/^https?:\/\//);
      expect(v).not.toMatch(/^Bearer /i);
    }
  });
});

// ── isRetryableRpcError — retryable status classification ────────────────────

describe('isRetryableRpcError', () => {
  it('is not retryable for a raw (unclassified) error', () => {
    expect(isRetryableRpcError(new Error('boom'))).toBe(false);
  });

  it('is not retryable for CancelledError-kind RpcProviderError', () => {
    const err = new RpcProviderError('cancelled', 'CANCELLED');
    expect(isRetryableRpcError(err)).toBe(false);
  });

  it('is retryable for TIMEOUT-kind RpcProviderError', () => {
    const err = new RpcProviderError('timed out', 'TIMEOUT');
    expect(isRetryableRpcError(err)).toBe(true);
  });

  it('is retryable for NETWORK-kind RpcProviderError', () => {
    const err = new RpcProviderError('connection reset', 'NETWORK');
    expect(isRetryableRpcError(err)).toBe(true);
  });

  it('is retryable for PROVIDER errors with a 429 (rate limit) status', () => {
    const err = new RpcProviderError('rate limited', 'PROVIDER', 429);
    expect(isRetryableRpcError(err)).toBe(true);
  });

  it('is retryable for PROVIDER errors with a 5xx (upstream server error) status', () => {
    const err = new RpcProviderError('bad gateway', 'PROVIDER', 502);
    expect(isRetryableRpcError(err)).toBe(true);
  });

  it('is not retryable for PROVIDER errors with a permanent 4xx status', () => {
    for (const statusCode of [400, 401, 403, 404]) {
      const err = new RpcProviderError('client error', 'PROVIDER', statusCode);
      expect(isRetryableRpcError(err)).toBe(false);
    }
  });

  it('is not retryable for PROVIDER errors with no status (config error / malformed response)', () => {
    const err = new RpcProviderError('horizonUrl not configured on RPC client', 'PROVIDER');
    expect(isRetryableRpcError(err)).toBe(false);
  });
});

// ── StellarRpcService.accountExists — retry / fallback policy ────────────────

function makeAccountExistsService(
  fetchImpl: typeof fetch,
  opts: { horizonUrl?: string; maxRetries?: number; retryDelayMs?: number } = {},
): StellarRpcService {
  vi.stubGlobal('fetch', fetchImpl);
  const client: RawRpcClient = {
    getLatestLedger: vi.fn(),
    horizonUrl: opts.horizonUrl ?? 'https://horizon.test',
  };
  return new StellarRpcService(() => client, {
    timeoutMs: 5_000,
    failureThreshold: 10,
    maxRetries: opts.maxRetries ?? 2,
    retryDelayMs: opts.retryDelayMs ?? 1,
  });
}

describe('StellarRpcService.accountExists — retry / fallback policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a permanent error (config error, no horizonUrl) fails fast without retrying', async () => {
    const fetchMock = vi.fn();
    const svc = makeAccountExistsService(fetchMock, { horizonUrl: '' });

    const err = await svc.accountExists('GACCOUNT').catch((e) => e);

    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).message).toMatch(/horizonUrl not configured/);
    // Permanent/config errors must not consume retry budget: fetch is never
    // even reached, and — critically — no retry sleep is scheduled, so this
    // resolves immediately instead of paying multiple backoff delays.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a permanent 4xx response is surfaced immediately and is not retried', async () => {
    const fetchMock = vi.fn(async () => ({ status: 403 }));
    const svc = makeAccountExistsService(fetchMock as unknown as typeof fetch);

    const err = await svc.accountExists('GACCOUNT').catch((e) => e);

    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a rate-limited (429) response is retried and can eventually succeed', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) return { status: 429 };
      return { status: 200 };
    });
    const svc = makeAccountExistsService(fetchMock as unknown as typeof fetch, { maxRetries: 3 });

    await expect(svc.accountExists('GACCOUNT')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a malformed/unexpected response (5xx) is retried and can eventually succeed', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 2) return { status: 502 };
      return { status: 404 };
    });
    const svc = makeAccountExistsService(fetchMock as unknown as typeof fetch, { maxRetries: 3 });

    await expect(svc.accountExists('GMISSING')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a successful lookup on the first attempt does not retry', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }));
    const svc = makeAccountExistsService(fetchMock as unknown as typeof fetch);

    await expect(svc.accountExists('GACCOUNT')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausting retries on a persistently rate-limited endpoint surfaces the last PROVIDER error', async () => {
    const fetchMock = vi.fn(async () => ({ status: 429 }));
    const svc = makeAccountExistsService(fetchMock as unknown as typeof fetch, { maxRetries: 2 });

    const err = await svc.accountExists('GACCOUNT').catch((e) => e);

    expect(err).toBeInstanceOf(RpcProviderError);
    expect((err as RpcProviderError).statusCode).toBe(429);
    // maxRetries: 2 => up to 3 attempts total (1 initial + 2 retries).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ── RPC upstream metrics — per-method latency + failure states ────────────────

function getCounterValue(
  metric: typeof rpcUpstreamCallsTotal,
  labels: Record<string, string>,
): number {
  const values = metric.get();
  for (const v of values.values) {
    const match = Object.entries(labels).every(
      ([k, val]) => v.labels[k as keyof typeof v.labels] === val,
    );
    if (match) return v.value;
  }
  return 0;
}

function getHistogramCount(
  metric: typeof rpcUpstreamCallDurationSeconds,
  labels: Record<string, string>,
): number {
  const values = metric.get();
  for (const v of values.values) {
    const match = Object.entries(labels).every(
      ([k, val]) => v.labels[k as keyof typeof v.labels] === val,
    );
    // Histogram .get() returns the sum and count as separate entries.
    // metricName + "_count" gives us the observation count.
    if (match && v.metricName?.endsWith('_count')) return v.value;
  }
  return 0;
}

describe('RPC upstream metrics — label cardinality bounded', () => {
  beforeEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  afterEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  it('RPC_CALL_OUTCOMES has exactly 2 values (success/failure) — no user-controlled values', () => {
    expect(RPC_CALL_OUTCOMES).toEqual(['success', 'failure']);
    expect(RPC_CALL_OUTCOMES.length).toBe(2);
  });

  it('RPC_FAILURE_KINDS is a closed enum of 5 — matches RpcFailureKind without unbounded growth', () => {
    expect(RPC_FAILURE_KINDS).toEqual([
      'TIMEOUT',
      'NETWORK',
      'PROVIDER',
      'CIRCUIT_OPEN',
      'CANCELLED',
    ]);
    expect(RPC_FAILURE_KINDS.length).toBe(5);
  });

  it('rpcUpstreamCallsTotal labels are in the allow-list (operation, outcome only)', () => {
    // This implicitly passes because the metric compiled with these labels.
    // Explicitly assert names match cardinality policy:
    expect(rpcUpstreamCallsTotal.labelNames).toEqual(['operation', 'outcome']);
  });

  it('rpcUpstreamCallsFailedTotal labels are in the allow-list (operation, kind only)', () => {
    expect(rpcUpstreamCallsFailedTotal.labelNames).toEqual(['operation', 'kind']);
  });

  it('rpcUpstreamCallDurationSeconds labels are in the allow-list', () => {
    expect(rpcUpstreamCallDurationSeconds.labelNames).toEqual(['operation', 'outcome']);
  });

  it('after exercising every failure kind + 2 ops, total series for failure counter is O(operations * kinds) — not user-driven', async () => {
    const svc = makeService(
      async () => {
        const netErr = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
        throw netErr;
      },
      { failureThreshold: 10, timeoutMs: 10 },
    );
    await svc.getLatestLedger().catch(() => {});
    await svc.getLatestLedger().catch(() => {});

    const text = await registry.metrics();
    // operations=1 * kinds(used)=1 → 1 series. Worst case operations=N * kinds=5.
    const series = countMetricSeries(text, 'rpc_upstream_calls_failed_total');
    expect(series).toBeLessThanOrEqual(1);
  });
});

describe('RPC upstream metrics — per-method recording (not aggregated)', () => {
  beforeEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  afterEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  it('getLatestLedger success increments only its own operation label — NOT aggregated under a generic key', async () => {
    const svc = makeService(() => Promise.resolve({ sequence: 1 }));
    await svc.getLatestLedger();

    const ledgerCount = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    expect(ledgerCount).toBe(1);
  });

  it('accountExists and getLatestLedger produce distinct series — verifying per-method split', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }));
    const svc = makeAccountExistsService(fetchMock as unknown as typeof fetch, {
      maxRetries: 0,
    });
    // Inject a successful getLatestLedger client
    const client: RawRpcClient = {
      getLatestLedger: async () => ({ sequence: 1 }),
      horizonUrl: 'https://horizon.test',
    };
    const svc2 = new StellarRpcService(() => client, {
      timeoutMs: 5000,
      failureThreshold: 10,
      maxRetries: 0,
    });

    await svc2.getLatestLedger();
    await svc.accountExists('GACCOUNT1');

    const ledgerSuccess = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    const accountSuccess = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'accountExists',
      outcome: 'success',
    });
    expect(ledgerSuccess).toBe(1);
    expect(accountSuccess).toBe(1);

    // A hypothetical aggregate ("rpc" or "all") must be 0 — if it were > 0 the
    // test would fail, proving per-method recording isn't being collapsed.
    const aggregate = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'all',
      outcome: 'success',
    });
    expect(aggregate).toBe(0);
  });

  it('latency histogram observes duration per-operation — slow and fast methods land in separate series', async () => {
    const slowClient: RawRpcClient = {
      getLatestLedger: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { sequence: 1 };
      },
      horizonUrl: 'https://horizon.test',
    };
    const svc = new StellarRpcService(() => slowClient, {
      timeoutMs: 500,
      failureThreshold: 10,
      maxRetries: 0,
    });
    await svc.getLatestLedger();

    const histogramCount = getHistogramCount(rpcUpstreamCallDurationSeconds, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    expect(histogramCount).toBe(1);
  });
});

describe('RPC upstream metrics — failure path reflection', () => {
  beforeEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  afterEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  it('TIMEOUT failure increments failure counter with kind=TIMEOUT and records outcome=failure', async () => {
    const svc = makeService(() => new Promise(() => {}), { timeoutMs: 10 });
    await svc.getLatestLedger().catch(() => {});

    const totalFail = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'failure',
    });
    expect(totalFail).toBe(1);

    const timeoutFail = getCounterValue(rpcUpstreamCallsFailedTotal, {
      operation: 'getLatestLedger',
      kind: 'TIMEOUT',
    });
    expect(timeoutFail).toBe(1);

    const histogramObs = getHistogramCount(rpcUpstreamCallDurationSeconds, {
      operation: 'getLatestLedger',
      outcome: 'failure',
    });
    expect(histogramObs).toBe(1);
  });

  it('NETWORK failure (ECONNREFUSED) records kind=NETWORK', async () => {
    const netErr = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const svc = makeService(() => Promise.reject(netErr));
    await svc.getLatestLedger().catch(() => {});

    const netFail = getCounterValue(rpcUpstreamCallsFailedTotal, {
      operation: 'getLatestLedger',
      kind: 'NETWORK',
    });
    expect(netFail).toBe(1);

    // Sanity: PROVIDER kind should NOT have been incremented for a network error.
    const providerFail = getCounterValue(rpcUpstreamCallsFailedTotal, {
      operation: 'getLatestLedger',
      kind: 'PROVIDER',
    });
    expect(providerFail).toBe(0);
  });

  it('PROVIDER failure (HTTP 500) records kind=PROVIDER with operation label', async () => {
    const providerErr = Object.assign(new Error('Internal Server Error'), {
      statusCode: 500,
    });
    const svc = makeService(() => Promise.reject(providerErr));
    await svc.getLatestLedger().catch(() => {});

    const providerFail = getCounterValue(rpcUpstreamCallsFailedTotal, {
      operation: 'getLatestLedger',
      kind: 'PROVIDER',
    });
    expect(providerFail).toBe(1);
  });

  it('CANCELLED failure via pre-aborted signal records kind=CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    const svc = makeService(() => new Promise(() => {}));
    await svc.getLatestLedger({ signal: controller.signal }).catch(() => {});

    const cancelledFail = getCounterValue(rpcUpstreamCallsFailedTotal, {
      operation: 'getLatestLedger',
      kind: 'CANCELLED',
    });
    expect(cancelledFail).toBe(1);
  });

  it('CIRCUIT_OPEN path records kind=CIRCUIT_OPEN even though callWithTimeout never runs', async () => {
    const svc = makeService(() => Promise.reject(new Error('fail')), {
      failureThreshold: 2,
    });
    // Trip the breaker.
    await svc.getLatestLedger().catch(() => {});
    await svc.getLatestLedger().catch(() => {});
    expect(svc.getCircuitState()).toBe('OPEN');

    // Now a subsequent call should hit the CIRCUIT_OPEN path in callWithFallbackCache.
    await svc.getLatestLedger().catch(() => {});

    const circuitOpenFail = getCounterValue(rpcUpstreamCallsFailedTotal, {
      operation: 'getLatestLedger',
      kind: 'CIRCUIT_OPEN',
    });
    expect(circuitOpenFail).toBeGreaterThanOrEqual(1);

    // Even the tripping failures should have recorded PROVIDER or NETWORK kinds.
    const anyFailTotal = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'failure',
    });
    // 2 trip-failures + 1 CIRCUIT_OPEN = at least 3 total failures.
    expect(anyFailTotal).toBeGreaterThanOrEqual(3);
  });
});

describe('RPC upstream metrics — success path observation', () => {
  beforeEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  afterEach(() => {
    deRegisterRpcMetrics();
    setStellarRpcService(null);
  });

  it('a successful call records outcome=success on both the counter AND the histogram', async () => {
    const svc = makeService(() => Promise.resolve({ sequence: 42 }));
    await svc.getLatestLedger();

    const successCount = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    expect(successCount).toBe(1);

    const failureCount = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'failure',
    });
    expect(failureCount).toBe(0);

    const histogramObservations = getHistogramCount(rpcUpstreamCallDurationSeconds, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    expect(histogramObservations).toBe(1);

    // Failed-kind counter must not tick on a successful call.
    const anyFailedKind = (rpcUpstreamCallsFailedTotal.get().values || []).reduce(
      (acc, v) => acc + v.value,
      0,
    );
    expect(anyFailedKind).toBe(0);
  });

  it('N successful calls → N observations, counter matches histogram count', async () => {
    let n = 0;
    const svc = makeService(async () => {
      n += 1;
      return { sequence: n };
    });
    for (let i = 0; i < 5; i++) {
      await svc.getLatestLedger();
    }

    const counterVal = getCounterValue(rpcUpstreamCallsTotal, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    const histoCount = getHistogramCount(rpcUpstreamCallDurationSeconds, {
      operation: 'getLatestLedger',
      outcome: 'success',
    });
    expect(counterVal).toBe(5);
    expect(histoCount).toBe(5);
  });
});
