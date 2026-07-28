import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { streamsRouter } from '../../src/routes/streams.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/errors.js';
import { initializeConfig } from '../../src/config/env.js';

initializeConfig();

const mockFindWithCursor = vi.fn();
const mockGetById = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    findWithCursor: (...a: unknown[]) => mockFindWithCursor(...a),
    getById:        (...a: unknown[]) => mockGetById(...a),
    upsertStream:   vi.fn(),
    updateStream:   vi.fn(),
    countByStatus:  vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool:            vi.fn(() => ({})),
  query:              vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
}));

function makeApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

function makeRow(id: string, status: string) {
  return {
    id,
    sender_address:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    recipient_address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
    amount:            '100',
    streamed_amount:   '0',
    remaining_amount:  '100',
    rate_per_second:   '1',
    start_time:        1700000000,
    end_time:          0,
    status,
    contract_id:       'api-created',
    transaction_hash:  'a'.repeat(64),
    event_index:       0,
    created_at:        new Date('2024-01-01'),
    updated_at:        new Date('2024-01-01'),
  };
}

const CACHEABLE  = 'public, max-age=300, stale-while-revalidate=60';
const NO_STORE   = 'private, no-store';

describe('Cache-Control headers — GET /api/streams', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  // ── List endpoint ─────────────────────────────────────────────────────────

  it('sets private, no-store when page contains an active stream', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'active')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('sets private, no-store when page contains a paused stream', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'paused')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('sets private, no-store when page contains a scheduled stream', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'scheduled')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('sets private, no-store for a mixed page (terminal + active)', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'completed'), makeRow('s2', 'active')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('sets public cache header when all streams are completed', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'completed'), makeRow('s2', 'completed')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(CACHEABLE);
  });

  it('sets public cache header when all streams are cancelled', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'cancelled'), makeRow('s2', 'cancelled')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(CACHEABLE);
  });

  it('sets public cache header for a mixed-terminal page (completed + cancelled)', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('s1', 'completed'), makeRow('s2', 'cancelled')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(CACHEABLE);
  });

  it('sets public cache header for an empty page', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['cache-control']).toBe(CACHEABLE);
  });

  // ── Single-stream endpoint ────────────────────────────────────────────────

  it('sets private, no-store for an active stream', async () => {
    mockGetById.mockResolvedValue(makeRow('s1', 'active'));
    const res = await request(app).get('/api/streams/s1').expect(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('sets private, no-store for a paused stream', async () => {
    mockGetById.mockResolvedValue(makeRow('s1', 'paused'));
    const res = await request(app).get('/api/streams/s1').expect(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('sets public cache header for a completed stream', async () => {
    mockGetById.mockResolvedValue(makeRow('s1', 'completed'));
    const res = await request(app).get('/api/streams/s1').expect(200);
    expect(res.headers['cache-control']).toBe(CACHEABLE);
  });

  it('sets public cache header for a cancelled stream', async () => {
    mockGetById.mockResolvedValue(makeRow('s1', 'cancelled'));
    const res = await request(app).get('/api/streams/s1').expect(200);
    expect(res.headers['cache-control']).toBe(CACHEABLE);
  });
});
