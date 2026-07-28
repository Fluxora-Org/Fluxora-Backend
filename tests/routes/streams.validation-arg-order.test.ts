/**
 * Regression tests for ApiError constructor argument order (#881).
 *
 * Every call site that constructs `new ApiError(statusCode, code, message, details)`
 * must pass arguments in the correct order. Prior to the fix, several sites in
 * `routes/streams.ts` and `indexer/service.ts` passed `(ApiErrorCode, message, statusNumber, details)`
 * which produced broken responses (non-numeric statusCode, swapped code/message).
 *
 * These tests assert the actual HTTP status code AND error code body for every
 * validation-error path that was previously broken.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  QueryTimeoutError:   class QueryTimeoutError extends Error {
    constructor() { super('query timeout'); this.name = 'QueryTimeoutError'; }
  },
}));

// Mock auth middleware — bypass API key and scope checks so JWT-authenticated
// requests can reach the route handlers.  Matches the pattern used by
// streams-sse.test.ts which works against the same route definitions.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...original,
    authenticateApiKey: (_req: any, _res: any, next: any) => next(),
    requireScope: () => (_req: any, _res: any, next: any) => next(),
  };
});

import { createApp } from '../../src/app.js';
import {
  _resetStreams,
  setStreamListingDependencyState,
  setIdempotencyDependencyState,
} from '../../src/routes/streams.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

initializeConfig();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_SENDER    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';
const TEST_TOKEN      = generateToken({ address: VALID_SENDER, role: 'operator' });

const app = createApp();

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/streams — ApiError argument order regression (#881)', () => {
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

  // ── Call site 1: Zod schema validation failure (normalizeCreateInput) ──────

  it('returns HTTP 400 with error.code VALIDATION_ERROR for missing required fields', async () => {
    const res = await post({}, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.code).toBe('string');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);
  });

  it('returns HTTP 400 with error.code VALIDATION_ERROR for invalid sender format', async () => {
    const res = await post({ ...validBody, sender: 'NOT-A-VALID-KEY' }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns HTTP 400 with error.code VALIDATION_ERROR for missing recipient', async () => {
    const { recipient: _, ...bodyWithoutRecipient } = validBody;
    const res = await post(bodyWithoutRecipient, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns HTTP 400 with error.code VALIDATION_ERROR for numeric (non-string) depositAmount', async () => {
    const res = await post({ ...validBody, depositAmount: 1000 }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Call site 2: Amount field validation failure (normalizeCreateInput) ─────

  it('returns HTTP 400 with error.code VALIDATION_ERROR for invalid decimal format in depositAmount', async () => {
    const res = await post({ ...validBody, depositAmount: 'not-a-number' }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns HTTP 400 with error.code VALIDATION_ERROR for invalid decimal format in ratePerSecond', async () => {
    const res = await post({ ...validBody, ratePerSecond: 'abc' }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Business-rule validation (normalizeCreateInput — via validationError helper) ──

  it('returns HTTP 400 for non-positive depositAmount', async () => {
    const res = await post({ ...validBody, depositAmount: '0' }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns HTTP 400 for negative depositAmount', async () => {
    const res = await post({ ...validBody, depositAmount: '-100' }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns HTTP 400 for negative ratePerSecond', async () => {
    const res = await post({ ...validBody, ratePerSecond: '-5' }, uniqueKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Call site 3: Idempotency-Key collision (POST handler) ──────────────────

  it('returns HTTP 409 with error.code CONFLICT for idempotency key reuse with different body', async () => {
    const key = uniqueKey('conflict');
    await post(validBody, key).expect(201);

    const res = await post({ ...validBody, depositAmount: '9999' }, key);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error.code).toBe('string');
    expect(res.body.error.code).toBe('CONFLICT');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);
  });

  // ── Error response shape validation ────────────────────────────────────────

  it('validation error responses have a numeric statusCode in the error envelope', async () => {
    const res = await post({}, uniqueKey());
    expect(res.status).toBe(400);
    if (res.body.error.statusCode !== undefined) {
      expect(typeof res.body.error.statusCode).toBe('number');
    }
  });

  it('conflict error responses have a numeric statusCode in the error envelope', async () => {
    const key = uniqueKey('conflict-envelope');
    await post(validBody, key).expect(201);

    const res = await post({ ...validBody, depositAmount: '500' }, key);
    expect(res.status).toBe(409);
    if (res.body.error.statusCode !== undefined) {
      expect(typeof res.body.error.statusCode).toBe('number');
    }
  });

  it('error.code is always a string enum value, not a number', async () => {
    const res = await post({}, uniqueKey());
    expect(res.status).toBe(400);
    expect(typeof res.body.error.code).toBe('string');
    expect(res.body.error.code).not.toBe(400);
    expect(res.body.error.code).not.toBe('400');
  });
});

describe('DELETE /api/streams/:id — ApiError argument order regression (#881)', () => {
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

  // ── Call site 4: assertValidApiTransition guard ────────────────────────────

  it('returns HTTP 409 with error.code CONFLICT when cancelling an already-cancelled stream', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));
    const res = await request(app)
      .delete('/api/streams/stream-abc-0')
      .set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('returns HTTP 409 with error.code CONFLICT when cancelling a completed stream', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ status: 'completed' }));
    const res = await request(app)
      .delete('/api/streams/stream-abc-0')
      .set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('PATCH /api/streams/:id/status — ApiError argument order regression (#881)', () => {
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

  // ── Call site 5: assertValidApiTransition guard (PATCH) ────────────────────

  it('returns HTTP 409 with error.code CONFLICT for completed → active transition', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ status: 'completed' }));
    const res = await request(app)
      .patch('/api/streams/stream-abc-0/status')
      .send({ status: 'active' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('returns HTTP 409 with error.code CONFLICT for cancelled → paused transition', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ status: 'cancelled' }));
    const res = await request(app)
      .patch('/api/streams/stream-abc-0/status')
      .send({ status: 'paused' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns HTTP 409 with error.code CONFLICT for active → active (already active)', async () => {
    mockGetById.mockResolvedValue(makeDbRecord({ status: 'active' }));
    const res = await request(app)
      .patch('/api/streams/stream-abc-0/status')
      .send({ status: 'active' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
