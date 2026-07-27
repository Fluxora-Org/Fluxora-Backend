import { initializeConfig } from '../../src/config/env.js';
initializeConfig();

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createServer } from 'http';
import http from 'http';
import type { IncomingHttpHeaders } from 'http';
import { createApp } from '../../src/app.js';
import {
  _resetSseSubscriptionsForTest,
  getLiveSseSubscriberCount,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
} from '../../src/streams/sseEmitter.js';
import { getStreamHub } from '../../src/ws/hub.js';
import { generateToken } from '../../src/lib/auth.js';
import {
  _resetLongPollConnectionLimiter,
  getActiveLongPollConnectionCount,
} from '../../src/streams/longPoll.js';
import { longPollActiveConnectionsGauge, longPollConnectionsRejectedTotal } from '../../src/metrics/businessMetrics.js';
import { StaleCursorError } from '../../src/indexer/store.js';

// ── Mocks ────────────────────────────────────────────────────────────────────
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
  getPool: vi.fn(() => ({})),
  query: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) {
      super(d ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
  QueryTimeoutError: class QueryTimeoutError extends Error {
    constructor() {
      super('query timeout');
      this.name = 'QueryTimeoutError';
    }
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

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...original,
    authenticateApiKey: (_req: any, _res: any, next: any) => next(),
    requireScope: () => (_req: any, _res: any, next: any) => next(),
  };
});

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TEST_TOKEN = generateToken({ address: VALID_SENDER, role: 'operator' });

const app = createApp();

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

describe('GET /api/streams/:id/poll (Long-Polling Fallback Endpoint)', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  function requestPoll(
    path = '/api/streams/stream-123/poll',
    extraHeaders: Record<string, string> = {},
  ): Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: any;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path,
          agent: false,
          headers: { ...extraHeaders },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk.toString()));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(body) });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.WS_AUTH_REQUIRED = 'false';
    process.env.LONG_POLL_MAX_CONNECTIONS_PER_IP = '10';
    process.env.LONG_POLL_MAX_GLOBAL_CONNECTIONS = '1000';
    process.env.LONG_POLL_MAX_CONNECTION_DURATION_MS = String(30 * 60 * 1000);
    process.env.LONG_POLL_RETRY_AFTER_SECONDS = '15';
    _resetLongPollConnectionLimiter();
    mockGetById.mockResolvedValue(undefined);
    mockGetEvents.mockResolvedValue({ events: [], total: 0 });

    const mockHub = {
      getEventStore: vi.fn(() => mockEventStore),
    };
    vi.mocked(getStreamHub).mockReturnValue(mockHub as any);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetLongPollConnectionLimiter();
    _resetSseSubscriptionsForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sseEventBus.removeAllListeners(SSE_STREAM_UPDATE_EVENT);
  });

  it('returns 404 if stream does not exist', async () => {
    mockGetById.mockResolvedValue(undefined);

    const res = await requestPoll('/api/streams/stream-nonexistent/poll');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('holds connection open and times out with null data when no event arrives', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const start = Date.now();
    const res = await requestPoll('/api/streams/stream-123/poll?timeout=1');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
    expect(res.body.meta).toHaveProperty('timestamp');
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('delivers live event immediately when emitted via sseEventBus', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const pollPromise = requestPoll('/api/streams/stream-123/poll?timeout=5');

    // Wait for listener to attach
    await new Promise((r) => setTimeout(r, 100));

    expect(getLiveSseSubscriberCount('stream-123')).toBe(1);
    expect(getActiveLongPollConnectionCount()).toBe(1);

    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
      streamId: 'stream-123',
      eventId: 'evt-live-101',
      payload: { amount: '100', status: 'active' },
    });

    const res = await pollPromise;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      type: 'stream_update',
      streamId: 'stream-123',
      eventId: 'evt-live-101',
      payload: { amount: '100', status: 'active' },
      correlationId: expect.any(String),
    });
    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(getLiveSseSubscriberCount('stream-123')).toBe(0);
  });

  it('replays historical event immediately if found after since', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const historicalEvent = {
      eventId: 'evt-100',
      txHash: 'a'.repeat(64),
      eventIndex: 0,
      payload: { id: 'stream-123', depositAmount: '500' },
    };

    mockGetEvents.mockResolvedValue({
      events: [historicalEvent],
      total: 1,
    });

    const res = await requestPoll('/api/streams/stream-123/poll?since=evt-99');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      type: 'stream_update',
      streamId: 'stream-123',
      eventId: 'evt-100',
      payload: { id: 'stream-123', depositAmount: '500' },
      correlationId: expect.any(String),
    });
    expect(mockGetEvents).toHaveBeenCalledWith({
      afterEventId: 'evt-99',
      limit: 100,
    });
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('rejects invalid since parameter with 400 VALIDATION_ERROR', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const res = await requestPoll('/api/streams/stream-123/poll?since=bad%0Aheader');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('rejects invalid timeout parameter with 400 VALIDATION_ERROR', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const res = await requestPoll('/api/streams/stream-123/poll?timeout=abc');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('handles StaleCursorError when replaying events', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));
    mockGetEvents.mockRejectedValue(new StaleCursorError('evt-evicted'));

    const res = await requestPoll('/api/streams/stream-123/poll?since=evt-evicted');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('rejects long-poll requests exceeding per-IP capacity with 429 and Retry-After', async () => {
    process.env.LONG_POLL_MAX_CONNECTIONS_PER_IP = '1';
    process.env.LONG_POLL_RETRY_AFTER_SECONDS = '10';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const firstPollPromise = requestPoll('/api/streams/stream-123/poll?timeout=5');

    await new Promise((r) => setTimeout(r, 100));

    expect(getActiveLongPollConnectionCount()).toBe(1);

    const rejected = await requestPoll('/api/streams/stream-123/poll?timeout=5');

    expect(rejected.status).toBe(429);
    expect(rejected.headers['retry-after']).toBe('10');
    expect(rejected.body.success).toBe(false);
    expect(rejected.body.error.code).toBe('TOO_MANY_REQUESTS');

    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
      streamId: 'stream-123',
      eventId: 'evt-first',
      payload: {},
    });

    await firstPollPromise;
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('rejects unauthenticated request when WS_AUTH_REQUIRED is true', async () => {
    process.env.WS_AUTH_REQUIRED = 'true';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const res = await requestPoll('/api/streams/stream-123/poll?timeout=1');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('accepts valid JWT token in Authorization header when WS_AUTH_REQUIRED is true', async () => {
    process.env.WS_AUTH_REQUIRED = 'true';
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const res = await requestPoll('/api/streams/stream-123/poll?timeout=1', {
      Authorization: `Bearer ${TEST_TOKEN}`,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('cleans up connection slot and unsubscribes if client aborts request', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const initialListeners = sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT);

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/streams/stream-123/poll?timeout=5',
        agent: false,
      },
      (res) => {},
    );
    req.on('error', () => {
      // Swallowed expected abort error
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(getActiveLongPollConnectionCount()).toBe(1);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners + 1);

    req.destroy();

    await new Promise((r) => setTimeout(r, 100));

    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(initialListeners);
  });
});
