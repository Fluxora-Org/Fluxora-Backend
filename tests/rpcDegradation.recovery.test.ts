/**
 * End-to-end tests for RPC degradation visibility and automatic recovery.
 *
 * These tests drive the real `StellarRpcService` circuit breaker with the
 * `rpcDegradationMiddleware` mounted on an Express app. The upstream RPC is
 * taken "down" and then back "up", asserting that:
 *
 *   1. degraded responses are marked to callers,
 *   2. entry to and exit from degraded mode are exposed as metrics,
 *   3. the service recovers automatically once the upstream is healthy again.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StellarRpcService, type RawRpcClient } from '../src/services/stellar-rpc.js';
import {
  createRpcDegradationMiddleware,
  DEGRADED_WRITE_MESSAGE,
  STALE_WARNING,
} from '../src/middleware/rpcDegradation.js';
import { InMemoryRpcFallbackCache } from '../src/redis/rpcFallbackCache.js';
import {
  rpcDegradationTransitionsTotal,
  rpcDegradedModeGauge,
} from '../src/metrics/rpcMetrics.js';

/** Short reset timeout keeps the automatic-recovery wait bounded. */
const RESET_TIMEOUT_MS = 25;
const RECOVERY_WAIT_MS = 100;

async function transitionCount(from: string, to: string): Promise<number> {
  const metric = await rpcDegradationTransitionsTotal.get();
  const match = metric.values.find(
    (v) => (v.labels as Record<string, string>).from === from
      && (v.labels as Record<string, string>).to === to,
  );
  return match?.value ?? 0;
}

async function degradedModeGaugeValue(): Promise<number | undefined> {
  const metric = await rpcDegradedModeGauge.get();
  return metric.values[0]?.value;
}

function buildApp(svc: StellarRpcService) {
  const app = express();
  app.use(createRpcDegradationMiddleware(() => svc));
  app.get('/data', (_req: Request, res: Response) => res.json({ ok: true }));
  app.post('/data', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe('RPC degradation visibility and automatic recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks degraded responses, exposes metrics, and recovers automatically', async () => {
    let upstreamHealthy = true;
    const getLatestLedger = vi.fn(async () => {
      if (!upstreamHealthy) throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      return { sequence: 42 };
    });
    const svc = new StellarRpcService(
      (): RawRpcClient => ({ getLatestLedger }),
      {
        failureThreshold: 1,
        resetTimeoutMs: RESET_TIMEOUT_MS,
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackCache: new InMemoryRpcFallbackCache(),
        fallbackCacheTtlSeconds: 60,
      },
    );
    const app = buildApp(svc);

    // Baseline: upstream healthy, circuit CLOSED, responses unmarked.
    let res = await request(app).get('/data');
    expect(res.status).toBe(200);
    expect(res.headers['x-degradation-state']).toBe('CLOSED');
    expect(res.headers['warning']).toBeUndefined();

    // Take the upstream down: a single failed call trips the breaker.
    upstreamHealthy = false;
    await expect(svc.getLatestLedger()).rejects.toThrow(/ECONNREFUSED/);
    expect(svc.getCircuitState()).toBe('OPEN');
    expect(svc.getDegradationSnapshot().degraded).toBe(true);

    const entriesBefore = await transitionCount('CLOSED', 'OPEN');

    // Degraded path: reads are allowed but marked stale.
    res = await request(app).get('/data');
    expect(res.status).toBe(200);
    expect(res.headers['x-degradation-state']).toBe('OPEN');
    expect(res.headers['warning']).toBe(STALE_WARNING);

    // Degraded path: writes are rejected with a structured degradation payload.
    res = await request(app).post('/data');
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe(DEGRADED_WRITE_MESSAGE);
    expect(res.body.error.degradation.circuitState).toBe('OPEN');

    // Entry into degradation is exposed as a metric.
    expect(await transitionCount('CLOSED', 'OPEN')).toBe(entriesBefore + 1);
    expect(await degradedModeGaugeValue()).toBe(1);

    // Bring the upstream back up. After the reset timeout elapses the next call
    // is admitted as an automatic HALF_OPEN probe that closes the circuit --
    // no manual reset is performed.
    upstreamHealthy = true;
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_WAIT_MS));
    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 42 });
    expect(svc.getCircuitState()).toBe('CLOSED');

    const exitsBefore = await transitionCount('OPEN', 'CLOSED');

    // The next request observes the recovered circuit: no stale marking.
    res = await request(app).get('/data');
    expect(res.status).toBe(200);
    expect(res.headers['x-degradation-state']).toBe('CLOSED');
    expect(res.headers['warning']).toBeUndefined();
    expect(res.body).toEqual({ ok: true });

    // Exit from degradation is exposed as a metric.
    expect(await transitionCount('OPEN', 'CLOSED')).toBe(exitsBefore + 1);
    expect(await degradedModeGaugeValue()).toBe(0);
  });
});
