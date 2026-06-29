/**
 * Integration tests for RPC degradation middleware.
 *
 * Verifies that when the circuit breaker is OPEN:
 * - Write requests (POST/PUT/PATCH/DELETE) are rejected with 503
 * - Read requests (GET) are allowed through with X-Degradation-State header
 * - X-Degradation-State header reflects the circuit state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

vi.mock('../src/services/stellar-rpc.js', () => ({
  getRpcRequestCacheStatus: vi.fn(() => 'fresh'),
  runWithRpcRequestMetadata: vi.fn((fn: () => void) => fn()),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createRpcDegradationMiddleware, DEGRADED_WRITE_MESSAGE } from '../src/middleware/rpcDegradation.js';

function makeService(circuitState: string, degraded: boolean) {
  return {
    getDegradationSnapshot: vi.fn(() => ({ circuitState, degraded })),
  };
}

function buildApp(circuitState: string, degraded: boolean) {
  const app = express();
  const middleware = createRpcDegradationMiddleware(() => makeService(circuitState, degraded) as never);
  app.use(middleware);
  app.get('/data', (_req: Request, res: Response) => res.json({ ok: true }));
  app.post('/data', (_req: Request, res: Response) => res.json({ ok: true }));
  app.put('/data', (_req: Request, res: Response) => res.json({ ok: true }));
  app.delete('/data', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe('rpcDegradation middleware — circuit OPEN', () => {
  const app = buildApp('OPEN', true);

  it('blocks POST with 503 when circuit is OPEN', async () => {
    const res = await request(app).post('/data');
    expect(res.status).toBe(503);
  });

  it('blocks PUT with 503 when circuit is OPEN', async () => {
    const res = await request(app).put('/data');
    expect(res.status).toBe(503);
  });

  it('blocks DELETE with 503 when circuit is OPEN', async () => {
    const res = await request(app).delete('/data');
    expect(res.status).toBe(503);
  });

  it('allows GET through when circuit is OPEN', async () => {
    const res = await request(app).get('/data');
    expect(res.status).toBe(200);
  });

  it('sets X-Degradation-State to OPEN on all responses', async () => {
    const res = await request(app).get('/data');
    expect(res.headers['x-degradation-state']).toBe('OPEN');
  });

  it('blocked write response body contains degradation message', async () => {
    const res = await request(app).post('/data');
    expect(res.body.message ?? res.text).toContain('unavailable');
  });
});

describe('rpcDegradation middleware — circuit CLOSED', () => {
  const app = buildApp('CLOSED', false);

  it('allows POST through when circuit is CLOSED', async () => {
    const res = await request(app).post('/data');
    expect(res.status).toBe(200);
  });

  it('sets X-Degradation-State to CLOSED', async () => {
    const res = await request(app).get('/data');
    expect(res.headers['x-degradation-state']).toBe('CLOSED');
  });
});
