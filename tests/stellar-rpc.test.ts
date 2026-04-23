import { vi as jest, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  StellarRpcService,
  CircuitBreaker,
  RpcProviderError,
  CircuitOpenError,
  setStellarRpcService,
  type RawRpcClient,
} from '../src/services/stellar-rpc.js';

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
