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
 *  - status enum validation (hardening)
 *  - cursor lastId length cap (hardening)
 *  - include_total enum validation (hardening)
 *  - limit float/negative/scientific notation rejection (hardening)
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
  QueryTimeoutError: class QueryTimeoutError extends Error {
    constructor() { super('query timeout'); this.name = 'QueryTimeoutError'; }
  },
}));

/**
 * Mock the auth middleware so all requests in pagination tests are pre-authorised.
 * authenticateApiKey sets keyId + keyScopes so requireScope passes.
 * This keeps tests focused on pagination behaviour, not auth plumbing.
 */
vi.mock('../../src/middleware/auth.js', () => ({
  authenticateApiKey: (_req: any, _res: any, next: any) => {
    _req.keyId     = 'test-key-id';
    _req.keyScopes = ['streams:read'];
    return next();
  },
  requireScope:            () => (_req: any, _res: any, next: any) => next(),
  authenticate:            (_req: any, _res: any, next: any) => next(),
  requireAuth:             (_req: any, _res: any, next: any) => next(),
  authenticateApiKeyOrJwt: (_req: any, _res: any, next: any) => next(),
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

// ── Original pagination tests ─────────────────────────────────────────────────

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
      20,
      undefined,
      false,
      expect.any(Object),
    );
  });

  it('forwards a custom limit to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?limit=5').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 5, undefined, false, expect.any(Object),
    );
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
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 100, undefined, false, expect.any(Object),
    );
  });

  it('accepts limit=1 (min boundary)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?limit=1').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 1, undefined, false, expect.any(Object),
    );
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
    mockFindWithCursor.mockResolvedValue({ streams: [makeRow('stream-1')], hasMore: false });
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
    mockFindWithCursor.mockResolvedValueOnce({
      streams: [makeRow('stream-page1-last')],
      hasMore: true,
    });
    const page1 = await request(app).get('/api/streams?limit=1').expect(200);
    const cursor = page1.body.data.next_cursor as string;

    mockFindWithCursor.mockResolvedValueOnce({ streams: [], hasMore: false });
    await request(app)
      .get(`/api/streams?limit=1&cursor=${encodeURIComponent(cursor)}`)
      .expect(200);

    expect(mockFindWithCursor).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      1,
      'stream-page1-last',
      false,
      expect.any(Object),
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
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  // ── Filter params ───────────────────────────────────────────────────────────

  it('forwards status filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?status=active').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('forwards sender filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const addr = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    await request(app).get(`/api/streams?sender=${addr}`).expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ sender_address: addr }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('forwards recipient filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const addr = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN';
    await request(app).get(`/api/streams?recipient=${addr}`).expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_address: addr }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('forwards status + sender multi-filter to the repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const addr = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    await request(app).get(`/api/streams?status=active&sender=${addr}`).expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', sender_address: addr }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('paginates filtered cursor pages using afterId from prior page', async () => {
    mockFindWithCursor
      .mockResolvedValueOnce({
        streams: [makeRow('stream-b'), makeRow('stream-c')],
        hasMore: true,
      })
      .mockResolvedValueOnce({ streams: [makeRow('stream-d')], hasMore: false });

    const page1 = await request(app).get('/api/streams?status=active&limit=2').expect(200);
    expect(mockFindWithCursor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'active' }),
      2, undefined, false, expect.any(Object),
    );

    const cursor = page1.body.data.next_cursor as string;
    await request(app)
      .get(`/api/streams?status=active&limit=2&cursor=${encodeURIComponent(cursor)}`)
      .expect(200);

    expect(mockFindWithCursor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'active' }),
      2, 'stream-c', false, expect.any(Object),
    );
  });

  // ── include_total ───────────────────────────────────────────────────────────

  it('passes includeTotal=true to repository when include_total=true', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false, total: 0 });
    const res = await request(app).get('/api/streams?include_total=true').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 20, undefined, true, expect.any(Object),
    );
    expect(res.body.data.total).toBe(0);
  });
});

// ── Status filter validation (enum hardening) ─────────────────────────────────

describe('GET /api/streams — status filter validation', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    _resetStreams();
    vi.clearAllMocks();
  });

  it('accepts status=active (valid enum value)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    const res = await request(app).get('/api/streams?status=active').expect(200);
    expect(res.body.error).toBeUndefined();
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('accepts status=paused (valid enum value)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?status=paused').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused' }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('accepts status=completed (valid enum value)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?status=completed').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('accepts status=cancelled (valid enum value)', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?status=cancelled').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
      20, undefined, false, expect.any(Object),
    );
  });

  it('rejects unknown status value with 400', async () => {
    const res = await request(app).get('/api/streams?status=unknown').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects an uppercase STATUS value (enum is case-sensitive)', async () => {
    const res = await request(app).get('/api/streams?status=ACTIVE').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects a SQL injection attempt in status', async () => {
    const injection = "active'; DROP TABLE streams; --";
    const res = await request(app)
      .get(`/api/streams?status=${encodeURIComponent(injection)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('error message lists the valid status values', async () => {
    const res = await request(app).get('/api/streams?status=invalid-value').expect(400);
    const message: string = res.body.error.message ?? '';
    expect(message).toMatch(/active/);
    expect(message).toMatch(/paused/);
    expect(message).toMatch(/completed/);
    expect(message).toMatch(/cancelled/);
  });

  it('omits status from filter when not provided', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams').expect(200);
    const filterArg = mockFindWithCursor.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filterArg).not.toHaveProperty('status');
  });
});

// ── Cursor lastId length cap hardening ────────────────────────────────────────

describe('GET /api/streams — cursor lastId length cap', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    _resetStreams();
    vi.clearAllMocks();
  });

  it('rejects a cursor whose lastId exceeds 200 characters', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, lastId: 'x'.repeat(201) })).toString('base64url');
    const res = await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(payload)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('accepts a cursor whose lastId is exactly 200 characters', async () => {
    const validId = 'a'.repeat(200);
    const payload = Buffer.from(JSON.stringify({ v: 1, lastId: validId })).toString('base64url');
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(payload)}`)
      .expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 20, validId, false, expect.any(Object),
    );
  });

  it('rejects a cursor whose lastId is whitespace-only', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, lastId: '   ' })).toString('base64url');
    const res = await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(payload)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects a cursor with version v:2 (wrong version)', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 2, lastId: 'stream-abc' })).toString('base64url');
    const res = await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(payload)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects a cursor missing the lastId field', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, wrong_field: 'oops' })).toString('base64url');
    const res = await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(payload)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects a cursor with a numeric lastId', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, lastId: 12345 })).toString('base64url');
    const res = await request(app)
      .get(`/api/streams?cursor=${encodeURIComponent(payload)}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });
});

// ── include_total validation hardening ────────────────────────────────────────

describe('GET /api/streams — include_total validation', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    _resetStreams();
    vi.clearAllMocks();
  });

  it('accepts include_total=true', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false, total: 0 });
    const res = await request(app).get('/api/streams?include_total=true').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 20, undefined, true, expect.any(Object),
    );
    expect(res.body.data.total).toBe(0);
  });

  it('accepts include_total=false', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    await request(app).get('/api/streams?include_total=false').expect(200);
    expect(mockFindWithCursor).toHaveBeenCalledWith(
      expect.any(Object), 20, undefined, false, expect.any(Object),
    );
  });

  it('rejects include_total=yes (not a valid enum value)', async () => {
    const res = await request(app).get('/api/streams?include_total=yes').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects include_total=1 (not a valid enum value)', async () => {
    const res = await request(app).get('/api/streams?include_total=1').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects include_total=TRUE (enum is case-sensitive)', async () => {
    const res = await request(app).get('/api/streams?include_total=TRUE').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });
});

// ── limit edge cases (float / negative / scientific) ─────────────────────────

describe('GET /api/streams — limit edge cases', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    _resetStreams();
    vi.clearAllMocks();
  });

  it('rejects a float limit string (e.g. 1.5)', async () => {
    const res = await request(app).get('/api/streams?limit=1.5').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects a negative limit string (e.g. -5)', async () => {
    const res = await request(app).get('/api/streams?limit=-5').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects limit=0 (below minimum)', async () => {
    const res = await request(app).get('/api/streams?limit=0').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects limit=101 (above maximum)', async () => {
    const res = await request(app).get('/api/streams?limit=101').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects limit=1e3 (scientific notation is not an integer string)', async () => {
    const res = await request(app).get('/api/streams?limit=1e3').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
