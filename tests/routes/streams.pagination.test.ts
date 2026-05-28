/**
 * Pagination tests for GET /api/streams.
 *
 * Covers:
 *  - Default limit (20) applied when limit param is absent
 *  - Custom limit within range
 *  - limit=0 → 400
 *  - limit=101 → 400
 *  - limit=abc → 400
 *  - Empty result set → has_more:false, next_cursor:null, streams:[]
 *  - Last page (fewer rows than limit) → has_more:false, next_cursor:null
 *  - Full page with more rows → has_more:true, next_cursor present
 *  - next_cursor from page N used as cursor on page N+1
 *  - Invalid cursor string → 400
 *  - Structurally invalid cursor (valid base64url but wrong shape) → 400
 *  - SQL injection attempt in cursor → 400 (never reaches DB)
 *  - cursor passed to repository as afterId (keyset semantics)
 *  - Filter params forwarded to repository
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { streamsRouter, _resetStreams } from '../../src/routes/streams.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/errors.js';
import { initializeConfig } from '../../src/config/env.js';

initializeConfig();

// ── Mock repository ───────────────────────────────────────────────────────────

const mockFindWithCursor = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    findWithCursor: (...a: unknown[]) => mockFindWithCursor(...a),
    getById:        vi.fn(),
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

// ── App fixture ───────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

// ── DB row fixture ────────────────────────────────────────────────────────────

function makeRow(id: string) {
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
    status:            'active',
    contract_id:       'api-created',
    transaction_hash:  'a'.repeat(64),
    event_index:       0,
    created_at:        new Date('2024-01-01'),
    updated_at:        new Date('2024-01-01'),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decode the opaque next_cursor back to the lastId it encodes. */
function decodeCursorLastId(token: string): string {
  const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { lastId: string };
  return obj.lastId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/streams — pagination', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    _resetStreams();
    vi.clearAllMocks();
  });

  // ── Default limit ───────────────────────────────────────────────────────────

  it('uses default limit of 20 when limit param is absent', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object),
      20,          // default limit
      undefined,   // no cursor
      false,       // include_total
    );
  });

  it('forwards a custom limit to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?limit=5').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(expect.any(Object), 5, undefined, false);
  });

  // ── Limit validation ────────────────────────────────────────────────────────

  it('returns 400 for limit=0', async () => {
    const res = await request(app).get('/api/streams?limit=0').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for limit=101', async () => {
    const res = await request(app).get('/api/streams?limit=101').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-numeric limit', async () => {
    const res = await request(app).get('/api/streams?limit=abc').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts limit=100 (max boundary)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?limit=100').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(expect.any(Object), 100, undefined, false);
  });

  it('accepts limit=1 (min boundary)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?limit=1').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(expect.any(Object), 1, undefined, false);
  });

  // ── Empty result set ────────────────────────────────────────────────────────

  it('returns has_more:false and next_cursor:null for an empty result set', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.body.data.streams).toEqual([]);
    expect(res.body.data.has_more).toBe(false);
    expect(res.body.data.next_cursor).toBeNull();
  });

  // ── Last page ───────────────────────────────────────────────────────────────

  it('returns has_more:false and next_cursor:null on the last page', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('stream-1')],
      hasMore: false,
    });
    const res = await request(app).get('/api/streams?limit=20').expect(200);
    expect(res.body.data.has_more).toBe(false);
    expect(res.body.data.next_cursor).toBeNull();
  });

  // ── Full page with more rows ────────────────────────────────────────────────

  it('returns has_more:true and a non-null next_cursor when more rows exist', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('stream-1'), makeRow('stream-2')],
      hasMore: true,
    });
    const res = await request(app).get('/api/streams?limit=2').expect(200);
    expect(res.body.data.has_more).toBe(true);
    expect(res.body.data.next_cursor).not.toBeNull();
    expect(typeof res.body.data.next_cursor).toBe('string');
  });

  it('next_cursor encodes the id of the last stream on the page', async () => {
    mockFindWithCursor.mockResolvedValue({
      streams: [makeRow('stream-aaa'), makeRow('stream-zzz')],
      hasMore: true,
    });
    const res = await request(app).get('/api/streams?limit=2').expect(200);
    const lastId = decodeCursorLastId(res.body.data.next_cursor);
    expect(lastId).toBe('stream-zzz');
  });

  // ── Cursor forwarded to repository ─────────────────────────────────────────

  it('decodes next_cursor and passes lastId as afterId to the repository', async () => {
    // Page 1
    mockFindWithCursor.mockResolvedValueOnce({
      streams: [makeRow('stream-page1-last')],
      hasMore: true,
    });
    const page1 = await request(app).get('/api/streams?limit=1').expect(200);
    const cursor = page1.body.data.next_cursor as string;

    // Page 2 — cursor from page 1
    mockFindWithCursor.mockResolvedValueOnce({ streams: [], hasMore: false });
    await request(app).get(`/api/streams?limit=1&cursor=${encodeURIComponent(cursor)}`).expect(200);

    expect(mockFindWithCursor).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      1,
      'stream-page1-last',  // afterId extracted from cursor
      false,
    );
  });

  // ── Cursor validation ───────────────────────────────────────────────────────

  it('returns 400 for an empty cursor string', async () => {
    const res = await request(app).get('/api/streams?cursor=').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a cursor that is not valid base64url JSON', async () => {
    const res = await request(app).get('/api/streams?cursor=not-a-valid-cursor').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a cursor with valid base64url but wrong JSON shape', async () => {
    // Valid base64url but missing required fields
    const bad = Buffer.from(JSON.stringify({ wrong: 'shape' })).toString('base64url');
    const res = await request(app).get(`/api/streams?cursor=${bad}`).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a SQL injection attempt in cursor', async () => {
    const injection = "'; DROP TABLE streams; --";
    const res = await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(injection)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Repository must never be called
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  // ── Filter params ───────────────────────────────────────────────────────────

  it('forwards status filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?status=active').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      20, undefined, false,
    );
  });

  it('forwards sender filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const addr = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    await request(app).get(`/api/streams?sender=${addr}`).expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ sender_address: addr }),
      20, undefined, false,
    );
  });

  it('forwards recipient filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const addr = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN';
    await request(app).get(`/api/streams?recipient=${addr}`).expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_address: addr }),
      20, undefined, false,
    );
  });

  // ── include_total ───────────────────────────────────────────────────────────

  it('passes includeTotal=true to repository when include_total=true', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false, total: 0 });
    const res = await request(app).get('/api/streams?include_total=true').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(expect.any(Object), 20, undefined, true);
    expect(res.body.data.total).toBe(0);
  });
});
