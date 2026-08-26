import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serverTimingMiddleware, getServerTimingRegistry, createServerTimingRegistry } from '../../src/middleware/serverTiming.js';

describe('Server Timing middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SERVER_TIMING_ENABLED;
  });

  it('adds a Server-Timing header with sanitized phase timings when enabled', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/timed', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 12.5);
      registry.addPhase('serialize', 3.75);
      res.json({ ok: true });
    });

    const res = await request(app).get('/timed');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toBe('db;dur=12.5, serialize;dur=3.75');
  });

  it('does not emit the header when disabled by env', async () => {
    process.env.SERVER_TIMING_ENABLED = 'false';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/timed', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 12.5);
      res.json({ ok: true });
    });

    const res = await request(app).get('/timed');
    expect(res.headers['server-timing']).toBeUndefined();
  });

  it('sanitizes phase names and drops unsafe values', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/timed', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db\nInjected', 12.5);
      registry.addPhase('stellar_rpc', Number.NaN);
      registry.addPhase('serialize', 3.75);
      res.json({ ok: true });
    });

    const res = await request(app).get('/timed');
    expect(res.headers['server-timing']).toBe('serialize;dur=3.75');
  });

  it('keeps the header unset when no phases are recorded', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/empty', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/empty');
    expect(res.headers['server-timing']).toBeUndefined();
  });

  it('returns a stable snapshot for the current request', () => {
    const registry = createServerTimingRegistry();
    registry.addPhase('db', 12.5);
    registry.addPhase('serialize', 3.75);

    expect(registry.snapshot()).toEqual([
      { name: 'db', durationMs: 12.5 },
      { name: 'serialize', durationMs: 3.75 },
    ]);
  });

  it('handles res.end(chunk) without explicit encoding argument', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/end-no-encoding', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 10.0);
      res.end('response text');
    });

    const res = await request(app).get('/end-no-encoding');
    expect(res.status).toBe(200);
    expect(res.text).toBe('response text');
    expect(res.headers['server-timing']).toBe('db;dur=10');
  });

  it('handles res.end(chunk, encoding) with explicit encoding argument', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/end-with-encoding', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 15.0);
      res.end('response text', 'utf8');
    });

    const res = await request(app).get('/end-with-encoding');
    expect(res.status).toBe(200);
    expect(res.text).toBe('response text');
    expect(res.headers['server-timing']).toBe('db;dur=15');
  });
});
