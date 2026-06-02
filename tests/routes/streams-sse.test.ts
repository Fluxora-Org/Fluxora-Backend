import { initializeConfig } from '../../src/config/env.js';
initializeConfig();

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createServer } from 'http';
import http from 'http';
import { createApp } from '../../src/app.js';
import { sseEventBus } from '../../src/streams/sseEmitter.js';
import { getStreamHub } from '../../src/ws/hub.js';
import { generateToken } from '../../src/lib/auth.js';

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

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.WS_AUTH_REQUIRED = 'false'; // default to false
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sseEventBus.removeAllListeners('stream_update');
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

  it('streams live events via sseEventBus', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const resPromise = new Promise<string>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/streams/stream-123/events`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes(': ok\n\n')) {
            sseEventBus.emit('stream_update', {
              streamId: 'stream-123',
              eventId: 'evt-live-001',
              payload: { status: 'cancelled' },
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
  });

  it('removes listener when client disconnects', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    const initialListeners = sseEventBus.listenerCount('stream_update');

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
            expect(sseEventBus.listenerCount('stream_update')).toBe(initialListeners + 1);
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
    
    expect(sseEventBus.listenerCount('stream_update')).toBe(initialListeners);
  });
});
