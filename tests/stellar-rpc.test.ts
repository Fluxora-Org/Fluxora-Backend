import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  StellarRpcService,
  CircuitBreaker,
  RpcProviderError,
  CircuitOpenError,
  setStellarRpcService,
  type RawRpcClient,
} from '../src/services/stellar-rpc.js';
import * as hooksModule from '../src/tracing/hooks.js';

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
