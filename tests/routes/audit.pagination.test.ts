/**
 * Integration tests for GET /api/audit — pagination and sensitive field redaction.
 *
 * Covers:
 *  - Unauthenticated request returns 401
 *  - ?limit=10&offset=0 → response array length ≤ 10
 *  - ?limit=0 → 400 (invalid limit)
 *  - ?limit=9999 → 400 (exceeds max)
 *  - ?limit=-1 → 400 (negative limit)
 *  - ?offset=-1 → 400 (negative offset)
 *  - ?limit=abc → 400 (non-numeric)
 *  - Pagination slice: offset skips entries, limit caps returned count
 *  - No RESTRICTED field names (authToken, authorization, x-api-key) appear in
 *    any `meta` value — the most critical security assertion in this suite.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { auditRouter } from '../../src/routes/audit.js';
import { recordAuditEvent, _resetAuditLog } from '../../src/lib/auditLog.js';
import { correlationIdMiddleware } from '../../src/middleware/correlationId.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

// ── Mock DB dependencies (not needed for in-memory audit log) ─────────────────

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById:        vi.fn(),
    upsertStream:   vi.fn(),
    updateStream:   vi.fn(),
    findWithCursor: vi.fn().mockResolvedValue({ streams: [], hasMore: false }),
    countByStatus:  vi.fn().mockResolvedValue({}),
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

vi.mock('../../src/redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
}));

// ── Config & token setup ──────────────────────────────────────────────────────

let authToken: string;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
  initializeConfig();
  authToken = generateToken({ address: 'GTEST', role: 'operator' });
});

// ── App fixture ───────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${authToken}`);
}

/** Seed the audit log with N generic entries. */
function seedEntries(n: number, metaOverride?: Record<string, unknown>): void {
  for (let i = 0; i < n; i++) {
    recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`, undefined, metaOverride);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/audit — authentication', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    _resetAuditLog();
    app = makeApp();
  });

  it('returns 401 when no Authorization header is provided', async () => {
    await request(app).get('/api/audit').expect(401);
  });

  it('returns 401 when Authorization header is malformed', async () => {
    await request(app)
      .get('/api/audit')
      .set('Authorization', 'NotBearer token')
      .expect(401);
  });

  it('returns 200 with a valid bearer token', async () => {
    await authed(request(app).get('/api/audit')).expect(200);
  });
});

describe('GET /api/audit — pagination parameter validation', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    _resetAuditLog();
    app = makeApp();
  });

  it('returns 400 for limit=0', async () => {
    const res = await authed(request(app).get('/api/audit?limit=0')).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for limit=9999 (exceeds maximum of 100)', async () => {
    const res = await authed(request(app).get('/api/audit?limit=9999')).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for limit=101 (just above maximum)', async () => {
    const res = await authed(request(app).get('/api/audit?limit=101')).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for limit=-1 (negative)', async () => {
    const res = await authed(request(app).get('/api/audit?limit=-1')).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-numeric limit', async () => {
    const res = await authed(request(app).get('/api/audit?limit=abc')).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for offset=-1 (negative)', async () => {
    const res = await authed(request(app).get('/api/audit?offset=-1')).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts limit=1 (minimum boundary)', async () => {
    await authed(request(app).get('/api/audit?limit=1')).expect(200);
  });

  it('accepts limit=100 (maximum boundary)', async () => {
    await authed(request(app).get('/api/audit?limit=100')).expect(200);
  });

  it('accepts offset=0 (minimum boundary)', async () => {
    await authed(request(app).get('/api/audit?offset=0')).expect(200);
  });
});

describe('GET /api/audit — pagination behaviour', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    _resetAuditLog();
    app = makeApp();
    seedEntries(25);
  });

  it('returns at most `limit` entries when limit=10', async () => {
    const res = await authed(request(app).get('/api/audit?limit=10&offset=0')).expect(200);
    expect(res.body.data.entries.length).toBeLessThanOrEqual(10);
    expect(res.body.data.entries.length).toBe(10);
  });

  it('total always reflects the full log size regardless of limit/offset', async () => {
    const res = await authed(request(app).get('/api/audit?limit=5&offset=0')).expect(200);
    expect(res.body.data.total).toBe(25);
  });

  it('offset skips the correct number of entries', async () => {
    const page1 = await authed(request(app).get('/api/audit?limit=5&offset=0')).expect(200);
    const page2 = await authed(request(app).get('/api/audit?limit=5&offset=5')).expect(200);
    const p1Ids = page1.body.data.entries.map((e: { resourceId: string }) => e.resourceId);
    const p2Ids = page2.body.data.entries.map((e: { resourceId: string }) => e.resourceId);
    // No overlap between pages
    const overlap = p1Ids.filter((id: string) => p2Ids.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('returns an empty entries array when offset exceeds total', async () => {
    const res = await authed(request(app).get('/api/audit?limit=10&offset=100')).expect(200);
    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.total).toBe(25);
  });

  it('uses default limit=20 when limit param is absent', async () => {
    const res = await authed(request(app).get('/api/audit')).expect(200);
    expect(res.body.data.entries.length).toBe(20);
  });

  it('returns remaining entries on final page when count < limit', async () => {
    const res = await authed(request(app).get('/api/audit?limit=20&offset=20')).expect(200);
    expect(res.body.data.entries.length).toBe(5);
  });
});

describe('GET /api/audit — sensitive field redaction', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    _resetAuditLog();
    app = makeApp();
  });

  it('does not expose authToken values in audit entry meta', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1', undefined, {
      authToken: 'super-secret-token-value',
      depositAmount: '100',
    });
    const res = await authed(request(app).get('/api/audit')).expect(200);
    const meta = res.body.data.entries[0].meta as Record<string, unknown>;
    expect(meta['authToken']).toBe('[REDACTED]');
    expect(meta['depositAmount']).toBe('100');
  });

  it('does not expose authorization values in audit entry meta', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's2', undefined, {
      authorization: 'Bearer eyJhbGci...',
      sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
    });
    const res = await authed(request(app).get('/api/audit')).expect(200);
    const meta = res.body.data.entries[0].meta as Record<string, unknown>;
    expect(meta['authorization']).toBe('[REDACTED]');
    expect(meta['sender']).toBeDefined();
  });

  it('does not expose x-api-key values in audit entry meta', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's3', undefined, {
      'x-api-key': 'my-api-key-1234',
      resourceType: 'stream',
    });
    const res = await authed(request(app).get('/api/audit')).expect(200);
    const meta = res.body.data.entries[0].meta as Record<string, unknown>;
    expect(meta['x-api-key']).toBe('[REDACTED]');
  });

  it('redacts RESTRICTED fields regardless of case in key name', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's4', undefined, {
      AuthToken: 'secret-value',
      AUTHORIZATION: 'Bearer token',
    });
    const res = await authed(request(app).get('/api/audit')).expect(200);
    const meta = res.body.data.entries[0].meta as Record<string, unknown>;
    expect(meta['AuthToken']).toBe('[REDACTED]');
    expect(meta['AUTHORIZATION']).toBe('[REDACTED]');
  });

  it('preserves all non-restricted meta fields intact', async () => {
    recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system', undefined, {
      streamCreation: true,
      ingestion: false,
      previous: { streamCreation: false, ingestion: false },
    });
    const res = await authed(request(app).get('/api/audit')).expect(200);
    const meta = res.body.data.entries[0].meta as Record<string, unknown>;
    expect(meta['streamCreation']).toBe(true);
    expect(meta['ingestion']).toBe(false);
    expect(meta['previous']).toEqual({ streamCreation: false, ingestion: false });
  });

  it('returns no RESTRICTED field values across multiple entries', async () => {
    const restrictedKeys = ['authToken', 'authorization', 'x-api-key'];
    // Seed entries — some with restricted fields, some without
    recordAuditEvent('STREAM_CREATED', 'stream', 'a', undefined, { authToken: 'tok1' });
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'b', undefined, { 'x-api-key': 'key1' });
    recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system', undefined, {
      streamCreation: true,
    });

    const res = await authed(request(app).get('/api/audit')).expect(200);
    const entries = res.body.data.entries as Array<{ meta?: Record<string, unknown> }>;

    for (const entry of entries) {
      if (!entry.meta) continue;
      for (const key of restrictedKeys) {
        if (Object.prototype.hasOwnProperty.call(entry.meta, key)) {
          expect(entry.meta[key]).toBe('[REDACTED]');
        }
      }
    }
  });
});
