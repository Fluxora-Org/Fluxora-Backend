/**
 * Integration tests for the streams HTTP routes.
 *
 * The PostgreSQL repository is fully mocked so no real database is required.
 * Tests cover all routes, validation, idempotency, state-machine transitions,
 * and error envelopes.
 *
 * Idempotency coverage (§ "replay/collision tests"):
 *   - Missing Idempotency-Key → 400
 *   - Malformed key (bad chars, too long) → 400
 *   - First creation → 201, Idempotency-Replayed: false
 *   - Replay (same key + same body) → 201, Idempotency-Replayed: true, meta.idempotencyReplayed: true
 *   - Collision (same key + different body) → 409 CONFLICT, no key leaked in body
 *   - Independent keys → independent streams
 *   - Idempotency store unavailable → 503
 *   - DB pool exhausted during upsert → 503 (key NOT stored)
 *   - Decimal-string precision preserved through replay
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock the repository before importing the app ──────────────────────────────
const mockGetById        = vi.fn();
const mockUpsertStream   = vi.fn();
const mockUpdateStream   = vi.fn();
const mockFindWithCursor = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById:        (...a: unknown[]) => mockGetById(...a),
    upsertStream:   (...a: unknown[]) => mockUpsertStream(...a),
    updateStream:   (...a: unknown[]) => mockUpdateStream(...a),
    findWithCursor: (...a: unknown[]) => mockFindWithCursor(...a),
    countByStatus:  vi.fn().mockResolvedValue({ active: 0, paused: 0, completed: 0, cancelled: 0 }),
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
}));

import { createApp } from '../../src/app.js';
import {
  _resetStreams,
  setStreamListingDependencyState,
  setIdempotencyDependencyState,
} from '../../src/routes/streams.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

// Initialize config before importing anything that needs it
initializeConfig();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_SENDER    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

const TEST_TOKEN = generateToken({ address: VALID_SENDER, role: 'operator' });

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

// ── Helpers ───────────────────────────────────────────────────────────────────

let _keyCounter = 0;
function uniqueKey(prefix = 'key'): string {
  return `${prefix}-${++_keyCounter}`;
}

function post(body: Record<string, unknown>, key?: string) {
  const req = request(app)
    .post('/api/streams')
    .set('Authorization', `Bearer ${TEST_TOKEN}`)
    .send(body);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('streams routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStreams();
    setStreamListingDependencyState('healthy');
    setIdempotencyDependencyState('healthy');

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

  // ── GET /api/streams ──────────────────────────────────────────────────────

  describe('GET /api/streams', () => {
    it('returns an empty list when no streams exist', async () => {
      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.streams).toEqual([]);
      expect(res.body.data.has_more).toBe(false);
    });

    it('returns mapped streams from the repository', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [makeDbRecord()], hasMore: false });
      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(200);
      expect(res.body.data.streams).toHaveLength(1);
      const s = res.body.data.streams[0];
      expect(s.sender).toBe(VALID_SENDER);
      expect(s.depositAmount).toBe('1000');
      expect(s.ratePerSecond).toBe('10');
    });

    it('includes next_cursor when hasMore=true', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [makeDbRecord({ id: 'stream-abc-0' })], hasMore: true });
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
      expect((await request(app).get('/api/streams?limit=101')).status).toBe(400);
    });

    it('rejects invalid cursor', async () => {
      expect((await request(app).get('/api/streams?cursor=!!!invalid!!!')).status).toBe(400);
    });

    it('rejects invalid include_total value', async () => {
      expect((await request(app).get('/api/streams?include_total=maybe')).status).toBe(400);
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
      expect((await request(app).get('/api/streams')).status).toBe(503);
    });

    it('passes afterId to repository from a valid cursor', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
      const cursor = Buffer.from(JSON.stringify({ v: 1, lastId: 'stream-abc-0' })).toString('base64url');
      await request(app).get(`/api/streams?cursor=${cursor}`);
      expect(mockFindWithCursor).toHaveBeenCalledWith(
        expect.anything(), expect.any(Number), 'stream-abc-0', expect.any(Boolean),
      );
    });
  });

  // ── GET /api/streams/:id ──────────────────────────────────────────────────

  describe('GET /api/streams/:id', () => {
    it('returns 404 for a non-existent stream', async () => {
      mockGetById.mockResolvedValue(undefined);
      const res = await request(app).get('/api/streams/stream-nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns the stream when found', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-abc-0' }));
      const res = await request(app).get('/api/streams/stream-abc-0');
      expect(res.status).toBe(200);
      expect(res.body.data.stream.id).toBe('stream-abc-0');
      expect(res.body.data.stream.depositAmount).toBe('1000');
    });

    it('maps DB snake_case to API camelCase', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({
        amount: '500', rate_per_second: '5', start_time: 1700000000, end_time: 1800000000,
      }));
      const s = (await request(app).get('/api/streams/stream-abc-0')).body.data.stream;
      expect(s.depositAmount).toBe('500');
      expect(s.ratePerSecond).toBe('5');
      expect(s.startTime).toBe(1700000000);
      expect(s.endTime).toBe(1800000000);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockGetById.mockRejectedValue(new PoolExhaustedError());
      expect((await request(app).get('/api/streams/stream-x')).status).toBe(503);
    });
  });


  // ── POST /api/streams — idempotency ──────────────────────────────────────

  describe('POST /api/streams — idempotency', () => {

    // ── Missing / malformed key ─────────────────────────────────────────────

    it('returns 400 when Idempotency-Key header is absent', async () => {
      const res = await post(validBody); // no key
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/Idempotency-Key/);
    });

    it('returns 400 when Idempotency-Key is an empty string', async () => {
      const res = await post(validBody, '');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when Idempotency-Key exceeds 128 characters', async () => {
      const res = await post(validBody, 'a'.repeat(129));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts an Idempotency-Key of exactly 128 characters', async () => {
      const res = await post(validBody, 'a'.repeat(128));
      expect(res.status).toBe(201);
    });

    it('accepts an Idempotency-Key of exactly 1 character', async () => {
      const res = await post(validBody, 'z');
      expect(res.status).toBe(201);
    });

    it('returns 400 when Idempotency-Key contains disallowed characters (space)', async () => {
      const res = await post(validBody, 'key with spaces');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when Idempotency-Key contains disallowed characters (slash)', async () => {
      const res = await post(validBody, 'key/slash');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts keys with allowed special characters (colon, underscore, hyphen)', async () => {
      const res = await post(validBody, 'my-key_v1:2024');
      expect(res.status).toBe(201);
    });

    it('accepts a UUID-formatted key', async () => {
      const res = await post(validBody, '550e8400-e29b-41d4-a716-446655440000');
      expect(res.status).toBe(201);
    });

    // ── First creation ──────────────────────────────────────────────────────

    it('returns 201 on first creation with Idempotency-Replayed: false', async () => {
      const res = await post(validBody, uniqueKey());
      expect(res.status).toBe(201);
      expect(res.headers['idempotency-replayed']).toBe('false');
      expect(res.body.success).toBe(true);
      expect(res.body.meta.idempotencyReplayed).toBeUndefined();
    });

    it('echoes the Idempotency-Key header in the response', async () => {
      const key = uniqueKey('echo');
      const res = await post(validBody, key);
      expect(res.status).toBe(201);
      expect(res.headers['idempotency-key']).toBe(key);
    });

    it('calls upsertStream exactly once on first creation', async () => {
      await post(validBody, uniqueKey());
      expect(mockUpsertStream).toHaveBeenCalledTimes(1);
    });

    // ── Replay (same key + same body) ───────────────────────────────────────

    it('returns 201 on replay with Idempotency-Replayed: true', async () => {
      const key = uniqueKey('replay');
      await post(validBody, key).expect(201);
      const res = await post(validBody, key);
      expect(res.status).toBe(201);
      expect(res.headers['idempotency-replayed']).toBe('true');
    });

    it('sets meta.idempotencyReplayed=true on replay response', async () => {
      const key = uniqueKey('meta-replay');
      await post(validBody, key).expect(201);
      const res = await post(validBody, key).expect(201);
      expect(res.body.meta.idempotencyReplayed).toBe(true);
    });

    it('returns identical data body on replay', async () => {
      const key = uniqueKey('data-replay');
      const first = await post(validBody, key).expect(201);
      const second = await post(validBody, key).expect(201);
      expect(second.body.data).toEqual(first.body.data);
    });

    it('does NOT call upsertStream on replay', async () => {
      const key = uniqueKey('no-upsert');
      await post(validBody, key).expect(201);
      vi.clearAllMocks();
      await post(validBody, key).expect(201);
      expect(mockUpsertStream).not.toHaveBeenCalled();
    });

    it('preserves decimal-string precision through replay', async () => {
      const preciseBody = { ...validBody, depositAmount: '1000000.0000007', ratePerSecond: '0.0000116' };
      mockUpsertStream.mockResolvedValue({
        created: true,
        stream: makeDbRecord({ amount: '1000000.0000007', rate_per_second: '0.0000116' }),
      });
      const key = uniqueKey('decimal-replay');
      await post(preciseBody, key).expect(201);
      const res = await post(preciseBody, key).expect(201);
      expect(res.body.data.depositAmount).toBe('1000000.0000007');
      expect(res.body.data.ratePerSecond).toBe('0.0000116');
    });

    it('handles concurrent replays safely (sequential simulation)', async () => {
      const key = uniqueKey('concurrent');
      await post(validBody, key).expect(201);
      const [r1, r2, r3] = await Promise.all([
        post(validBody, key),
        post(validBody, key),
        post(validBody, key),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r3.status).toBe(201);
      // Only the original upsert call
      expect(mockUpsertStream).toHaveBeenCalledTimes(1);
    });

    // ── Collision (same key + different body) ───────────────────────────────

    it('returns 409 CONFLICT when same key is reused with a different body', async () => {
      const key = uniqueKey('conflict');
      await post(validBody, key).expect(201);
      const res = await post({ ...validBody, depositAmount: '9999' }, key);
      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('409 conflict body does NOT contain the raw Idempotency-Key value', async () => {
      const key = uniqueKey('no-key-leak');
      await post(validBody, key).expect(201);
      const res = await post({ ...validBody, depositAmount: '9999' }, key).expect(409);
      // The key must not appear anywhere in the serialised response body
      expect(JSON.stringify(res.body)).not.toContain(key);
    });

    it('409 conflict body contains a hint for recovery', async () => {
      const key = uniqueKey('hint');
      await post(validBody, key).expect(201);
      const res = await post({ ...validBody, depositAmount: '1' }, key).expect(409);
      expect(res.body.error.details).toBeDefined();
    });

    it('different keys for different bodies create independent streams', async () => {
      const key1 = uniqueKey('ind-a');
      const key2 = uniqueKey('ind-b');
      const r1 = await post(validBody, key1).expect(201);
      const r2 = await post({ ...validBody, depositAmount: '2000' }, key2).expect(201);
      expect(r1.body.data.id).toBeDefined();
      expect(r2.body.data.id).toBeDefined();
      expect(mockUpsertStream).toHaveBeenCalledTimes(2);
    });

    it('same body with different keys creates two separate upsert calls', async () => {
      await post(validBody, uniqueKey('sep-a')).expect(201);
      await post(validBody, uniqueKey('sep-b')).expect(201);
      expect(mockUpsertStream).toHaveBeenCalledTimes(2);
    });

    // ── Dependency / infrastructure failures ────────────────────────────────

    it('returns 503 when idempotency dependency is unavailable', async () => {
      setIdempotencyDependencyState('unavailable');
      const res = await post(validBody, uniqueKey());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns 503 when pool is exhausted during upsert', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockUpsertStream.mockRejectedValue(new PoolExhaustedError());
      const res = await post(validBody, uniqueKey());
      expect(res.status).toBe(503);
    });

    it('does NOT cache the response when upsert fails (no phantom replay)', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      const key = uniqueKey('no-cache-on-fail');
      mockUpsertStream.mockRejectedValueOnce(new PoolExhaustedError());
      await post(validBody, key).expect(503);

      // Second attempt with DB healthy — should attempt upsert again, not replay
      mockUpsertStream.mockResolvedValueOnce({ created: true, stream: makeDbRecord() });
      const res = await post(validBody, key).expect(201);
      expect(res.headers['idempotency-replayed']).toBe('false');
      expect(mockUpsertStream).toHaveBeenCalledTimes(2);
    });

    // ── Security: no secret leakage in logs ─────────────────────────────────

    it('does not log raw Stellar addresses after creation', async () => {
      const warnSpy  = vi.spyOn(console, 'warn');
      const errorSpy = vi.spyOn(console, 'error');
      await post(validBody, uniqueKey('pii-check')).expect(201);
      const allOutput = [
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].map((c) => String(c[0])).join(' ');
      expect(allOutput).not.toContain(VALID_SENDER);
      expect(allOutput).not.toContain(VALID_RECIPIENT);
    });

    it('does not log the raw Idempotency-Key value on conflict', async () => {
      const key = uniqueKey('key-not-logged');
      const warnSpy = vi.spyOn(console, 'warn');
      await post(validBody, key).expect(201);
      await post({ ...validBody, depositAmount: '1' }, key).expect(409);
      const allWarn = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
      expect(allWarn).not.toContain(key);
    });
  });


  // ── POST /api/streams — validation ───────────────────────────────────────

  describe('POST /api/streams — validation', () => {
    it('creates a stream with valid input', async () => {
      const res = await post(validBody, uniqueKey());
      expect(res.status).toBe(201);
      expect(res.body.data.sender).toBe(VALID_SENDER);
      expect(res.body.data.depositAmount).toBe('1000');
      expect(res.body.data.status).toBe('active');
    });

    it('rejects missing sender', async () => {
      const { sender: _, ...body } = validBody;
      const res = await post(body, uniqueKey());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid sender (too short)', async () => {
      const res = await post({ ...validBody, sender: 'GABC123' }, uniqueKey());
      expect(res.status).toBe(400);
    });

    it('rejects invalid sender (wrong prefix)', async () => {
      const res = await post({ ...validBody, sender: 'AAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7' }, uniqueKey());
      expect(res.status).toBe(400);
    });

    it('rejects missing recipient', async () => {
      const { recipient: _, ...body } = validBody;
      const res = await post(body, uniqueKey());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-positive depositAmount', async () => {
      const res = await post({ ...validBody, depositAmount: '0' }, uniqueKey());
      expect(res.status).toBe(400);
    });

    it('rejects numeric depositAmount (must be string)', async () => {
      const res = await post({ ...validBody, depositAmount: 1000 }, uniqueKey());
      expect(res.status).toBe(400);
    });

    it('rejects negative ratePerSecond', async () => {
      const res = await post({ ...validBody, ratePerSecond: '-5' }, uniqueKey());
      expect(res.status).toBe(400);
    });

    it('rejects negative startTime', async () => {
      const res = await post({ ...validBody, startTime: -1 }, uniqueKey());
      expect(res.status).toBe(400);
    });

    it('returns all validation errors at once', async () => {
      const res = await post({}, uniqueKey());
      expect(res.status).toBe(400);
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves decimal-string precision for amounts', async () => {
      mockUpsertStream.mockResolvedValue({
        created: true,
        stream: makeDbRecord({ amount: '0.0000001', rate_per_second: '0.0000116' }),
      });
      const res = await post({ ...validBody, depositAmount: '0.0000001', ratePerSecond: '0.0000116' }, uniqueKey());
      expect(res.status).toBe(201);
      expect(res.body.data.depositAmount).toBe('0.0000001');
      expect(res.body.data.ratePerSecond).toBe('0.0000116');
    });
  });

  // ── DELETE /api/streams/:id ───────────────────────────────────────────────

  describe('DELETE /api/streams/:id', () => {
    it('cancels an active stream', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'active' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));
      const res = await request(app)
        .delete('/api/streams/stream-abc-0')
        .set('Authorization', `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Stream cancelled');
    });

    it('returns 404 for a non-existent stream', async () => {
      mockGetById.mockResolvedValue(undefined);
      expect((await request(app)
        .delete('/api/streams/stream-nonexistent')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      ).status).toBe(404);
    });

    it('returns 409 when stream is already cancelled', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));
      const res = await request(app)
        .delete('/api/streams/stream-abc-0')
        .set('Authorization', `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 409 when stream is already completed', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'completed' }));
      expect((await request(app)
        .delete('/api/streams/stream-abc-0')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      ).status).toBe(409);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockGetById.mockRejectedValue(new PoolExhaustedError());
      expect((await request(app)
        .delete('/api/streams/stream-abc-0')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      ).status).toBe(503);
    });
  });

  // ── PATCH /api/streams/:id/status ────────────────────────────────────────

  describe('PATCH /api/streams/:id/status', () => {
    it('transitions active → paused', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'active' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'paused' }));
      const res = await request(app).patch('/api/streams/stream-abc-0/status').send({ status: 'paused' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('paused');
    });

    it('transitions paused → active', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'paused' }));
      mockUpdateStream.mockResolvedValue(makeDbRecord({ status: 'active' }));
      const res = await request(app).patch('/api/streams/stream-abc-0/status').send({ status: 'active' });
      expect(res.status).toBe(200);
    });

    it('returns 409 for invalid transition: completed → active', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'completed' }));
      const res = await request(app).patch('/api/streams/stream-abc-0/status').send({ status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 409 for invalid transition: cancelled → paused', async () => {
      mockGetById.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));
      expect((await request(app).patch('/api/streams/stream-abc-0/status').send({ status: 'paused' })).status).toBe(409);
    });

    it('returns 400 for unknown status value', async () => {
      expect((await request(app).patch('/api/streams/stream-abc-0/status').send({ status: 'unknown-status' })).status).toBe(400);
    });

    it('returns 404 when stream not found', async () => {
      mockGetById.mockResolvedValue(undefined);
      expect((await request(app).patch('/api/streams/stream-nonexistent/status').send({ status: 'paused' })).status).toBe(404);
    });

    it('returns 503 when pool is exhausted', async () => {
      const { PoolExhaustedError } = await import('../../src/db/pool.js');
      mockGetById.mockRejectedValue(new PoolExhaustedError());
      expect((await request(app).patch('/api/streams/stream-abc-0/status').send({ status: 'paused' })).status).toBe(503);
    });
  });

  // ── Response envelope ─────────────────────────────────────────────────────

  describe('response envelope', () => {
    it('success responses have { success: true, data, meta }', async () => {
      mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
      const res = await request(app).get('/api/streams');
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.meta.timestamp).toBeDefined();
    });

    it('error responses have { success: false, error: { code, message } }', async () => {
      const res = await request(app).get('/api/streams/nonexistent');
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBeDefined();
      expect(res.body.error.message).toBeDefined();
    });

    it('replay responses have meta.idempotencyReplayed=true', async () => {
      const key = uniqueKey('envelope-replay');
      await post(validBody, key).expect(201);
      const res = await post(validBody, key).expect(201);
      expect(res.body.meta.idempotencyReplayed).toBe(true);
    });

    it('fresh creation responses do NOT have meta.idempotencyReplayed', async () => {
      const res = await post(validBody, uniqueKey('envelope-fresh')).expect(201);
      expect(res.body.meta.idempotencyReplayed).toBeUndefined();
    });
  });
});
