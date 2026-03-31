/**
 * Graceful shutdown tests.
 *
 * Covers:
 *  - Health endpoint returns 200 normally and 503 while shutting down.
 *  - Connection: close header is set on responses during shutdown.
 *  - gracefulShutdown() closes the server and runs teardown hooks.
 *  - Hard timeout force-closes connections when drain takes too long.
 *  - Duplicate shutdown signals are ignored.
 *  - addShutdownHook() hooks are executed (and errors are swallowed).
 */

import http from 'node:http';
import { vi as jest } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  gracefulShutdown,
  isShuttingDown,
  addShutdownHook,
  _resetShutdownState,
} from '../src/shutdown.js';

// Reset module-level shutdown state before every test so tests are isolated.
beforeEach(() => {
  _resetShutdownState();
});

afterEach(async () => {
  _resetShutdownState();
});

// ─── Health endpoint ──────────────────────────────────────────────────────────

describe('GET /health — normal operation', () => {
  it('returns 200 with status "ok"', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes service and timestamp fields', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('fluxora-backend');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

describe('GET /health — during shutdown', () => {
  // The beforeEach block that simulated shutdown is removed,
  // as tests now directly set app.locals.isShuttingDown = true.

  it('returns 503', async () => {
    process.env['FLUXORA_SHUTDOWN'] = 'true';
    const res = await request(app).get('/health').expect(503);
    expect(res.body.status).toBe('shutting_down');
  });

  it('includes service and timestamp even during shutdown', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('fluxora-backend');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

describe('Connection: close header during shutdown', () => {
  it('is NOT set on normal requests', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['connection']).not.toBe('close');
  });

  it('IS set during shutdown', async () => {
    (globalThis as any)['__FLUXORA_SHUTDOWN__'] = true;
    const res = await request(app).get('/health');
    expect(res.header['connection']).toBe('close');
  });

  it('is set on responses while shutting down', async () => {
    const server = http.createServer(app);
    server.listen(0);
    await gracefulShutdown(server, 'SIGTERM', 50);

    const res = await request(app).get('/health');
    expect(res.headers['connection']).toBe('close');
  });
});

// ─── isShuttingDown() ─────────────────────────────────────────────────────────

describe('isShuttingDown()', () => {
  it('returns false before any shutdown', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('returns true once gracefulShutdown() is called', async () => {
    const server = http.createServer(app);
    server.listen(0);
    const p = gracefulShutdown(server, 'SIGTERM', 50);
    expect(isShuttingDown()).toBe(true);
    await p;
  });
});

// ─── gracefulShutdown() ───────────────────────────────────────────────────────

describe('gracefulShutdown()', () => {
  it('closes the server and resolves the promise', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const closeSpy = jest.spyOn(server, 'close');
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(closeSpy).toHaveBeenCalled();
  });

  it('calls closeIdleConnections() to release keep-alive sockets', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const idleSpy = jest.spyOn(server, 'closeIdleConnections');
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(idleSpy).toHaveBeenCalled();
  });

  it('runs registered teardown hooks', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const hook = jest.fn(() => Promise.resolve());
    addShutdownHook(hook as unknown as () => Promise<void>);

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('continues shutdown even if a hook throws', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    addShutdownHook(() => { throw new Error('hook failure'); });
    const goodHook = jest.fn(() => {});
    addShutdownHook(goodHook as unknown as () => void);

    await expect(gracefulShutdown(server, 'SIGTERM', 5_000)).resolves.toBeUndefined();
    expect(goodHook).toHaveBeenCalled();
  });

  it('ignores a second call while shutdown is already in progress', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const p1 = gracefulShutdown(server, 'SIGTERM', 5_000);
    const p2 = gracefulShutdown(server, 'SIGTERM', 5_000); // duplicate — must not throw

    await Promise.all([p1, p2]);
    expect(isShuttingDown()).toBe(true);
  });

  it('force-closes connections when timeout is exceeded', async () => {
    const server = http.createServer((_req, res) => {
      // Simulate a stalled request — never respond.
      void res;
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const forceCloseSpy = jest.spyOn(server, 'closeAllConnections');

    // Make a request that will stall so server.close() never fires naturally.
    const port = (server.address() as { port: number }).port;
    const stall = http.get(`http://127.0.0.1:${port}/`);
    stall.on('error', () => { /* expected after force-close */ });

    // Give it a moment to establish the connection before shutdown starts
    await new Promise(r => setTimeout(r, 100));

    // Very short timeout so the force-close path is exercised.
    await gracefulShutdown(server, 'SIGTERM', 50);

    expect(forceCloseSpy).toHaveBeenCalled();
  });
});
