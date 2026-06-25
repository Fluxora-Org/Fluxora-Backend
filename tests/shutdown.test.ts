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
  beforeEach(() => {
    _resetSseSubscriptionsForTest();
  });

  afterEach(() => {
    _resetSseSubscriptionsForTest();
  });

  it('drainSseEventBus() calls all registered shutdown callbacks', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    registerSseShutdownCallback(cb1);
    registerSseShutdownCallback(cb2);

    drainSseEventBus();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('drainSseEventBus() clears callbacks so a second call is a no-op', () => {
    const cb = vi.fn();
    registerSseShutdownCallback(cb);

    drainSseEventBus();
    drainSseEventBus();

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('deregister function removes the callback before drain', () => {
    const cb = vi.fn();
    const deregister = registerSseShutdownCallback(cb);
    deregister();

    drainSseEventBus();

    expect(cb).not.toHaveBeenCalled();
  });

  it('drain isolates a throwing callback and still calls remaining ones', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    registerSseShutdownCallback(bad);
    registerSseShutdownCallback(good);

    expect(() => drainSseEventBus()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('is invoked by gracefulShutdown() via addShutdownHook', async () => {
    _resetShutdownState();
    const cb = vi.fn();
    registerSseShutdownCallback(cb);
    addShutdownHook(() => drainSseEventBus());

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(cb).toHaveBeenCalledTimes(1);
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
