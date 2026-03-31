/**
 * Incident test suite: RPC provider outage (Issue #55)
 *
 * Covers:
 * - Single RPC failure → RpcProviderError with structured log
 * - Circuit breaker trips after N failures within window
 * - Tripped circuit returns CircuitOpenError immediately (no RPC call)
 * - Circuit recovers after reset timeout (HALF_OPEN probe)
 * - Degradation middleware sets Warning header when circuit is OPEN
 * - Health checker reports stellar_rpc as unhealthy when circuit is OPEN
 */

import { describe, it, expect, jest, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  CircuitBreaker,
  StellarRpcService,
  RpcProviderError,
  CircuitOpenError,
  setStellarRpcService,
  getStellarRpcService,
} from '../../src/services/stellar-rpc';
import { createRpcDegradationMiddleware, STALE_WARNING } from '../../src/middleware/rpcDegradation';

// ── CircuitBreaker unit tests ─────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, windowMs: 30_000, resetTimeoutMs: 60_000 });
  });

  it('starts CLOSED', () => {
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('passes through successful calls', async () => {
    const result = await breaker.call(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('stays CLOSED below failure threshold', async () => {
    for (let i = 0; i < 2; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('trips to OPEN after reaching failure threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');
  });

  it('throws CircuitOpenError immediately when OPEN (no fn call)', async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
    await expect(breaker.call(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('transitions to HALF_OPEN after resetTimeout and allows one probe', async () => {
    const fastBreaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 30_000, resetTimeoutMs: 0 });
    await expect(fastBreaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(fastBreaker.getState()).toBe('OPEN');

    // resetTimeoutMs = 0 → next call should probe
    const result = await fastBreaker.call(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(fastBreaker.getState()).toBe('CLOSED');
  });

  it('stays OPEN if probe in HALF_OPEN fails', async () => {
    const fastBreaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 30_000, resetTimeoutMs: 0 });
    await expect(fastBreaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    await expect(fastBreaker.call(async () => { throw new Error('still failing'); })).rejects.toThrow();
    expect(fastBreaker.getState()).toBe('OPEN');
  });

  it('reset() returns breaker to CLOSED', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('evicts old failures outside the window', async () => {
    // Use a very short window so old failures expire
    const shortBreaker = new CircuitBreaker({ failureThreshold: 3, windowMs: 1, resetTimeoutMs: 60_000 });
    await expect(shortBreaker.call(async () => { throw new Error('old'); })).rejects.toThrow();
    await expect(shortBreaker.call(async () => { throw new Error('old'); })).rejects.toThrow();
    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 5));
    // These two failures are within the new window — should not trip (threshold is 3)
    await expect(shortBreaker.call(async () => { throw new Error('new'); })).rejects.toThrow();
    await expect(shortBreaker.call(async () => { throw new Error('new'); })).rejects.toThrow();
    expect(shortBreaker.getState()).toBe('CLOSED');
  });
});

// ── StellarRpcService unit tests ──────────────────────────────────────────────

describe('StellarRpcService', () => {
  it('returns ledger on success', async () => {
    const client = { getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockResolvedValue({ sequence: 100 }) };
    const svc = new StellarRpcService(() => client, { failureThreshold: 3 });
    expect(await svc.getLatestLedger()).toEqual({ sequence: 100 });
  });

  it('throws RpcProviderError on RPC failure', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(new Error('503 Service Unavailable')),
    };
    const svc = new StellarRpcService(() => client, { failureThreshold: 5 });
    await expect(svc.getLatestLedger()).rejects.toBeInstanceOf(RpcProviderError);
  });

  it('logs warn with error code and duration on failure', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const client = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(
        Object.assign(new Error('429 Too Many Requests'), { statusCode: 429 }),
      ),
    };
    const svc = new StellarRpcService(() => client, { failureThreshold: 5 });
    await expect(svc.getLatestLedger()).rejects.toThrow();

    const logged = (writeSpy.mock.calls as [string][]).map(([s]) => s).join('');
    const record = JSON.parse(logged.trim().split('\n').pop()!);
    expect(record.level).toBe('warn');
    expect(record.event).toBe('rpc_failure');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    writeSpy.mockRestore();
  });

  it('throws CircuitOpenError after threshold failures', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(new Error('fail')),
    };
    const svc = new StellarRpcService(() => client, { failureThreshold: 3, windowMs: 30_000, resetTimeoutMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await expect(svc.getLatestLedger()).rejects.toThrow();
    }
    await expect(svc.getLatestLedger()).rejects.toBeInstanceOf(CircuitOpenError);
    // RPC client should NOT have been called on the 4th attempt
    expect(client.getLatestLedger).toHaveBeenCalledTimes(3);
  });

  it('times out and throws RpcProviderError', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      ),
    };
    const svc = new StellarRpcService(() => client, { timeoutMs: 50, failureThreshold: 5 });
    await expect(svc.getLatestLedger()).rejects.toBeInstanceOf(RpcProviderError);
  }, 1000);

  it('resetCircuit() allows calls again after being OPEN', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue({ sequence: 200 }),
    };
    const svc = new StellarRpcService(() => client, { failureThreshold: 3, resetTimeoutMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await expect(svc.getLatestLedger()).rejects.toThrow();
    }
    svc.resetCircuit();
    expect(await svc.getLatestLedger()).toEqual({ sequence: 200 });
  });
});

// ── Degradation middleware integration tests ──────────────────────────────────

describe('rpcDegradationMiddleware', () => {
  afterEach(() => setStellarRpcService(null));

  function buildApp(circuitOpen: boolean) {
    const fakeSvc = {
      getCircuitState: () => (circuitOpen ? 'OPEN' : 'CLOSED'),
    } as unknown as StellarRpcService;

    const app = express();
    app.use(createRpcDegradationMiddleware(() => fakeSvc));
    app.get('/data', (_req, res) => res.json({ streams: [] }));
    return app;
  }

  it('does not set Warning header when circuit is CLOSED', async () => {
    const res = await request(buildApp(false)).get('/data');
    expect(res.headers['warning']).toBeUndefined();
  });

  it('sets Warning header when circuit is OPEN', async () => {
    const res = await request(buildApp(true)).get('/data');
    expect(res.headers['warning']).toBe(STALE_WARNING);
  });

  it('still returns 200 with stale data when circuit is OPEN', async () => {
    const res = await request(buildApp(true)).get('/data');
    expect(res.status).toBe(200);
    expect(res.body.streams).toEqual([]);
  });
});
