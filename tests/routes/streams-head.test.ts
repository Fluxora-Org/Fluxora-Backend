import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockGetById = vi.fn();
const mockExistsById = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById:        (...a: unknown[]) => mockGetById(...a),
    existsById:     (...a: unknown[]) => mockExistsById(...a),
    findWithCursor: vi.fn(),
    upsertStream:   vi.fn(),
    updateStream:   vi.fn(),
    countByStatus:  vi.fn().mockResolvedValue({ active: 0, paused: 0, completed: 0, cancelled: 0 }),
  },
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool:            vi.fn(() => ({})),
  query:              vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
  QueryTimeoutError: class QueryTimeoutError extends Error {
    constructor() { super('query timeout'); this.name = 'QueryTimeoutError'; }
  },
}));

import { streamsRouter } from '../../src/routes/streams.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { initializeConfig } from '../../src/config/env.js';

initializeConfig();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id:                'stream-abc123-0',
    sender_address:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
    amount:            '1000',
    streamed_amount:   '0',
    remaining_amount:  '1000',
    rate_per_second:   '10',
    start_time:        1700000000,
    end_time:          0,
    status:            'active',
    contract_id:       'api-created',
    transaction_hash:  'a'.repeat(64),
    event_index:       0,
    created_at:        '2024-01-01T00:00:00.000Z',
    updated_at:        '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('HEAD /api/streams/:id', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
    mockGetById.mockResolvedValue(makeRecord());
    mockExistsById.mockResolvedValue({
      updated_at: '2024-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with cache validators for an existing stream', async () => {
    const res = await request(app).head('/api/streams/stream-abc123-0');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^W\/"/);
    expect(res.headers['last-modified']).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    expect(res.text ?? '').toBe('');
    expect(mockExistsById).toHaveBeenCalledWith('stream-abc123-0');
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('returns 404 when the stream does not exist', async () => {
    mockExistsById.mockResolvedValue(undefined);

    const res = await request(app).head('/api/streams/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('does not require authentication for lightweight existence checks', async () => {
    const res = await request(app).head('/api/streams/stream-abc123-0');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
  });

  it('shares stream metadata with GET during concurrent lookups', async () => {
    mockExistsById.mockResolvedValue({
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    mockGetById.mockResolvedValue(makeRecord({ status: 'completed' }));

    const [headRes, getRes] = await Promise.all([
      request(app).head('/api/streams/stream-abc123-0'),
      request(app).get('/api/streams/stream-abc123-0'),
    ]);

    expect(headRes.status).toBe(200);
    expect(getRes.status).toBe(200);
    expect(headRes.headers.etag).toBe(getRes.headers.etag);
    expect(headRes.headers['last-modified']).toBe(getRes.headers['last-modified']);
  });

  it('returns 503 when the repository pool is exhausted', async () => {
    const { PoolExhaustedError } = await import('../../src/db/pool.js');
    mockExistsById.mockRejectedValue(new PoolExhaustedError());

    const res = await request(app).head('/api/streams/stream-x');

    expect(res.status).toBe(503);
  });
});
