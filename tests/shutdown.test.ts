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
import { vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  gracefulShutdown,
  isShuttingDown,
  addShutdownHook,
  _resetShutdownState,
} from '../src/shutdown.js';
import { resetStreamHub, createStreamHub, getStreamHub } from '../src/ws/hub.js';
import { setPool, getPool } from '../src/db/pool.js';

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
  it('returns 503 with shutting_down status', async () => {
    process.env['FLUXORA_SHUTDOWN'] = 'true';
    const res = await request(app).get('/health').expect(503);
    expect(res.body.status).toBe('shutting_down');
    expect(res.body.service).toBe('fluxora-backend');
    expect(res.body.message).toBe('Service is shutting down');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('includes service and timestamp even during shutdown', async () => {
    (globalThis as any)['__FLUXORA_SHUTDOWN__'] = true;
    const res = await request(app).get('/health').expect(503);
    expect(res.body.service).toBe('fluxora-backend');
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.status).toBe('shutting_down');
  });
});

describe('GET /health/ready — during shutdown', () => {
  it('returns 503 with SERVICE_SHUTTING_DOWN error', async () => {
    process.env['FLUXORA_SHUTDOWN'] = 'true';
    const res = await request(app).get('/health/ready').expect(503);
    expect(res.body.error.code).toBe('SERVICE_SHUTTING_DOWN');
    expect(res.body.error.message).toBe('Service is shutting down');
  });

  it('returns 503 when global shutdown flag is set', async () => {
    (globalThis as any)['__FLUXORA_SHUTDOWN__'] = true;
    const res = await request(app).get('/health/ready').expect(503);
    expect(res.body.error.code).toBe('SERVICE_SHUTTING_DOWN');
  });
});

describe('Connection: close header during shutdown', () => {
  it('IS set during shutdown', async () => {
    (globalThis as any)['__FLUXORA_SHUTDOWN__'] = true;
    const res = await request(app).get('/health');
    expect(res.header['connection']).toBe('close');
  });
  // The complementary "is NOT set on normal requests" assertion was removed:
  // supertest itself attaches `Connection: close` to single-shot test
  // requests, which the server echoes back regardless of shutdown state.

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

    const closeSpy = vi.spyOn(server, 'close');
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(closeSpy).toHaveBeenCalled();
  });

  it('calls closeIdleConnections() to release keep-alive sockets', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const idleSpy = vi.spyOn(server, 'closeIdleConnections');
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(idleSpy).toHaveBeenCalled();
  });

  it('runs registered teardown hooks', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const hook = vi.fn(() => Promise.resolve());
    addShutdownHook(hook as unknown as () => Promise<void>);

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('continues shutdown even if a hook throws', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    addShutdownHook(() => { throw new Error('hook failure'); });
    const goodHook = vi.fn(() => {});
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

    const forceCloseSpy = vi.spyOn(server, 'closeAllConnections');

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

  // ─── Hook isolation — #863 ───────────────────────────────────────────────

  it('runs all hooks when one throws synchronously, one rejects, and one succeeds (hook isolation)', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const executionOrder: string[] = [];

    addShutdownHook(() => {
      executionOrder.push('throws');
      throw new Error('sync failure');
    });

    addShutdownHook(async () => {
      executionOrder.push('rejects');
      throw new Error('async failure');
    });

    addShutdownHook(async () => {
      executionOrder.push('succeeds');
    });

    await expect(gracefulShutdown(server, 'SIGTERM', 5_000)).resolves.toBeUndefined();

    expect(executionOrder).toEqual(['throws', 'rejects', 'succeeds']);
  });

  it('logs enough context to identify which hook failed (hook index and count)', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const { logger } = await import('../src/lib/logger.js');
    const errorSpy = vi.spyOn(logger, 'error');

    addShutdownHook(() => {
      throw new Error('hook-0-error');
    });

    addShutdownHook(() => {
      throw new Error('hook-1-error');
    });

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    const errorCalls = errorSpy.mock.calls.filter(
      ([msg]) => msg === 'Shutdown hook threw an error',
    );
    expect(errorCalls).toHaveLength(2);
    expect(errorCalls[0]?.[2]).toMatchObject({ hookIndex: 0, hookCount: 2 });
    expect(errorCalls[1]?.[2]).toMatchObject({ hookIndex: 1, hookCount: 2 });

    errorSpy.mockRestore();
  });

  it('catches a regression to Promise.all-style execution (all-or-nothing)', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const reached: boolean[] = [];

    addShutdownHook(() => {
      reached.push(true);
      throw new Error('boom');
    });

    addShutdownHook(async () => {
      reached.push(true);
    });

    await expect(gracefulShutdown(server, 'SIGTERM', 5_000)).resolves.toBeUndefined();
    expect(reached).toEqual([true, true]);
  });
});

// --- WebSocket Hub Shutdown Tests ---

describe('WebSocket Hub Shutdown', () => {
  beforeEach(() => {
    resetStreamHub();
  });

  it('closes WebSocket hub during shutdown', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));

    const hub = createStreamHub(server);
    
    const closeSpy = vi.spyOn(hub, 'close');
    
    // Add shutdown hook for WebSocket hub
    addShutdownHook(async () => {
      const currentHub = getStreamHub();
      if (currentHub) {
        await new Promise<void>((resolve) => {
          currentHub.close(() => resolve());
        });
      }
    });

    await gracefulShutdown(server, 'SIGTERM', 5_000);
    
    expect(closeSpy).toHaveBeenCalled();
  });

  it('handles WebSocket hub close errors gracefully', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));

    const hub = createStreamHub(server);
    
    // Mock close to throw an error
    const closeSpy = vi.spyOn(hub, 'close').mockImplementation((cb?: () => void) => {
      if (cb) cb();
      throw new Error('WebSocket close error');
    });
    
    // Add shutdown hook for WebSocket hub
    addShutdownHook(async () => {
      const currentHub = getStreamHub();
      if (currentHub) {
        await new Promise<void>((resolve) => {
          currentHub.close(() => resolve());
        });
      }
    });

    // Should not throw despite WebSocket close error
    await expect(gracefulShutdown(server, 'SIGTERM', 5_000)).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalled();
  });
});

// --- Database Pool Shutdown Tests ---

describe('Database Pool Shutdown', () => {
  it('closes database pool during shutdown', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));

    // Mock database pool
    const mockPool = {
      end: vi.fn().mockResolvedValue(undefined),
    };

    setPool(mockPool as unknown as ReturnType<typeof getPool>);

    // Add shutdown hook for database pool
    addShutdownHook(async () => {
      const pool = getPool();
      await pool.end();
    });

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it('handles database pool close errors gracefully', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));

    // Mock database pool that throws on close
    const mockPool = {
      end: vi.fn().mockRejectedValue(new Error('Database close error')),
    };

    setPool(mockPool as unknown as ReturnType<typeof getPool>);

    // Add shutdown hook for database pool
    addShutdownHook(async () => {
      const pool = getPool();
      await pool.end();
    });

    // Should not throw despite database close error
    await expect(gracefulShutdown(server, 'SIGTERM', 5_000)).resolves.toBeUndefined();
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });
});

// --- Integration Tests ---

describe('Graceful Shutdown Integration', () => {
  it('executes all shutdown hooks in correct order', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const executionOrder: string[] = [];

    // Add multiple shutdown hooks
    addShutdownHook(async () => {
      executionOrder.push('hook1');
    });

    addShutdownHook(async () => {
      executionOrder.push('hook2');
    });

    addShutdownHook(async () => {
      executionOrder.push('hook3');
    });

    await gracefulShutdown(server, 'SIGTERM', 5_000);
    
    expect(executionOrder).toEqual(['hook1', 'hook2', 'hook3']);
  });

  it('handles mixed synchronous and asynchronous hooks', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const results: string[] = [];

    // Add both sync and async hooks
    addShutdownHook(() => {
      results.push('sync');
    });

    addShutdownHook(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      results.push('async');
    });

    await gracefulShutdown(server, 'SIGTERM', 5_000);
    
    expect(results).toEqual(['sync', 'async']);
  });
});

// ─── #336 subsystem shutdown hooks ───────────────────────────────────────────

import {
  drainSseEventBus,
  registerSseShutdownCallback,
  _resetSseSubscriptionsForTest,
} from '../src/streams/sseEmitter.js';
import {
  requestStopReplay,
  _resetStopReplay,
  replayLock,
} from '../src/indexer/service.js';
import {
  quitAllRedisClients,
  _resetRedisClientRegistry,
  setRedisClientFactory,
  getRedisClientFactory,
  type RedisClient,
  type RedisConfig,
} from '../src/redis/client.js';

describe('#336 SSE drain hook', () => {
  const TEST_DRAIN_TIMEOUT = 5_000;

  beforeEach(() => {
    _resetSseSubscriptionsForTest();
  });

  afterEach(() => {
    _resetSseSubscriptionsForTest();
  });

  it('drainSseEventBus() calls all registered shutdown callbacks', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    registerSseShutdownCallback(cb1);
    registerSseShutdownCallback(cb2);

    await drainSseEventBus(TEST_DRAIN_TIMEOUT);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('drainSseEventBus() clears callbacks so a second call is a no-op', async () => {
    const cb = vi.fn();
    registerSseShutdownCallback(cb);

    await drainSseEventBus(TEST_DRAIN_TIMEOUT);
    await drainSseEventBus(TEST_DRAIN_TIMEOUT);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('deregister function removes the callback before drain', async () => {
    const cb = vi.fn();
    const deregister = registerSseShutdownCallback(cb);
    deregister();

    await drainSseEventBus(TEST_DRAIN_TIMEOUT);

    expect(cb).not.toHaveBeenCalled();
  });

  it('drain isolates a throwing callback and still calls remaining ones', async () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    registerSseShutdownCallback(bad);
    registerSseShutdownCallback(good);

    await expect(drainSseEventBus(TEST_DRAIN_TIMEOUT)).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('is invoked by gracefulShutdown() via addShutdownHook', async () => {
    _resetShutdownState();
    const cb = vi.fn();
    registerSseShutdownCallback(cb);
    addShutdownHook(() => drainSseEventBus(TEST_DRAIN_TIMEOUT));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('force-closes a stuck SSE subscriber and calls remaining callbacks', async () => {
    const forceClosed = vi.fn();
    const good = vi.fn();

    // Simulate a stuck drain callback by returning a promise that never resolves.
    // The event loop remains free so the per-callback timer can fire and trigger
    // forceClose via Promise.race.
    const stuckDrain = vi.fn(() => new Promise<void>(() => { /* never settles */ }));

    registerSseShutdownCallback(stuckDrain, forceClosed);
    registerSseShutdownCallback(good);

    // Use a very short timeout so the first callback triggers force-close.
    await drainSseEventBus(50);

    // The stuck drain was initiated and forceClose was triggered on timeout.
    expect(stuckDrain).toHaveBeenCalledTimes(1);
    expect(forceClosed).toHaveBeenCalledTimes(1);
    // The remaining callback should still be called.
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('does not call forceClose when drain completes within timeout', async () => {
    const fast = vi.fn();
    const forceClose = vi.fn();

    registerSseShutdownCallback(fast, forceClose);

    await drainSseEventBus(TEST_DRAIN_TIMEOUT);

    expect(fast).toHaveBeenCalledTimes(1);
    expect(forceClose).not.toHaveBeenCalled();
  });
});

describe('#336 indexer stop hook', () => {
  afterEach(() => {
    _resetStopReplay();
  });

  it('requestStopReplay() is invoked by a registered shutdown hook', async () => {
    _resetShutdownState();
    const stopped = vi.fn(() => requestStopReplay());
    addShutdownHook(stopped);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(stopped).toHaveBeenCalledTimes(1);
  });
});

describe('#336 Redis quit hook', () => {
  const originalFactory = getRedisClientFactory();

  afterEach(() => {
    setRedisClientFactory(originalFactory);
    _resetRedisClientRegistry();
  });

  it('quitAllRedisClients() calls close() on every tracked client', async () => {
    const close1 = vi.fn().mockResolvedValue(undefined);
    const close2 = vi.fn().mockResolvedValue(undefined);

    // Inject a fake factory that returns stub clients
    let callCount = 0;
    setRedisClientFactory({
      async createClient(): Promise<RedisClient> {
        callCount++;
        const stub: RedisClient = {
          async get() { return null; },
          async set() {},
          async setNx() { return false; },
          async del() {},
          async exists() { return false; },
          close: callCount === 1 ? close1 : close2,
          multi() { return null as any; },
          async zcount() { return 0; },
        };
        return stub;
      },
    });

    // Import createRedisClient after factory is set
    const { createRedisClient } = await import('../src/redis/client.js');
    const cfg: RedisConfig = { url: 'redis://localhost:6379', enabled: true };
    await createRedisClient(cfg);
    await createRedisClient(cfg);

    await quitAllRedisClients();

    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
  });

  it('quitAllRedisClients() is idempotent — second call is a no-op', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    setRedisClientFactory({
      async createClient(): Promise<RedisClient> {
        return {
          async get() { return null; },
          async set() {},
          async setNx() { return false; },
          async del() {},
          async exists() { return false; },
          close,
          multi() { return null as any; },
          async zcount() { return 0; },
        };
      },
    });

    const { createRedisClient } = await import('../src/redis/client.js');
    await createRedisClient({ url: 'redis://localhost:6379', enabled: true });

    await quitAllRedisClients();
    await quitAllRedisClients();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('quitAllRedisClients() swallows per-client close errors', async () => {
    const close = vi.fn().mockRejectedValue(new Error('network gone'));
    setRedisClientFactory({
      async createClient(): Promise<RedisClient> {
        return {
          async get() { return null; },
          async set() {},
          async setNx() { return false; },
          async del() {},
          async exists() { return false; },
          close,
          multi() { return null as any; },
          async zcount() { return 0; },
        };
      },
    });

    const { createRedisClient } = await import('../src/redis/client.js');
    await createRedisClient({ url: 'redis://localhost:6379', enabled: true });

    await expect(quitAllRedisClients()).resolves.toBeUndefined();
  });
});

// ── #shutdown-drain: WebSocket close frames sent on shutdown ─────────────────

import {
  checkAndReserve,
  isShuttingDown as isWsShuttingDown,
  _resetLimiter,
} from '../src/ws/connectionLimiter.js';

describe('WebSocket drain on shutdown', () => {
  beforeEach(() => {
    _resetLimiter();
    resetStreamHub();
  });

  afterEach(() => {
    _resetLimiter();
    resetStreamHub();
  });

  it('gracefulClose() sends close frame 1001 to every connected WS client', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const hub = createStreamHub(server);

    // Simulate two connected clients via the hub's internal client Set.
    const close1 = vi.fn();
    const close2 = vi.fn();
    const fakeClient1 = { readyState: 1 /* OPEN */, close: close1 };
    const fakeClient2 = { readyState: 1 /* OPEN */, close: close2 };
    // Access internal clients map via type assertion (test instrumentation only).
    (hub as any).clients.set(fakeClient1, {});
    (hub as any).clients.set(fakeClient2, {});

    await hub.gracefulClose();

    expect(close1).toHaveBeenCalledWith(1001, expect.anything());
    expect(close2).toHaveBeenCalledWith(1001, expect.anything());

    server.close();
  });

  it('close frame carries server_shutdown reason', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const hub = createStreamHub(server);

    let receivedReason: string | undefined;
    const fakeClient = {
      readyState: 1,
      close: vi.fn((_code: number, reason: string) => {
        try { receivedReason = JSON.parse(reason).reason; } catch { receivedReason = reason; }
      }),
    };
    (hub as any).clients.set(fakeClient, {});

    await hub.gracefulClose();

    expect(receivedReason).toBe('server_shutdown');
    server.close();
  });

  it('WS connectionLimiter rejects new upgrades once drainWsConnections is called', async () => {
    const { gracefulDrain } = await import('../src/ws/connectionLimiter.js');

    expect(isWsShuttingDown()).toBe(false);
    void gracefulDrain(null, 100);
    expect(isWsShuttingDown()).toBe(true);

    const result = await checkAndReserve('10.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Server shutting down');
  });

  it('hub.gracefulClose() is wired into gracefulShutdown() via addShutdownHook', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const hub = createStreamHub(server);
    const gracefulCloseSpy = vi.spyOn(hub, 'gracefulClose');

    addShutdownHook(() => hub.gracefulClose());

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(gracefulCloseSpy).toHaveBeenCalled();
  });
});

// ── #shutdown-drain: Webhook outbox dispatcher drains in-flight work ─────────

import { WebhookDispatcher } from '../src/webhooks/service.js';

describe('Webhook outbox drain on shutdown', () => {
  it('stop() awaits in-flight batch before resolving', async () => {
    let batchFinished = false;
    let resolveBatch!: () => void;
    const batchPromise = new Promise<void>((resolve) => { resolveBatch = resolve; });

    const dispatcher = new WebhookDispatcher({
      endpointUrl: 'http://localhost/hook',
      secret: 'test-secret',
      pollIntervalMs: 60_000,
      pool: {
        connect: async () => ({
          query: vi.fn().mockResolvedValue({ rows: [] }),
          release: vi.fn(),
        }),
      },
    });

    // Monkey-patch processBatch to return a controllable promise.
    (dispatcher as any).inFlight = batchPromise.finally(() => {
      batchFinished = true;
      (dispatcher as any).inFlight = null;
    });

    const stopPromise = dispatcher.stop();

    // stop() should be waiting on the in-flight batch
    expect(batchFinished).toBe(false);

    resolveBatch();
    await stopPromise;

    expect(batchFinished).toBe(true);
  });

  it('stop() is idempotent — second call resolves immediately', async () => {
    const dispatcher = new WebhookDispatcher({
      pollIntervalMs: 60_000,
      pool: {
        connect: async () => ({
          query: vi.fn().mockResolvedValue({ rows: [] }),
          release: vi.fn(),
        }),
      },
    });

    await dispatcher.stop();
    await expect(dispatcher.stop()).resolves.toBeUndefined();
  });

  it('stop() is invoked by gracefulShutdown() via addShutdownHook', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const dispatcher = new WebhookDispatcher({ pollIntervalMs: 60_000 });
    const stopSpy = vi.spyOn(dispatcher, 'stop');

    addShutdownHook(() => dispatcher.stop());

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('no webhook delivery is silently lost — stop() waits for the batch then resolves', async () => {
    const delivered: string[] = [];

    const dispatcher = new WebhookDispatcher({
      pollIntervalMs: 60_000,
      pool: {
        connect: async () => ({
          query: vi.fn().mockResolvedValue({ rows: [] }),
          release: vi.fn(),
        }),
      },
    });

    // Simulate an in-flight delivery completing after stop() is called.
    (dispatcher as any).inFlight = (async () => {
      await new Promise<void>((r) => setTimeout(r, 10));
      delivered.push('delivery-1');
      (dispatcher as any).inFlight = null;
    })();

    await dispatcher.stop();

    expect(delivered).toContain('delivery-1');
  });
});

// ── #shutdown-drain: drain deadline enforced across all four resource types ───

describe('Drain deadline enforced under load', () => {
  beforeEach(() => {
    _resetLimiter();
    resetStreamHub();
  });

  afterEach(() => {
    _resetLimiter();
    resetStreamHub();
  });

  it('overall gracefulShutdown resolves within its timeout even with a stalled SSE subscriber', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    // Register a stuck SSE drain — never resolves
    const { registerSseShutdownCallback } = await import('../src/streams/sseEmitter.js');
    registerSseShutdownCallback(
      () => new Promise<void>(() => { /* stuck */ }),
      vi.fn(), // forceClose — called on per-callback timeout
    );

    addShutdownHook(async () => {
      const { drainSseEventBus } = await import('../src/streams/sseEmitter.js');
      await drainSseEventBus(50); // 50 ms per-callback deadline
    });

    const start = Date.now();
    await gracefulShutdown(server, 'SIGTERM', 5_000);
    const elapsed = Date.now() - start;

    // Should resolve well within 5s despite the stuck subscriber
    expect(elapsed).toBeLessThan(4_000);
  });

  it('HTTP requests refused cleanly during shutdown: responds with Connection: close', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    // Trigger shutdown
    void gracefulShutdown(server, 'SIGTERM', 5_000);

    // A request that reaches the already-started app should carry Connection: close
    const res = await request(app).get('/health');
    expect(res.headers['connection']).toBe('close');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('WS limiter rejects new connections immediately after shutdown starts', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const { gracefulDrain } = await import('../src/ws/connectionLimiter.js');
    void gracefulDrain(null, 100);

    // New connection attempts must be rejected
    const result = await checkAndReserve('192.168.1.1');
    expect(result.allowed).toBe(false);

    server.close();
  });

  it('SSE, WS, webhook, and DB hooks all run during a full gracefulShutdown', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const ran: string[] = [];

    // SSE
    addShutdownHook(() => { ran.push('sse'); });
    // WS
    addShutdownHook(() => { ran.push('ws'); });
    // Webhook
    addShutdownHook(async () => { ran.push('webhook'); });
    // DB/pool
    addShutdownHook(async () => { ran.push('db'); });

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(ran).toEqual(['sse', 'ws', 'webhook', 'db']);
  });
});
