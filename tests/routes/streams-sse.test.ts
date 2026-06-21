import { initializeConfig } from '../../src/config/env.js';
initializeConfig();

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createServer } from 'http';
import http from 'http';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http';
import { createApp } from '../../src/app.js';
import {
  _resetSseSubscriptionsForTest,
  getLiveSseSubscriberCount,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
  subscribeToSseStream,
} from '../../src/streams/sseEmitter.js';
import { getStreamHub } from '../../src/ws/hub.js';
import { generateToken } from '../../src/lib/auth.js';
import {
  _resetSseConnectionLimiter,
  getActiveSseConnectionCount,
} from '../../src/streams/sseConnectionLimiter.js';
import { sseActiveConnectionsGauge, sseConnectionsRejectedTotal } from '../../src/metrics/businessMetrics.js';
import { StaleCursorError } from '../../src/indexer/store.js';
import { SpanBuffer } from '../../src/tracing/builtin.js';
import { initializeTracer, resetTracer } from '../../src/tracing/hooks.js';

// ── Mock the repository and Redis before importing the app ──────────────────────────────
const mockGetById = vi.fn();

vi.mock('ioredis', () => {
  class RedisMock {
    on = vi.fn();
    quit = vi.fn().mockResolvedValue('OK');
    disconnect = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
  }
  return {
    default: RedisMock,
    Redis: RedisMock,
  };
});

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: (...a: unknown[]) => mockGetById(...a),
  },
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool:             vi.fn(() => ({})),
  query:               vi.fn(),
  PoolExhaustedError:  class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) { super(d ?? 'duplicate'); this.name = 'DuplicateEntryError'; }
  },
  QueryTimeoutError:   class QueryTimeoutError extends Error {
    constructor() { super('query timeout'); this.name = 'QueryTimeoutError'; }
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    stellar: {
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      timeout: 10000,
      retry: { maxRetries: 3, initialDelayMs: 1000 },
    },
    database: {
      url: process.env.DATABASE_URL || 'postgresql://localhost:5432/indexer_db',
    },
    indexer: {
      replayBatchSize: 1000,
    },
    server: {
      port: 3000,
    },
  },
}));

// Mock the StreamHub singleton
const mockGetEvents = vi.fn();
const mockEventStore = {
  getEvents: mockGetEvents,
};

vi.mock('../../src/ws/hub.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/ws/hub.js')>();
  return {
    ...original,
    getStreamHub: vi.fn(),
  };
});

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TEST_TOKEN = generateToken({ address: VALID_SENDER, role: 'operator' });

const app = createApp();

type MetricSnapshot = {
  values: Array<{ labels: Record<string, string | number>; value: number }>;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getMetricValue(
  metric: { get: () => MetricSnapshot | Promise<MetricSnapshot> },
  labels: Record<string, string> = {},
): Promise<number> {
  const snapshot = await metric.get();
  const matchingValue = snapshot.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected),
  );

  return matchingValue?.value ?? 0;
}

type OpenSseConnection = {
  req: ClientRequest;
  res: IncomingMessage;
  data: string;
};

function makeDbRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stream-abc123-0',
    sender_address: VALID_SENDER,
    recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
    amount: '1000',
    streamed_amount: '0',
    remaining_amount: '1000',
    rate_per_second: '10',
    start_time: 1700000000,
    end_time: 0,
    status: 'active',
    contract_id: 'api-created',
    transaction_hash: 'a'.repeat(64),
    event_index: 0,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/streams/:id/events (SSE Endpoint)', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  function openSseConnection(path = '/api/streams/stream-123/events'): Promise<OpenSseConnection> {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path,
        agent: false,
      }, (res) => {
        let data = '';
        const timeout = setTimeout(() => {
          req.destroy(new Error('Timed out waiting for SSE acknowledgement'));
        }, 1000);

        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n')) {
            clearTimeout(timeout);
            resolve({ req, res, data });
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  function requestJson(path = '/api/streams/stream-123/events'): Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: any;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path,
        agent: false,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk.toString());
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(body) });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
    });
  }

  async function closeSseConnection(connection: OpenSseConnection): Promise<void> {
    connection.req.destroy();
    connection.res.destroy();
    await delay(100);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.WS_AUTH_REQUIRED = 'false'; // default to false
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '10';
    process.env.SSE_MAX_GLOBAL_CONNECTIONS = '1000';
    process.env.SSE_MAX_CONNECTION_DURATION_MS = String(30 * 60 * 1000);
    process.env.SSE_RETRY_AFTER_SECONDS = '15';
    _resetSseConnectionLimiter();
    resetTracer();
    initializeTracer({ enabled: false });
    mockGetById.mockResolvedValue(undefined);
    mockGetEvents.mockResolvedValue({ events: [], total: 0 });
    
    const mockHub = {
      getEventStore: vi.fn(() => mockEventStore),
    };
    vi.mocked(getStreamHub).mockReturnValue(mockHub as any);

    // Create a real server to correctly test streaming
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetTracer();
    _resetSseConnectionLimiter();
    _resetSseSubscriptionsForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sseEventBus.removeAllListeners(SSE_STREAM_UPDATE_EVENT);
  });

  it('returns 404 if the stream does not exist', async () => {
    mockGetById.mockResolvedValue(undefined);
    
    const resPromise = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/streams/stream-nonexistent/events`, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk.toString());
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
        });
      });
      req.on('error', reject);
    });

    const res = await resPromise;
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('successfully establishes SSE stream and sends ok comment', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/streams/stream-123/events`, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.headers['cache-control']).toBe('no-cache, no-transform');
        expect(res.headers['connection']).toBe('keep-alive');

        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', reject);
    });

    const output = await resPromise;
    expect(output).toContain(': ok\n\n');
  });

  it('rejects with 401 when WS_AUTH_REQUIRED is true and token is missing', async () => {
    process.env.WS_AUTH_REQUIRED = 'true';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/streams/stream-123/events`, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk.toString());
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
        });
      });
      req.on('error', reject);
    });

    const res = await resPromise;
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetById).not.toHaveBeenCalled();
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('accepts valid JWT token in Authorization header when WS_AUTH_REQUIRED is true', async () => {
    process.env.WS_AUTH_REQUIRED = 'true';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<boolean>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        headers: {
          'Authorization': `Bearer ${TEST_TOKEN}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n')) {
            req.destroy();
            resolve(true);
          }
        });
      });
      req.on('error', () => resolve(true));
    });

    const success = await resPromise;
    expect(success).toBe(true);
  });

  it('rejects with 401 on invalid/expired token even if WS_AUTH_REQUIRED is false', async () => {
    process.env.WS_AUTH_REQUIRED = 'false';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        headers: {
          'Authorization': 'Bearer invalid.token.here',
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk.toString());
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
        });
      });
      req.on('error', reject);
    });

    const res = await resPromise;
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetById).not.toHaveBeenCalled();
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('replays historical events using Last-Event-ID header', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));
    
    const historicalEvent = {
      eventId: 'evt-100',
      ledger: 100,
      ledgerHash: 'hash-100',
      contractId: 'contract-abc',
      topic: 'stream.created',
      txHash: 'tx-100',
      eventIndex: 0,
      payload: { id: 'stream-123', depositAmount: '500' },
      happenedAt: '2026-01-01T00:00:00.000Z',
    };
    
    mockGetEvents.mockResolvedValue({
      events: [historicalEvent],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const resPromise = new Promise<string>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        headers: {
          'Last-Event-ID': 'evt-99',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n') && data.includes('evt-100') && data.includes('stream-123')) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', () => resolve(''));
    });

    const output = await resPromise;
    expect(output).toContain('id: evt-100');
    expect(output).toContain('event: stream_update');
    expect(output).toContain('stream-123');
    expect(mockGetEvents).toHaveBeenCalledWith({
      afterEventId: 'evt-99',
      limit: 100,
    });
  });

  it('returns a STALE_CURSOR SSE error when Last-Event-ID was evicted', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));
    mockGetEvents.mockRejectedValue(new StaleCursorError('evt-evicted'));

    const resPromise = new Promise<string>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        headers: {
          'Last-Event-ID': 'evt-evicted',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(''));
    });

    const output = await resPromise;
    expect(output).toContain('event: error');
    expect(output).toContain('"code":"STALE_CURSOR"');
  });

  it('streams live events via sseEventBus', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));
    const spanBuffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: spanBuffer });

    const resPromise = new Promise<string>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/streams/stream-123/events`, (res) => {
        let data = '';
        let liveEventEmitted = false;
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (!liveEventEmitted && data.includes(': ok\n\n')) {
            liveEventEmitted = true;
            sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
              streamId: 'stream-123',
              eventId: 'evt-live-001',
              payload: { status: 'cancelled' },
              correlationId: 'corr-live-001',
            });
          }
          if (data.includes('evt-live-001') && data.includes('cancelled')) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', () => resolve(''));
    });

    const output = await resPromise;
    expect(output).toContain('id: evt-live-001');
    expect(output).toContain('event: stream_update');
    expect(output).toContain('cancelled');
    expect(output).toContain('"correlationId":"corr-live-001"');
    expect(output).toContain('"traceId":"corr-live-001"');

    const sseSpans = spanBuffer.getSpans().filter(
      (span) => span.context.tags?.['span.name'] === 'sse.dispatch',
    );
    expect(sseSpans).toHaveLength(1);
    expect(sseSpans[0].context.traceId).toBe('corr-live-001');
    expect(sseSpans[0].context.tags).toMatchObject({
      'span.name': 'sse.dispatch',
      'sse.stream_id': 'stream-123',
      'sse.event_id': 'evt-live-001',
      'sse.subscriber_count': 1,
    });
    expect(sseSpans[0].status).toBe('ok');
  });

  it('closes the SSE fan-out span when one subscriber throws', () => {
    const spanBuffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: spanBuffer });

    const unsubscribeThrowing = subscribeToSseStream('stream-123', () => {
      throw new Error('socket closed');
    });
    const delivered = vi.fn();
    const unsubscribeHealthy = subscribeToSseStream('stream-123', delivered);

    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
      streamId: 'stream-123',
      eventId: 'evt-live-throw',
      payload: { status: 'active' },
      correlationId: 'corr-live-throw',
    });

    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'evt-live-throw',
      correlationId: 'corr-live-throw',
    }));

    const spans = spanBuffer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].context.traceId).toBe('corr-live-throw');
    expect(spans[0].context.tags?.['sse.subscriber_count']).toBe(2);
    expect(spans[0].status).toBe('ok');

    unsubscribeThrowing();
    unsubscribeHealthy();
  });

  it('removes listener when client disconnects', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const initialListeners = sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT);

    const resPromise = new Promise<void>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        agent: false,
        headers: {
          'Connection': 'close',
        },
      }, (res) => {
        res.on('data', (chunk) => {
          if (chunk.toString().includes(': ok\n\n')) {
            expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners + 1);
            res.socket?.destroy();
            resolve();
          }
        });
      });
      req.on('error', () => resolve());
    });

    await resPromise;
    
    // Give listener time to close in next tick
    await new Promise((r) => setTimeout(r, 100));
    
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners);
  });

  it('releases the reserved SSE slot when the stream is not found', async () => {
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '1';
    mockGetById.mockResolvedValue(undefined);

    const res = await requestJson('/api/streams/stream-missing/events');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getActiveSseConnectionCount()).toBe(0);
    expect(await getMetricValue(sseActiveConnectionsGauge)).toBe(0);
  });

  it('rejects SSE connections over the per-IP cap with 429 and Retry-After', async () => {
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '1';
    process.env.SSE_MAX_GLOBAL_CONNECTIONS = '10';
    process.env.SSE_RETRY_AFTER_SECONDS = '7';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const first = await openSseConnection();
    expect(getActiveSseConnectionCount()).toBe(1);

    const getByIdCallsBeforeRejected = mockGetById.mock.calls.length;
    const beforeRejected = await getMetricValue(sseConnectionsRejectedTotal, { reason: 'per_ip_limit' });
    const rejected = await requestJson();

    expect(mockGetById).toHaveBeenCalledTimes(getByIdCallsBeforeRejected);
    expect(rejected.status).toBe(429);
    expect(rejected.headers['retry-after']).toBe('7');
    expect(rejected.body.success).toBe(false);
    expect(rejected.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(rejected.body.error.details.reason).toBe('per_ip_limit');
    expect(await getMetricValue(sseConnectionsRejectedTotal, { reason: 'per_ip_limit' })).toBe(beforeRejected + 1);

    await closeSseConnection(first);
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('rejects SSE connections over the global cap with 429 and Retry-After', async () => {
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '10';
    process.env.SSE_MAX_GLOBAL_CONNECTIONS = '1';
    process.env.SSE_RETRY_AFTER_SECONDS = '11';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const first = await openSseConnection();
    expect(getActiveSseConnectionCount()).toBe(1);

    const getByIdCallsBeforeRejected = mockGetById.mock.calls.length;
    const beforeRejected = await getMetricValue(sseConnectionsRejectedTotal, { reason: 'global_limit' });
    const rejected = await requestJson();

    expect(mockGetById).toHaveBeenCalledTimes(getByIdCallsBeforeRejected);
    expect(rejected.status).toBe(429);
    expect(rejected.headers['retry-after']).toBe('11');
    expect(rejected.body.success).toBe(false);
    expect(rejected.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(rejected.body.error.details.reason).toBe('global_limit');
    expect(await getMetricValue(sseConnectionsRejectedTotal, { reason: 'global_limit' })).toBe(beforeRejected + 1);

    await closeSseConnection(first);
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('increments and decrements the active SSE connection gauge', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const connection = await openSseConnection();

    expect(getActiveSseConnectionCount()).toBe(1);
    expect(await getMetricValue(sseActiveConnectionsGauge)).toBe(1);

    await closeSseConnection(connection);

    expect(getActiveSseConnectionCount()).toBe(0);
    expect(await getMetricValue(sseActiveConnectionsGauge)).toBe(0);
  });

  it('closes after max duration and cleans listener/counter state', async () => {
    process.env.SSE_MAX_CONNECTION_DURATION_MS = '50';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const initialListeners = sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT);

    const output = await new Promise<string>((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        agent: false,
      }, (res) => {
        let data = '';
        const timeout = setTimeout(() => {
          req.destroy(new Error('Timed out waiting for SSE max-duration close'));
        }, 1000);

        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          clearTimeout(timeout);
          resolve(data);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    expect(output).toContain(': ok\n\n');
    expect(output).toContain('event: close');
    expect(output).toContain('max_duration');

    await delay(50);

    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners);
    expect(getActiveSseConnectionCount()).toBe(0);
    expect(await getMetricValue(sseActiveConnectionsGauge)).toBe(0);
  });

  it('uses one shared sseEventBus dispatcher for multiple active SSE subscribers', async () => {
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '10';
    process.env.SSE_MAX_GLOBAL_CONNECTIONS = '10';
    mockGetById.mockImplementation(async (id: string) => makeDbRecord({ id }));

    const initialListeners = sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT);

    const first = await openSseConnection('/api/streams/stream-123/events');
    const second = await openSseConnection('/api/streams/stream-456/events');

    expect(getActiveSseConnectionCount()).toBe(2);
    expect(getLiveSseSubscriberCount()).toBe(2);
    expect(getLiveSseSubscriberCount('stream-123')).toBe(1);
    expect(getLiveSseSubscriberCount('stream-456')).toBe(1);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners + 1);

    await closeSseConnection(first);

    expect(getActiveSseConnectionCount()).toBe(1);
    expect(getLiveSseSubscriberCount()).toBe(1);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners + 1);

    await closeSseConnection(second);

    expect(getActiveSseConnectionCount()).toBe(0);
    expect(getLiveSseSubscriberCount()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners);
  });

  it('sends retry hint in the SSE stream on connect', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const output = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/streams/stream-123/events`, (res) => {
        let data = '';
        const timeout = setTimeout(() => req.destroy(new Error('timeout')), 1000);
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('retry:')) {
            clearTimeout(timeout);
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    expect(output).toContain('retry: 5000');
  });

  it('ignores malformed Last-Event-ID (whitespace-only)', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<string>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        headers: { 'Last-Event-ID': '   ' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', () => resolve(''));
    });

    await resPromise;
    // Malformed ID should not trigger any getEvents call
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('ignores Last-Event-ID longer than 200 characters', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<string>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/events',
        headers: { 'Last-Event-ID': 'a'.repeat(201) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', () => resolve(''));
    });

    await resPromise;
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});

// ── Unit tests for sseEmitter helpers ─────────────────────────────────────────

import { deriveStreamId, eventMatchesStreamId } from '../../src/streams/sseEmitter.js';
import type { StreamEventRecord } from '../../src/db/types.js';

function makeEventRecord(overrides: Partial<StreamEventRecord> = {}): StreamEventRecord {
  return {
    eventId: 'evt-1',
    ledger: 100,
    ledgerHash: 'hash-100',
    contractId: 'contract-abc',
    topic: 'stream.created',
    txHash: 'abc123',
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: {},
    happenedAt: '2026-01-01T00:00:00.000Z',
    ingestedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('deriveStreamId', () => {
  it('produces canonical stream-{txHash}-{eventIndex} format', () => {
    expect(deriveStreamId('abc123', 0)).toBe('stream-abc123-0');
    expect(deriveStreamId('deadbeef', 5)).toBe('stream-deadbeef-5');
  });
});

describe('eventMatchesStreamId', () => {
  it('matches via payload.id', () => {
    const event = makeEventRecord({ payload: { id: 'stream-abc123-0' } });
    expect(eventMatchesStreamId(event, 'stream-abc123-0')).toBe(true);
  });

  it('matches via payload.streamId', () => {
    const event = makeEventRecord({ payload: { streamId: 'stream-abc123-0' } });
    expect(eventMatchesStreamId(event, 'stream-abc123-0')).toBe(true);
  });

  it('matches via canonical deriveStreamId derivation from txHash + eventIndex', () => {
    const event = makeEventRecord({ txHash: 'abc123', eventIndex: 0, payload: {} });
    expect(eventMatchesStreamId(event, 'stream-abc123-0')).toBe(true);
  });

  it('does not match a different stream id', () => {
    const event = makeEventRecord({ txHash: 'abc123', eventIndex: 0, payload: {} });
    expect(eventMatchesStreamId(event, 'stream-abc123-1')).toBe(false);
  });

  it('returns false for falsy inputs', () => {
    expect(eventMatchesStreamId(null as unknown as StreamEventRecord, 'stream-abc123-0')).toBe(false);
    expect(eventMatchesStreamId(makeEventRecord(), '')).toBe(false);
  });
});
