/**
 * Authorization and negative-path assertions for `src/routes/audit.ts`.
 *
 * The audit surface is only safe if a caller can never page through (or
 * export) records they are not allowed to see, and if every malformed or
 * unauthorised request is rejected *before* any data — or any database work —
 * happens. These tests pin that contract for both endpoints:
 *
 *   GET /api/audit          paginated in-memory listing
 *   GET /api/audit/export   streamed CSV / NDJSON from the durable table
 *
 * For each endpoint the suite covers:
 *   - missing authentication             -> 401 UNAUTHORIZED
 *   - a valid token without `audit:read` -> 403 FORBIDDEN
 *   - malformed / out-of-bound input     -> 400 VALIDATION_ERROR
 *   - the documented error envelope (`{ success: false, error: { ... } }`)
 * and asserts that an unauthorised export never reaches the repository.
 *
 * No live Postgres or Redis is required: the pool, the audit repository, and
 * the JWT revocation store are mocked.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Hoisted module mocks ──────────────────────────────────────────────────────

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  DuplicateEntryError: class DuplicateEntryError extends Error {},
  QueryTimeoutError: class QueryTimeoutError extends Error {},
}));

vi.mock('../../src/db/repositories/auditRepository.js', () => ({
  auditRepository: {
    streamFiltered: vi.fn(),
    countFiltered: vi.fn(async () => 0),
  },
}));

vi.mock('../../src/redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn(async () => false),
}));

import { auditRouter } from '../../src/routes/audit.js';
import {
  auditRepository,
  type AuditLogRow,
} from '../../src/db/repositories/auditRepository.js';
import { query as poolQuery } from '../../src/db/pool.js';
import {
  recordAuditEvent,
  getAuditEntries,
  _resetAuditLog,
} from '../../src/lib/auditLog.js';
import { correlationIdMiddleware } from '../../src/middleware/correlationId.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

type MockFn = ReturnType<typeof vi.fn>;

const streamFiltered = auditRepository.streamFiltered as unknown as MockFn;
const dbQuery = poolQuery as unknown as MockFn;

let operatorToken: string;
let viewerToken: string;

const sampleRow: AuditLogRow = {
  id: '1',
  seq: '1',
  timestamp: '2026-01-04T09:12:44.001Z',
  action: 'STREAM_CANCELLED',
  resourceType: 'stream',
  resourceId: 'stream-42',
  correlationId: 'c-8f3e',
  meta: { actor: 'GADMIN' },
};

async function* emit(...rows: AuditLogRow[]): AsyncGenerator<AuditLogRow, void, undefined> {
  for (const row of rows) yield row;
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

function authed(req: request.Test, token: string): request.Test {
  return req.set('Authorization', `Bearer ${token}`);
}

/**
 * Assert the shared error envelope documented in `src/utils/response.ts`:
 * `{ success: false, error: { code, message } }` with a non-empty message.
 */
function expectErrorEnvelope(body: unknown, code: string): void {
  const envelope = body as {
    success?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  expect(envelope.success).toBe(false);
  expect(envelope.error).toBeDefined();
  expect(envelope.error?.code).toBe(code);
  expect(typeof envelope.error?.message).toBe('string');
  expect((envelope.error?.message ?? '').length).toBeGreaterThan(0);
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
  initializeConfig();
  operatorToken = generateToken({ address: 'GOPERATOR', role: 'operator' });
  viewerToken = generateToken({ address: 'GVIEWER', role: 'viewer' });
});

beforeEach(() => {
  _resetAuditLog();
  vi.clearAllMocks();
  streamFiltered.mockImplementation(() => emit());
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit — authentication and authorisation
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/audit — authentication and authorisation', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  it('rejects a request with no Authorization header (401 UNAUTHORIZED)', async () => {
    const res = await request(app).get('/api/audit').expect(401);
    expectErrorEnvelope(res.body, 'UNAUTHORIZED');
  });

  it('rejects a non-Bearer Authorization scheme (401 UNAUTHORIZED)', async () => {
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
    expectErrorEnvelope(res.body, 'UNAUTHORIZED');
  });

  it('rejects a malformed bearer token (401 UNAUTHORIZED)', async () => {
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
    expectErrorEnvelope(res.body, 'UNAUTHORIZED');
  });

  it('rejects a valid token without audit:read (403 FORBIDDEN)', async () => {
    const res = await authed(request(app).get('/api/audit'), viewerToken).expect(403);
    expectErrorEnvelope(res.body, 'FORBIDDEN');
  });

  it('does not leak audit entries to a caller without audit:read', async () => {
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'secret-stream');

    const res = await authed(request(app).get('/api/audit'), viewerToken).expect(403);

    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('secret-stream');
  });

  it('accepts an operator token (audit:read) and returns the documented success envelope', async () => {
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'stream-42');

    const res = await authed(request(app).get('/api/audit'), operatorToken).expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.entries)).toBe(true);
    expect(res.body.data.total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit — malformed input and boundary values
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/audit — malformed input', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  it.each([
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['limit=-1', 'limit'],
    ['limit=abc', 'limit'],
    ['limit=1.5', 'limit'],
    ['offset=-1', 'offset'],
    ['offset=abc', 'offset'],
  ])('rejects malformed %s with 400 VALIDATION_ERROR', async (query) => {
    const res = await authed(request(app).get(`/api/audit?${query}`), operatorToken).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.data).toBeUndefined();
  });
});

describe('GET /api/audit — boundary values', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  it('accepts the minimum page size (limit=1)', async () => {
    recordAuditEvent('STREAM_CANCELLED', 'stream', 's1');
    const res = await authed(request(app).get('/api/audit?limit=1'), operatorToken).expect(200);
    expect(res.body.data.entries).toHaveLength(1);
  });

  it('accepts the maximum page size (limit=100)', async () => {
    const res = await authed(request(app).get('/api/audit?limit=100'), operatorToken).expect(200);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it('accepts the minimum offset (offset=0)', async () => {
    const res = await authed(request(app).get('/api/audit?offset=0'), operatorToken).expect(200);
    expect(res.body.data.total).toBe(0);
  });

  it('treats an offset far past the end as an empty page, not an error', async () => {
    recordAuditEvent('STREAM_CANCELLED', 'stream', 's1');
    const res = await authed(
      request(app).get('/api/audit?offset=1000000'),
      operatorToken,
    ).expect(200);
    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.total).toBe(1);
  });
});

describe('GET /api/audit — filters scope the visible population', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    recordAuditEvent('STREAM_CREATED', 'stream', 'a', undefined, { actor: 'GALICE' });
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'b', undefined, { actor: 'GBOB' });
    recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system', undefined, {
      actor: 'GALICE',
    });
  });

  it('scopes by actionType', async () => {
    const res = await authed(
      request(app).get('/api/audit?actionType=STREAM_CANCELLED'),
      operatorToken,
    ).expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.entries[0].resourceId).toBe('b');
  });

  it('scopes by resourceType', async () => {
    const res = await authed(
      request(app).get('/api/audit?resourceType=pauseFlags'),
      operatorToken,
    ).expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.entries[0].action).toBe('PAUSE_FLAGS_UPDATED');
  });

  it('scopes by resourceId', async () => {
    const res = await authed(
      request(app).get('/api/audit?resourceId=a'),
      operatorToken,
    ).expect(200);
    expect(res.body.data.total).toBe(1);
  });

  it('scopes by actor from meta', async () => {
    const res = await authed(
      request(app).get('/api/audit?actor=GALICE'),
      operatorToken,
    ).expect(200);
    expect(res.body.data.total).toBe(2);
  });

  it('applies dateFrom and dateTo as an inclusive range', async () => {
    const timestamps = getAuditEntries().map((entry) => entry.timestamp);
    const first = timestamps[0] as string;
    const last = timestamps[timestamps.length - 1] as string;

    const from = await authed(
      request(app).get(`/api/audit?dateFrom=${encodeURIComponent(first)}`),
      operatorToken,
    ).expect(200);
    expect(from.body.data.total).toBe(3);

    const to = await authed(
      request(app).get(`/api/audit?dateTo=${encodeURIComponent(last)}`),
      operatorToken,
    ).expect(200);
    expect(to.body.data.total).toBe(3);

    const equalRange = await authed(
      request(app).get(
        `/api/audit?dateFrom=${encodeURIComponent(first)}&dateTo=${encodeURIComponent(first)}`,
      ),
      operatorToken,
    ).expect(200);
    expect(equalRange.body.data.total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit/export — authentication and authorisation
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — authentication and authorisation', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  it('rejects a request with no Authorization header (401 UNAUTHORIZED)', async () => {
    const res = await request(app).get('/api/audit/export').expect(401);
    expectErrorEnvelope(res.body, 'UNAUTHORIZED');
  });

  it('rejects a malformed bearer token (401 UNAUTHORIZED)', async () => {
    const res = await request(app)
      .get('/api/audit/export')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
    expectErrorEnvelope(res.body, 'UNAUTHORIZED');
  });

  it('rejects a valid token without audit:read (403 FORBIDDEN)', async () => {
    const res = await authed(request(app).get('/api/audit/export'), viewerToken).expect(403);
    expectErrorEnvelope(res.body, 'FORBIDDEN');
  });

  it('never reaches the repository or writes a self-audit row when unauthorised', async () => {
    await authed(request(app).get('/api/audit/export'), viewerToken).expect(403);

    expect(streamFiltered).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit/export — malformed input
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — malformed input', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  it('rejects an unknown format and names the parameter', async () => {
    const res = await authed(
      request(app).get('/api/audit/export?format=pdf'),
      operatorToken,
    ).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(String((res.body.error as { message: string }).message)).toMatch(/^format:/);
  });

  it('rejects a format with the wrong case', async () => {
    const res = await authed(
      request(app).get('/api/audit/export?format=CSV'),
      operatorToken,
    ).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('rejects an impossible calendar date instead of rolling it over', async () => {
    const res = await authed(
      request(app).get('/api/audit/export?dateFrom=2026-02-31T00:00:00.000Z'),
      operatorToken,
    ).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(String((res.body.error as { message: string }).message)).toMatch(/^dateFrom:/);
  });

  it('rejects a date with an out-of-range month', async () => {
    const res = await authed(
      request(app).get('/api/audit/export?dateTo=2026-13-01T00:00:00.000Z'),
      operatorToken,
    ).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('rejects a non-UTC offset instead of parsing it loosely', async () => {
    const res = await authed(
      request(app).get('/api/audit/export?dateFrom=2026-01-01T00:00:00%2B01:00'),
      operatorToken,
    ).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(String((res.body.error as { message: string }).message)).toMatch(/^dateFrom:/);
  });

  it('rejects a dateFrom later than dateTo', async () => {
    const res = await authed(
      request(app).get(
        '/api/audit/export?dateFrom=2026-02-01T00:00:00.000Z&dateTo=2026-01-01T00:00:00.000Z',
      ),
      operatorToken,
    ).expect(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(String((res.body.error as { message: string }).message)).toMatch(/^dateFrom:/);
  });

  it('does not fetch any rows when the query is malformed', async () => {
    await authed(
      request(app).get('/api/audit/export?format=pdf'),
      operatorToken,
    ).expect(400);

    expect(streamFiltered).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit/export — boundary values, scoping, and streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — boundary values and streaming', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  it('defaults to CSV with only the header row when nothing matches', async () => {
    const res = await authed(request(app).get('/api/audit/export'), operatorToken).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-export-.+\.csv"$/,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.trim()).toBe('id,seq,timestamp,action,resource_type,resource_id,correlation_id,meta');
  });

  it('streams NDJSON when format=ndjson is requested', async () => {
    streamFiltered.mockImplementation(() => emit(sampleRow));

    const res = await authed(
      request(app).get('/api/audit/export?format=ndjson'),
      operatorToken,
    ).expect(200);

    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      id: '1',
      action: 'STREAM_CANCELLED',
      resourceId: 'stream-42',
    });
  });

  it('accepts an ISO-8601 instant without milliseconds at the boundary', async () => {
    const res = await authed(
      request(app).get(
        '/api/audit/export?dateFrom=2026-01-01T00:00:00Z&dateTo=2026-01-01T00:00:00Z',
      ),
      operatorToken,
    ).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('passes every filter through to the repository so the export scopes identically to the listing', async () => {
    await authed(
      request(app).get(
        '/api/audit/export?actor=GADMIN&actionType=STREAM_CANCELLED&resourceType=stream' +
          '&resourceId=stream-42&dateFrom=2026-01-01T00:00:00.000Z' +
          '&dateTo=2026-02-01T00:00:00.000Z&format=ndjson',
      ),
      operatorToken,
    ).expect(200);

    expect(streamFiltered).toHaveBeenCalledTimes(1);
    expect(streamFiltered.mock.calls[0]?.[0]).toEqual({
      actor: 'GADMIN',
      action: 'STREAM_CANCELLED',
      resourceType: 'stream',
      resourceId: 'stream-42',
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-02-01T00:00:00.000Z',
    });
    const options = streamFiltered.mock.calls[0]?.[1] as { signal?: unknown };
    expect(options.signal).toBeDefined();
  });

  it('records the self-audit export row before any data is read', async () => {
    let writesWhenStreamingStarted = -1;
    streamFiltered.mockImplementation(() => {
      writesWhenStreamingStarted = dbQuery.mock.calls.length;
      return emit(sampleRow);
    });

    await authed(request(app).get('/api/audit/export'), operatorToken).expect(200);

    expect(dbQuery).toHaveBeenCalled();
    expect(writesWhenStreamingStarted).toBeGreaterThanOrEqual(1);
  });

  it('serialises CSV rows through the documented quoting rules', async () => {
    streamFiltered.mockImplementation(() => emit(sampleRow));

    const res = await authed(request(app).get('/api/audit/export'), operatorToken).expect(200);

    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"STREAM_CANCELLED"');
    expect(lines[1]).toContain('"stream-42"');
  });
});
