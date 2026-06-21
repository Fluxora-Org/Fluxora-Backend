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
import express from 'express';
import type { Response } from 'express';
import { vi } from 'vitest';
import request from 'supertest';
import {
  gracefulShutdown,
  isShuttingDown,
  addShutdownDrainHook,
  addShutdownHook,
  _resetShutdownState,
} from '../src/shutdown.js';
import { resetStreamHub, createStreamHub, getStreamHub } from '../src/ws/hub.js';
import { setPool, getPool } from '../src/db/pool.js';
import {
  drainSseConnections,
  getLiveSseSubscriberCount,
  registerSseResponseForDrain,
  subscribeToSseStream,
  _resetSseSubscriptionsForTest,
} from '../src/streams/sseEmitter.js';
import {
  closeAllRedisClients,
  createRedisClient,
  DefaultRedisClientFactory,
  getActiveRedisClientCount,
  setRedisClientFactory,
  _resetRedisClientRegistryForTest,
  type RedisClient,
} from '../src/redis/client.js';

function createHealthTestApp() {
  const app = express();
  app.use((_req, res, next) => {
    if (isShuttingDown()) {
      res.setHeader('Connection', 'close');
    }
    next();
  });
  app.get('/health', (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({
        status: 'shutting_down',
        service: 'fluxora-backend',
        message: 'Service is shutting down',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    res.json({
      status: 'ok',
      service: 'fluxora-backend',
      timestamp: new Date().toISOString(),
    });
  });
  app.get('/health/ready', (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({
        error: {
          code: 'SERVICE_SHUTTING_DOWN',
          message: 'Service is shutting down',
        },
      });
      return;
    }
    res.json({ status: 'healthy' });
  });
  return app;
}

const app = createHealthTestApp();

// Reset module-level shutdown state before every test so tests are isolated.
beforeEach(() => {
  _resetShutdownState();
  _resetSseSubscriptionsForTest();
  _resetRedisClientRegistryForTest();
});

afterEach(async () => {
  _resetShutdownState();
  _resetSseSubscriptionsForTest();
  _resetRedisClientRegistryForTest();
  setRedisClientFactory(new DefaultRedisClientFactory());
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
    (globalThis as Record<string, unknown>)['__FLUXORA_SHUTDOWN__'] = true;
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
    (globalThis as Record<string, unknown>)['__FLUXORA_SHUTDOWN__'] = true;
    const res = await request(app).get('/health/ready').expect(503);
    expect(res.body.error.code).toBe('SERVICE_SHUTTING_DOWN');
  });
});

describe('Connection: close header during shutdown', () => {
  it('IS set during shutdown', async () => {
    (globalThis as Record<string, unknown>)['__FLUXORA_SHUTDOWN__'] = true;
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

  it('runs drain hooks before waiting on HTTP close, then teardown hooks', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const executionOrder: string[] = [];
    addShutdownDrainHook(() => {
      executionOrder.push('drain:sse');
    });
    addShutdownDrainHook(() => {
      executionOrder.push('drain:indexer');
    });
    addShutdownHook(() => {
      executionOrder.push('teardown:db');
    });
    addShutdownHook(() => {
      executionOrder.push('teardown:redis');
    });

    await gracefulShutdown(server, 'SIGTERM', 5_000);

    expect(executionOrder).toEqual([
      'drain:sse',
      'drain:indexer',
      'teardown:db',
      'teardown:redis',
    ]);
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

describe('SSE shutdown drain', () => {
  it('ends registered SSE responses with a retry hint and close event', () => {
    const writes: string[] = [];
    const res = {
      destroyed: false,
      writableEnded: false,
      write: vi.fn((frame: string) => {
        writes.push(frame);
        return true;
      }),
      end: vi.fn(),
      destroy: vi.fn(),
    };

    registerSseResponseForDrain(res as unknown as Response);

    const closed = drainSseConnections('server_shutdown', 15_000);

    expect(closed).toBe(1);
    expect(writes.join('')).toContain('retry: 15000');
    expect(writes.join('')).toContain('event: close');
    expect(writes.join('')).toContain('server_shutdown');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('clears live SSE subscriptions during test reset', () => {
    const unsubscribe = subscribeToSseStream('stream-1', () => {});
    expect(getLiveSseSubscriberCount('stream-1')).toBe(1);
    unsubscribe();
    expect(getLiveSseSubscriberCount('stream-1')).toBe(0);
  });
});

describe('Redis shutdown drain', () => {
  it('closes every Redis client created through the factory exactly once', async () => {
    const clientA = { close: vi.fn().mockResolvedValue(undefined) } as unknown as RedisClient;
    const clientB = { close: vi.fn().mockResolvedValue(undefined) } as unknown as RedisClient;
    setRedisClientFactory({
      createClient: vi.fn()
        .mockResolvedValueOnce(clientA)
        .mockResolvedValueOnce(clientB),
    });

    await createRedisClient({ url: 'redis://localhost:6379', enabled: true });
    await createRedisClient({ url: 'redis://localhost:6379', enabled: true });

    expect(getActiveRedisClientCount()).toBe(2);
    await closeAllRedisClients();

    expect(clientA.close).toHaveBeenCalledTimes(1);
    expect(clientB.close).toHaveBeenCalledTimes(1);
    expect(getActiveRedisClientCount()).toBe(0);
  });
});
