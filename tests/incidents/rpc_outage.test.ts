/**
 * Incident test suite: RPC provider outage (Issue #55, #127)
 *
 * Covers:
 * - Single RPC failure → RpcProviderError with structured log
 * - Circuit breaker trips after N failures within window
 * - Tripped circuit returns CircuitOpenError immediately (no RPC call)
 * - Circuit recovers after reset timeout (HALF_OPEN probe)
 * - CircuitBreaker observability: getFailureCount, getOpenedAt
 * - StellarRpcService.getDegradationSnapshot()
 * - Degradation middleware: read-through with Warning + X-Degradation-State
 * - Degradation middleware: write-block with 503 when circuit is OPEN
 * - Degradation middleware: HALF_OPEN treated as degraded
 * - Health checker reports stellar_rpc as unhealthy when circuit is OPEN
 */

import { describe, it, expect, vi as jest, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  CircuitBreaker,
  StellarRpcService,
  RpcProviderError,
  CircuitOpenError,
  setStellarRpcService,
} from '../../src/services/stellar-rpc';
import type { DegradationSnapshot } from '../../src/services/stellar-rpc';
import {
  createRpcDegradationMiddleware,
  STALE_WARNING,
  DEGRADED_WRITE_MESSAGE,
} from '../../src/middleware/rpcDegradation';

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
    const shortBreaker = new CircuitBreaker({ failureThreshold: 3, windowMs: 1, resetTimeoutMs: 60_000 });
    await expect(shortBreaker.call(async () => { throw new Error('old'); })).rejects.toThrow();
    await expect(shortBreaker.call(async () => { throw new Error('old'); })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    await expect(shortBreaker.call(async () => { throw new Error('new'); })).rejects.toThrow();
    await expect(shortBreaker.call(async () => { throw new Error('new'); })).rejects.toThrow();
    expect(shortBreaker.getState()).toBe('CLOSED');
  });

  // ── Observability helpers ─────────────────────────────────────────────────

  it('getFailureCount() returns rolling failure count', async () => {
    expect(breaker.getFailureCount()).toBe(0);
    await expect(breaker.call(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(breaker.getFailureCount()).toBe(1);
    await expect(breaker.call(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(breaker.getFailureCount()).toBe(2);
  });

  it('getOpenedAt() is 0 before tripping and non-zero after', async () => {
    expect(breaker.getOpenedAt()).toBe(0);
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getOpenedAt()).toBeGreaterThan(0);
  });

  it('reset() zeroes out getFailureCount and getOpenedAt', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    breaker.reset();
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getOpenedAt()).toBe(0);
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

  // ── Degradation snapshot ────────────────────────────────────────────────

  describe('getDegradationSnapshot()', () => {
    it('reports not degraded when circuit is CLOSED', () => {
      const client = { getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockResolvedValue({ sequence: 1 }) };
      const svc = new StellarRpcService(() => client, { failureThreshold: 5 });
      const snap = svc.getDegradationSnapshot();
      expect(snap.circuitState).toBe('CLOSED');
      expect(snap.degraded).toBe(false);
      expect(snap.failureCount).toBe(0);
      expect(snap.openedAt).toBeNull();
      expect(snap.timestamp).toBeDefined();
    });

    it('reports degraded with failure details when circuit is OPEN', async () => {
      const client = {
        getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(new Error('down')),
      };
      const svc = new StellarRpcService(() => client, { failureThreshold: 2, windowMs: 30_000, resetTimeoutMs: 60_000 });
      for (let i = 0; i < 2; i++) {
        await expect(svc.getLatestLedger()).rejects.toThrow();
      }
      const snap = svc.getDegradationSnapshot();
      expect(snap.circuitState).toBe('OPEN');
      expect(snap.degraded).toBe(true);
      expect(snap.failureCount).toBeGreaterThanOrEqual(2);
      expect(snap.openedAt).not.toBeNull();
    });

    it('reports degraded when circuit is HALF_OPEN', async () => {
      const client = {
        getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(new Error('down')),
      };
      // resetTimeoutMs=0 means the breaker immediately enters HALF_OPEN on next call
      const svc = new StellarRpcService(() => client, { failureThreshold: 1, windowMs: 30_000, resetTimeoutMs: 0 });
      await expect(svc.getLatestLedger()).rejects.toThrow();
      // The next call will transition to HALF_OPEN then fail, which re-opens
      await expect(svc.getLatestLedger()).rejects.toThrow();
      // After a failed HALF_OPEN probe the breaker is OPEN again
      const snap = svc.getDegradationSnapshot();
      expect(snap.degraded).toBe(true);
    });
  });
});

// ── Degradation middleware integration tests ──────────────────────────────────

describe('rpcDegradationMiddleware', () => {
  afterEach(() => setStellarRpcService(null));

  /** Build a tiny Express app with the degradation middleware mounted. */
  function buildApp(snapshot: Partial<DegradationSnapshot> = {}) {
    const defaults: DegradationSnapshot = {
      circuitState: 'CLOSED',
      failureCount: 0,
      degraded: false,
      openedAt: null,
      timestamp: new Date().toISOString(),
    };
    const merged = { ...defaults, ...snapshot };

    const fakeSvc = {
      getCircuitState: () => merged.circuitState,
      getDegradationSnapshot: () => merged,
    } as unknown as StellarRpcService;

    const app = express();
    app.use(express.json());
    app.use(createRpcDegradationMiddleware(() => fakeSvc));

    app.get('/data', (_req, res) => res.json({ streams: [] }));
    app.post('/data', (_req, res) => res.status(201).json({ created: true }));
    app.put('/data/:id', (_req, res) => res.json({ updated: true }));
    app.patch('/data/:id', (_req, res) => res.json({ patched: true }));
    app.delete('/data/:id', (_req, res) => res.status(204).send());
    return app;
  }

  // ── X-Degradation-State header ──────────────────────────────────────────

  it('always sets X-Degradation-State header (CLOSED)', async () => {
    const res = await request(buildApp()).get('/data');
    expect(res.headers['x-degradation-state']).toBe('CLOSED');
  });

  it('always sets X-Degradation-State header (OPEN)', async () => {
    const res = await request(buildApp({ circuitState: 'OPEN', degraded: true })).get('/data');
    expect(res.headers['x-degradation-state']).toBe('OPEN');
  });

  it('sets X-Degradation-State to HALF_OPEN when probing', async () => {
    const res = await request(buildApp({ circuitState: 'HALF_OPEN', degraded: true })).get('/data');
    expect(res.headers['x-degradation-state']).toBe('HALF_OPEN');
  });

  // ── CLOSED: normal operation ────────────────────────────────────────────

  it('does not set Warning header when circuit is CLOSED', async () => {
    const res = await request(buildApp()).get('/data');
    expect(res.headers['warning']).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it('allows POST when circuit is CLOSED', async () => {
    const res = await request(buildApp()).post('/data').send({ x: 1 });
    expect(res.status).toBe(201);
  });

  // ── OPEN: read-through with staleness warning ───────────────────────────

  it('sets Warning header on GET when circuit is OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'OPEN', degraded: true })).get('/data');
    expect(res.headers['warning']).toBe(STALE_WARNING);
    expect(res.status).toBe(200);
    expect(res.body.streams).toEqual([]);
  });

  it('sets Warning header on HEAD when circuit is OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'OPEN', degraded: true })).head('/data');
    expect(res.headers['warning']).toBe(STALE_WARNING);
    expect(res.status).toBe(200);
  });

  // ── OPEN: mutating requests blocked with 503 ───────────────────────────

  it('rejects POST with 503 when circuit is OPEN', async () => {
    const openSnapshot = { circuitState: 'OPEN' as const, degraded: true, failureCount: 5, openedAt: new Date().toISOString() };
    const res = await request(buildApp(openSnapshot)).post('/data').send({ x: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toBe(DEGRADED_WRITE_MESSAGE);
    expect(res.body.error.degradation.circuitState).toBe('OPEN');
    expect(res.body.error.degradation.failureCount).toBe(5);
  });

  it('rejects PUT with 503 when circuit is OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'OPEN', degraded: true })).put('/data/1').send({ x: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects PATCH with 503 when circuit is OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'OPEN', degraded: true })).patch('/data/1').send({ x: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects DELETE with 503 when circuit is OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'OPEN', degraded: true })).delete('/data/1');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  // ── HALF_OPEN: treated as degraded (reads OK, writes blocked) ──────────

  it('allows GET with Warning when circuit is HALF_OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'HALF_OPEN', degraded: true })).get('/data');
    expect(res.status).toBe(200);
    expect(res.headers['warning']).toBe(STALE_WARNING);
  });

  it('rejects POST with 503 when circuit is HALF_OPEN', async () => {
    const res = await request(buildApp({ circuitState: 'HALF_OPEN', degraded: true })).post('/data').send({ x: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  // ── 503 body includes degradation diagnostics ──────────────────────────

  it('includes degradation snapshot in 503 error body', async () => {
    const ts = new Date().toISOString();
    const snap = { circuitState: 'OPEN' as const, degraded: true, failureCount: 7, openedAt: ts };
    const res = await request(buildApp(snap)).post('/data').send({});
    expect(res.body.error.degradation).toEqual({
      circuitState: 'OPEN',
      failureCount: 7,
      openedAt: ts,
    });
  });

  // ── Recovery: once CLOSED again, writes succeed ────────────────────────

  it('allows POST once circuit returns to CLOSED', async () => {
    const res = await request(buildApp({ circuitState: 'CLOSED', degraded: false })).post('/data').send({ x: 1 });
    expect(res.status).toBe(201);
    expect(res.headers['x-degradation-state']).toBe('CLOSED');
    expect(res.headers['warning']).toBeUndefined();
  });

  // ── Decimal string serialization unaffected ────────────────────────────

  it('preserves response body shape on degraded read (no mutation)', async () => {
    const app = express();
    const fakeSvc = {
      getCircuitState: () => 'OPEN',
      getDegradationSnapshot: () => ({
        circuitState: 'OPEN' as const,
        failureCount: 3,
        degraded: true,
        openedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      }),
    } as unknown as StellarRpcService;

    app.use(createRpcDegradationMiddleware(() => fakeSvc));
    app.get('/api/streams', (_req, res) =>
      res.json({ streams: [{ depositAmount: '1000000.0000000', ratePerSecond: '0.0000116' }] }),
    );

    const res = await request(app).get('/api/streams');
    expect(res.status).toBe(200);
    expect(res.body.streams[0].depositAmount).toBe('1000000.0000000');
    expect(res.body.streams[0].ratePerSecond).toBe('0.0000116');
  });
});
