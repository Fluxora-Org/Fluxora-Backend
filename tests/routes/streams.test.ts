/**
 * Integration tests for the streams HTTP routes.
 *
 * The PostgreSQL repository is fully mocked so no real database is required.
 * Tests cover all routes, validation, idempotency, state-machine transitions,
 * and error envelopes.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock the repository before importing the app ──────────────────────────────
const mockGetById          = vi.fn();
const mockUpsertStream     = vi.fn();
const mockUpdateStream     = vi.fn();
const mockFindWithCursor   = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById:         (...a: unknown[]) => mockGetById(...a),
    upsertStream:    (...a: unknown[]) => mockUpsertStream(...a),
    updateStream:    (...a: unknown[]) => mockUpdateStream(...a),
    findWithCursor:  (...a: unknown[]) => mockFindWithCursor(...a),
    countByStatus:   vi.fn().mockResolvedValue({ active: 0, paused: 0, completed: 0, cancelled: 0 }),
  },
}));

// Mock pool so PoolExhaustedError is importable
vi.mock('../../src/db/pool.js', () => ({
  getPool:            vi.fn(() => ({})),
  query:              vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) { super(d ?? 'duplicate'); this.name = 'DuplicateEntryError'; }
  },
}));

import { createApp } from '../../src/app.js';
import { _resetStreams, setStreamListingDependencyState, setIdempotencyDependencyState } from '../../src/routes/streams.js';

const VALID_SENDER    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';
const INVALID_KEY_SHORT         = 'GABC123';
const INVALID_KEY_WRONG_PREFIX  = 'AAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const INVALID_KEY_INVALID_CHARS = 'G1111111111111111111111111111111111111111111111111111111';

const app = createApp();

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDbRecord(overrides: Record<string, unknown> = {}) {
  return {
    id:                'stream-abc123-0',
    sender_address:    VALID_SENDER,
    recipient_address: VALID_RECIPIENT,
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

const validBody = {
  sender:        VALID_SENDER,
  recipient:     VALID_RECIPIENT,
  depositAmount: '1000',
  ratePerSecond: '10',
};

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('streams routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStreams();
    setStreamListingDependencyState('healthy');
    setIdempotencyDependencyState('healthy');

    // Default happy-path mocks
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
    mockGetById.mockResolvedValue(undefined);
    mockUpsertStream.mockResolvedValue({ created: true, stream: makeDbRecord() });
    mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET /api/streams ────────────────────────────────────────────────────────

  describe('GET /api/streams', () => {
    it('returns an empty list when no streams exist', async () => {
      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.streams).toEqual([]);
      expect(res.body.data.has_more).toBe(false);
    });

    it('returns mapped streams from the repository', async () => {
      mockFindWithCursor.mockResolvedValue({
        streams: [makeDbRecord()],
        hasMore: false,
      });

      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(200);
      expect(res.body.data.streams).toHaveLength(1);
      const s = res.body.data.streams[0];
      expect(s.sender).toBe(VALID_SENDER);
      expect(s.recipient).toBe(VALID_RECIPIENT);
      expect(s.depositAmount).toBe('1000');
      expect(s.ratePerSecond).toBe('10');
    });

    it('includes next_cursor when hasMore=true', async () => {
      mockFindWithCursor.mockResolvedValue({
        streams: [makeDbRecord({ id: 'stream-abc-0' })],
        hasMore: true,
      });

      const res = await request(app).get('/api/streams?limit=1');
      expect(res.status).toBe(200);
      expect(res.body.data.next_cursor).toBeDefined();
      expect(res.body.data.has_more).toBe(true);
    });

    it('includes total when include_total=true', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false, total: 42 });

      const res = await request(app).get('/api/streams?include_total=true');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(42);
    });

    it('rejects invalid limit', async () => {
      const res = await request(app).get('/api/streams?limit=0');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects limit > 100', async () => {
      const res = await request(app).get('/api/streams?limit=101');
      expect(res.status).toBe(400);
    });

    it('rejects invalid cursor', async () => {
      const res = await request(app).get('/api/streams?cursor=!!!invalid!!!');
      expect(res.status).toBe(400);
    });

    it('rejects invalid include_total value', async () => {
      const res = await request(app).get('/api/streams?include_total=maybe');
      expect(res.status).toBe(400);
    });

    it('returns 503 when listing dependency is unavailable', async () => {
      setStreamListingDependencyState('unavailable');
      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockFindWithCursor.mockRejectedValue(new PoolExhaustedError());

      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(503);
    });

    it('accepts a valid cursor and passes afterId to repository', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });

      // Build a valid cursor
      const cursor = Buffer.from(JSON.stringify({ v: 1, lastId: 'stream-abc-0' })).toString('base64url');
      const res = await request(app).get(`/api/streams?cursor=${cursor}`);
      expect(res.status).toBe(200);
      expect(mockFindWithCursor).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        'stream-abc-0',
        expect.any(Boolean),
      );
    });
  });

  // ── GET /api/streams/:id ────────────────────────────────────────────────────

  describe('GET /api/streams/:id', () => {
    it('returns 404 for a non-existent stream', async () => {
      mockGetById.mockResolvedValue(undefined);
      const res = await request(app).get('/api/streams/stream-nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Stream');
    });

    it('returns the stream when found', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-abc-0' }));

      const res = await request(app).get('/api/streams/stream-abc-0');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.stream.id).toBe('stream-abc-0');
      expect(res.body.data.stream.sender).toBe(VALID_SENDER);
      expect(res.body.data.stream.depositAmount).toBe('1000');
    });

    it('maps DB snake_case to API camelCase', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({
        sender_address:    VALID_SENDER,
        recipient_address: VALID_RECIPIENT,
        amount:            '500',
        rate_per_second:   '5',
        start_time:        1700000000,
        end_time:          1800000000,
      }));

      const res = await request(app).get('/api/streams/stream-abc-0');
      const s = res.body.data.stream;
      expect(s.sender).toBe(VALID_SENDER);
      expect(s.recipient).toBe(VALID_RECIPIENT);
      expect(s.depositAmount).toBe('500');
      expect(s.ratePerSecond).toBe('5');
      expect(s.startTime).toBe(1700000000);
      expect(s.endTime).toBe(1800000000);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockGetById.mockRejectedValue(new PoolExhaustedError());

      const res = await request(app).get('/api/streams/stream-x');
      expect(res.status).toBe(503);
    });
  });

  // ── POST /api/streams ───────────────────────────────────────────────────────

  describe('POST /api/streams', () => {
    it('creates a stream with valid input', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sender).toBe(VALID_SENDER);
      expect(res.body.data.recipient).toBe(VALID_RECIPIENT);
      expect(res.body.data.depositAmount).toBe('1000');
      expect(res.body.data.ratePerSecond).toBe('10');
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.id).toMatch(/^stream-/);
    });

    it('sets Idempotency-Replayed: false on first creation', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Idempotency-Key', 'key-001')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.headers['idempotency-replayed']).toBe('false');
    });

    it('replays idempotent request with same key and body', async () => {
      await request(app)
        .post('/api/streams')
        .set('Idempotency-Key', 'key-replay')
        .send(validBody);

      const res2 = await request(app)
        .post('/api/streams')
        .set('Idempotency-Key', 'key-replay')
        .send(validBody);

      expect(res2.status).toBe(201);
      expect(res2.headers['idempotency-replayed']).toBe('true');
      // Repository should only be called once
      expect(mockUpsertStream).toHaveBeenCalledTimes(1);
    });

    it('returns 409 when same key is used with different body', async () => {
      await request(app)
        .post('/api/streams')
        .set('Idempotency-Key', 'key-conflict')
        .send(validBody);

      const res2 = await request(app)
        .post('/api/streams')
        .set('Idempotency-Key', 'key-conflict')
        .send({ ...validBody, depositAmount: '9999' });

      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('CONFLICT');
    });

    it('accepts an explicit startTime', async () => {
      mockUpsertStream.mockResolvedValue({
        created: true,
        stream: makeDbRecord({ start_time: 1700000000 }),
      });

      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, startTime: 1700000000 });

      expect(res.status).toBe(201);
      expect(res.body.data.startTime).toBe(1700000000);
    });

    it('rejects missing sender', async () => {
      const { sender: _, ...body } = validBody;
      const res = await request(app).post('/api/streams').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('sender is required');
    });

    it('rejects empty sender', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, sender: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender - too short', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, sender: INVALID_KEY_SHORT });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender - wrong prefix', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, sender: INVALID_KEY_WRONG_PREFIX });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender - invalid characters', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, sender: INVALID_KEY_INVALID_CHARS });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender - generic string', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, sender: 'not-a-stellar-key' });
      expect(res.status).toBe(400);
    });

    it('rejects missing recipient', async () => {
      const { recipient: _, ...body } = validBody;
      const res = await request(app).post('/api/streams').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('recipient is required');
    });

    it('rejects empty recipient', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, recipient: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects invalid recipient - too short', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, recipient: INVALID_KEY_SHORT });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects invalid recipient - wrong prefix', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, recipient: INVALID_KEY_WRONG_PREFIX });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects non-positive depositAmount', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, depositAmount: '0' });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('depositAmount must be a positive numeric string');
    });

    it('rejects non-numeric depositAmount', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, depositAmount: 'abc' });
      expect(res.status).toBe(400);
    });

    it('rejects numeric depositAmount (must be string)', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, depositAmount: 1000 });
      expect(res.status).toBe(400);
    });

    it('rejects negative ratePerSecond', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, ratePerSecond: '-5' });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('ratePerSecond must be a positive numeric string');
    });

    it('rejects negative startTime', async () => {
      const res = await request(app).post('/api/streams').send({ ...validBody, startTime: -1 });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('startTime must be a non-negative number');
    });

    it('returns all validation errors at once', async () => {
      const res = await request(app).post('/api/streams').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      // At minimum sender and recipient errors
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    });

    it('does not log raw Stellar keys after creation', async () => {
      const logSpy = vi.spyOn(console, 'log');
      await request(app).post('/api/streams').send(validBody);
      const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join(' ');
      expect(allOutput).not.toContain(VALID_SENDER);
      expect(allOutput).not.toContain(VALID_RECIPIENT);
    });

    it('returns 503 when idempotency dependency is unavailable', async () => {
      setIdempotencyDependencyState('unavailable');
      const res = await request(app).post('/api/streams').send(validBody);
      expect(res.status).toBe(503);
    });

    it('returns 503 when pool is exhausted during upsert', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockUpsertStream.mockRejectedValue(new PoolExhaustedError());

      const res = await request(app).post('/api/streams').send(validBody);
      expect(res.status).toBe(503);
    });

    it('preserves decimal-string precision for amounts', async () => {
      mockUpsertStream.mockResolvedValue({
        created: true,
        stream: makeDbRecord({ amount: '0.0000001', rate_per_second: '0.0000116' }),
      });

      const res = await request(app).post('/api/streams').send({
        ...validBody,
        depositAmount: '0.0000001',
        ratePerSecond: '0.0000116',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.depositAmount).toBe('0.0000001');
      expect(res.body.data.ratePerSecond).toBe('0.0000116');
    });
  });

  // ── DELETE /api/streams/:id ─────────────────────────────────────────────────

  describe('DELETE /api/streams/:id', () => {
    it('cancels an active stream', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'active' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));

      const res = await request(app).delete('/api/streams/stream-abc-0');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toBe('Stream cancelled');
      expect(res.body.data.id).toBe('stream-abc-0');
    });

    it('returns 404 for a non-existent stream', async () => {
      mockGetById.mockResolvedValue(undefined);
      const res = await request(app).delete('/api/streams/stream-nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns 409 when stream is already cancelled', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));
      const res = await request(app).delete('/api/streams/stream-abc-0');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 409 when stream is already completed', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'completed' }));
      const res = await request(app).delete('/api/streams/stream-abc-0');
      expect(res.status).toBe(409);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockGetById.mockRejectedValue(new PoolExhaustedError());

      const res = await request(app).delete('/api/streams/stream-abc-0');
      expect(res.status).toBe(503);
    });
  });

  // ── PATCH /api/streams/:id/status ──────────────────────────────────────────

  describe('PATCH /api/streams/:id/status', () => {
    it('transitions active → paused', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'active' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'paused' }));

      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'paused' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('paused');
    });

    it('transitions paused → active', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'paused' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'active' }));

      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
    });

    it('transitions active → completed', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'active' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'completed' }));

      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
    });

    it('returns 409 for invalid transition: completed → active', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'completed' }));

      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'active' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 409 for invalid transition: cancelled → paused', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));

      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'paused' });

      expect(res.status).toBe(409);
    });

    it('returns 400 for unknown status value', async () => {
      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'unknown-status' });

      expect(res.status).toBe(400);
    });

    it('returns 404 when stream not found', async () => {
      mockGetById.mockResolvedValue(undefined);

      const res = await request(app)
        .patch('/api/streams/stream-nonexistent/status')
        .send({ status: 'paused' });

      expect(res.status).toBe(404);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockGetById.mockRejectedValue(new PoolExhaustedError());

      const res = await request(app)
        .patch('/api/streams/stream-abc-0/status')
        .send({ status: 'paused' });

      expect(res.status).toBe(503);
    });
  });

  // ── Response envelope ───────────────────────────────────────────────────────

  describe('response envelope', () => {
    it('success responses have { success: true, data, meta }', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
      const res = await request(app).get('/api/streams');
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.timestamp).toBeDefined();
    });

    it('error responses have { success: false, error: { code, message } }', async () => {
      const res = await request(app).get('/api/streams/nonexistent');
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBeDefined();
      expect(res.body.error.message).toBeDefined();
    });
  });
});
