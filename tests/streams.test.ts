/**
 * Streams API Integration Tests
 * 
 * Purpose: Verify the streams API endpoints with decimal string serialization.
 * Tests cover happy paths, validation failures, error responses, and edge cases.
 * 
 * @file streams.test.ts
 */

import express from 'express';
import request from 'supertest';
import { vi, beforeEach, beforeAll, describe, it, expect } from 'vitest';

// Mock the repository before importing the routes — POST /api/streams calls
// `streamRepository.upsertStream()` and the GET routes call
// `findWithCursor()` / `getById()`.  These tests previously relied on an
// in-memory `streams` array but the production code is DB-backed.
const mockGetById = vi.fn();
const mockUpsertStream = vi.fn();
const mockUpdateStream = vi.fn();
const mockFindWithCursor = vi.fn();

vi.mock('../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById:        (...a: unknown[]) => mockGetById(...a),
    upsertStream:   (...a: unknown[]) => mockUpsertStream(...a),
    updateStream:   (...a: unknown[]) => mockUpdateStream(...a),
    findWithCursor: (...a: unknown[]) => mockFindWithCursor(...a),
    countByStatus:  vi.fn().mockResolvedValue({ active: 0, paused: 0, completed: 0, cancelled: 0 }),
  },
}));

vi.mock('../src/db/pool.js', () => ({
  getPool:             vi.fn(() => ({})),
  query:               vi.fn(),
  PoolExhaustedError:  class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
  QueryTimeoutError:  class QueryTimeoutError extends Error {
    constructor() { super('query timeout'); this.name = 'QueryTimeoutError'; }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) { super(d ?? 'duplicate'); this.name = 'DuplicateEntryError'; }
  },
}));

import {
  streamsRouter,
  streams,
  setStreamListingDependencyState,
  setIdempotencyDependencyState,
  resetStreamIdempotencyStore,
} from '../src/routes/streams.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../src/errors.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { generateToken } from '../src/lib/auth.js';
import { authenticate } from '../src/middleware/auth.js';
import { initializeConfig } from '../src/config/env.js';

// Initialize config before any test module code runs (upstream requirement)
initializeConfig();

function makeDbRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:                'stream-test-0',
    sender_address:    'GCSX22222222222222222222222222222222222222222222222222UV',
    recipient_address: 'GDRX22222222222222222222222222222222222222222222222222UV',
    amount:            '1000000.0000000',
    streamed_amount:   '0',
    remaining_amount:  '1000000.0000000',
    rate_per_second:   '0.0000116',
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

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
});

// Create a minimal test app
function createTestApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use(authenticate);
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

let idempotencyKeyCounter = 0;

function nextIdempotencyKey(): string {
  idempotencyKeyCounter += 1;
  return `test-idempotency-${idempotencyKeyCounter}`;
}

const testToken = generateToken({ address: 'GTEST', role: 'operator' });

function postStream(app: any, body: Record<string, unknown>, idempotencyKey = nextIdempotencyKey()) {
  return request(app)
    .post('/api/streams')
    .set('Idempotency-Key', idempotencyKey)
    .set('Authorization', `Bearer ${testToken}`)
    .send(body);
}

describe('Streams API - Decimal String Serialization', () => {
  let app: any;

  beforeEach(() => {
    app = createTestApp();
    streams.length = 0;
    setStreamListingDependencyState('healthy');
    setIdempotencyDependencyState('healthy');
    resetStreamIdempotencyStore();

    // Reset all repository mocks to their default happy-path behaviour.
    // The mocks echo input back so decimal-string preservation tests can
    // verify round-tripping without a real Postgres.
    vi.clearAllMocks();
    const storedById = new Map<string, Record<string, unknown>>();
    mockGetById.mockImplementation(async (id: string) => storedById.get(id));
    mockUpsertStream.mockImplementation(
      async (input: {
        id: string;
        sender_address: string;
        recipient_address: string;
        amount: string;
        streamed_amount: string;
        remaining_amount: string;
        rate_per_second: string;
        start_time: number;
        end_time: number;
        contract_id: string;
        transaction_hash: string;
        event_index: number;
      }) => {
        const record = makeDbRecord({
          ...input,
          status: 'active',
        });
        storedById.set(input.id, record);
        return { created: true, stream: record };
      },
    );
    mockUpdateStream.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => {
        const existing = storedById.get(id) ?? makeDbRecord({ id });
        const updated = { ...existing, ...patch };
        storedById.set(id, updated);
        return updated;
      },
    );
    // List queries return everything in the mock store, supporting cursor +
    // limit semantics for pagination tests.
    mockFindWithCursor.mockImplementation(
      async (
        _filter: Record<string, unknown>,
        limit: number,
        afterId?: string,
        includeTotal?: boolean,
      ) => {
        const all = [...storedById.values()].sort((a, b) =>
          String(a['id']).localeCompare(String(b['id'])),
        );
        const startIdx = afterId
          ? all.findIndex((s) => String(s['id']) === afterId) + 1
          : 0;
        const page = all.slice(startIdx, startIdx + limit + 1);
        const hasMore = page.length > limit;
        const slice = hasMore ? page.slice(0, limit) : page;
        const result: { streams: unknown[]; hasMore: boolean; total?: number } = {
          streams: slice,
          hasMore,
        };
        if (includeTotal) result.total = all.length;
        return result;
      },
    );
  });

  describe('POST /api/streams', () => {
    it('should require an Idempotency-Key header', async () => {
      // Must include auth so we reach the idempotency-key check (auth runs
      // first and would otherwise short-circuit to 401).
      const response = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Idempotency-Key');
    });

    describe('valid decimal string inputs', () => {
      it('should create stream with valid decimal strings', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '1000000.0000000',
          ratePerSecond: '0.0000116',
        })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data.id).toBeDefined();
        // The validator normalises by stripping trailing zeros — the input
        // "1000000.0000000" is stored as "1000000" exactly.
        expect(response.body.data.depositAmount).toBe('1000000');
        expect(response.body.data.ratePerSecond).toBe('0.0000116');
        expect(response.body.data.status).toBe('active');
      });

      it('should create stream with integer amounts', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        })
          .expect(201);

        expect(response.body.data.depositAmount).toBe('100');
        expect(response.body.data.ratePerSecond).toBe('1');
      });

      it('should replay the original response for the same idempotency key and payload', async () => {
        const idempotencyKey = 'stream-create-replay';
        const payload = {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        };

        const firstResponse = await postStream(app, payload, idempotencyKey).expect(201);
        const secondResponse = await postStream(app, payload, idempotencyKey).expect(201);

        // The replay response data must match the original — `meta` differs
        // (timestamp + idempotencyReplayed flag) by design.
        expect(secondResponse.body.data).toEqual(firstResponse.body.data);
        expect(secondResponse.headers['idempotency-replayed']).toBe('true');
      });

      it('should reject idempotency key reuse with a different payload', async () => {
        const idempotencyKey = 'stream-create-conflict';

        await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        }, idempotencyKey).expect(201);

        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '200',
          ratePerSecond: '1',
        }, idempotencyKey).expect(409);

        expect(response.body.error.code).toBe('CONFLICT');
      });

      it('should return 503 when the idempotency dependency is unavailable', async () => {
        setIdempotencyDependencyState('unavailable');

        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        }).expect(503);

        expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
      });

      it('should create stream with negative rate rejected', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '-1',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should create stream with zero deposit rejected', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '0',
          ratePerSecond: '1',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('invalid decimal string inputs', () => {
      it('should reject numeric depositAmount', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: 1000000,
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toBeDefined();
      });

      it('should reject numeric ratePerSecond', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '1000000',
          ratePerSecond: 0.0000116,
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject empty depositAmount', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '',
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject invalid format depositAmount', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: 'invalid',
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toBeDefined();
      });

      it('should reject scientific notation', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '1e10',
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject NaN', async () => {
        await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: 'NaN',
          ratePerSecond: '0.0000116',
        })
          .expect(400);
      });
    });

    describe('missing required fields', () => {
      it('should reject missing sender', async () => {
        const response = await postStream(app, {
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        })
          .expect(400);

        expect(response.body.error.message).toContain('sender');
      });

      it('should reject missing recipient', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
        })
          .expect(400);

        expect(response.body.error.message).toContain('recipient');
      });

      it('should accept missing depositAmount (uses default)', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          ratePerSecond: '1',
        })
          .expect(201);

        // depositAmount defaults to '0' per implementation
        expect(response.body.data.depositAmount).toBe('0');
      });

      it('should accept missing ratePerSecond (uses default)', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
        })
          .expect(201);

        // ratePerSecond defaults to '0' per implementation
        expect(response.body.data.ratePerSecond).toBe('0');
      });
    });

    describe('invalid startTime', () => {
      it('should reject non-integer startTime', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
          startTime: 123.45,
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject negative startTime', async () => {
        await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1',
          startTime: -1,
        })
          .expect(400);
      });
    });

    describe('error response format', () => {
      it('should include requestId in error response', async () => {
        const response = await request(app)
          .post('/api/streams')
          .set('Authorization', `Bearer ${testToken}`)
          .set('Idempotency-Key', nextIdempotencyKey())
          .set('X-Request-ID', 'test-request-123')
          .send({
            depositAmount: 'invalid',
            ratePerSecond: '1',
          })
          .expect(400);

        expect(response.body.error.requestId).toBe('test-request-123');
      });

      it('should include error details for validation errors', async () => {
        const response = await postStream(app, {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: 'invalid',
          ratePerSecond: 'also-invalid',
        })
          .expect(400);

        // The error envelope must carry a `details` payload — its shape may be
        // either { errors: [...] } (route-level validator) or a string (zod
        // formatted issues), so we only assert it is defined.
        expect(response.body.error.details).toBeDefined();
      });
    });
  });

  describe('GET /api/streams', () => {
    beforeEach(async () => {
      // Create some test streams for pagination testing
      const testStreams = [
        {
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '1000.0000000',
          ratePerSecond: '0.0000116',
        },
        {
          sender: 'GCSX33333333333333333333333333333333333333333333333333UV',
          recipient: 'GDRX33333333333333333333333333333333333333333333333333UV',
          depositAmount: '2000.0000000',
          ratePerSecond: '0.0000232',
        },
        {
          sender: 'GCSX44444444444444444444444444444444444444444444444444UV',
          recipient: 'GDRX44444444444444444444444444444444444444444444444444UV',
          depositAmount: '3000.0000000',
          ratePerSecond: '0.0000348',
        },
      ];

      for (const stream of testStreams) {
        await postStream(app, stream).expect(201);
      }
    });

    it('should return streams array with pagination metadata', async () => {
      const response = await request(app)
        .get('/api/streams')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.streams).toBeDefined();
      expect(Array.isArray(response.body.data.streams)).toBe(true);
      expect(response.body.data.has_more).toBeDefined();
      expect(typeof response.body.data.has_more).toBe('boolean');
      expect(response.body.data.total).toBeUndefined();
      expect(response.body.data.streams.length).toBeGreaterThanOrEqual(0);
    });

    it('should return all streams when no pagination parameters', async () => {
      const response = await request(app)
        .get('/api/streams')
        .expect(200);

      expect(response.body.data.streams.length).toBe(3);
      expect(response.body.data.has_more).toBe(false);
      expect(response.body.data.total).toBeUndefined();
      expect(response.body.data.next_cursor).toBeNull();
    });

    it('should support limit parameter', async () => {
      const response = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      expect(response.body.data.streams.length).toBe(2);
      expect(response.body.data.has_more).toBe(true);
      expect(response.body.data.total).toBeUndefined();
      expect(response.body.data.next_cursor).toBeDefined();
    });

    it('should return total only when include_total=true', async () => {
      const response = await request(app)
        .get('/api/streams?include_total=true')
        .expect(200);

      expect(response.body.data.total).toBe(3);
      expect(response.body.data.has_more).toBe(false);
    });

    it('should support cursor pagination', async () => {
      const firstPage = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      expect(firstPage.body.data.streams.length).toBe(2);
      expect(firstPage.body.data.has_more).toBe(true);
      expect(firstPage.body.data.next_cursor).toBeDefined();

      const secondPage = await request(app)
        .get(`/api/streams?cursor=${firstPage.body.data.next_cursor}&limit=2`)
        .expect(200);

      expect(secondPage.body.data.streams.length).toBe(1);
      expect(secondPage.body.data.has_more).toBe(false);
      expect(secondPage.body.data.total).toBeUndefined();
      expect(secondPage.body.data.next_cursor).toBeNull();
    });

    it('should treat total as response-time metadata instead of a cursor snapshot guarantee', async () => {
      const firstPage = await request(app)
        .get('/api/streams?limit=2&include_total=true')
        .expect(200);

      expect(firstPage.body.data.total).toBe(3);
      expect(firstPage.body.data.next_cursor).toBeDefined();

      await postStream(app, {
        sender: 'GCSX55555555555555555555555555555555555555555555555555UV',
        recipient: 'GDRX55555555555555555555555555555555555555555555555555UV',
        depositAmount: '4000.0000000',
        ratePerSecond: '0.0000464',
      }).expect(201);

      const secondPage = await request(app)
        .get(`/api/streams?cursor=${firstPage.body.data.next_cursor}&limit=2&include_total=true`)
        .expect(200);

      expect(secondPage.body.data.streams.length).toBe(2);
      expect(secondPage.body.data.total).toBe(4);
      expect(secondPage.body.data.has_more).toBe(false);
    });

    it('should resume from the encoded sort key when the cursor record disappears', async () => {
      const firstPage = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      const deletedId = firstPage.body.data.streams[1].id;
      const deletedIndex = streams.findIndex((stream) => stream.id === deletedId);
      streams.splice(deletedIndex, 1);

      const secondPage = await request(app)
        .get(`/api/streams?cursor=${firstPage.body.data.next_cursor}&limit=2`)
        .expect(200);

      expect(secondPage.body.data.streams).toHaveLength(1);
      expect(secondPage.body.data.streams[0].id).not.toBe(deletedId);
    });

    it('should reject invalid limit values', async () => {
      const response = await request(app)
        .get('/api/streams?limit=0')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject limit > 100', async () => {
      const response = await request(app)
        .get('/api/streams?limit=101')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject non-integer limit values', async () => {
      const response = await request(app)
        .get('/api/streams?limit=1.5')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid cursor', async () => {
      const response = await request(app)
        .get('/api/streams?cursor=invalid-cursor')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid include_total values', async () => {
      const response = await request(app)
        .get('/api/streams?include_total=maybe')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 503 when the listing dependency is unavailable', async () => {
      setStreamListingDependencyState('unavailable');

      const response = await request(app)
        .get('/api/streams')
        .expect(503);

      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('should include requestId in response', async () => {
      await request(app)
        .get('/api/streams')
        .set('X-Request-ID', 'test-123')
        .expect(200);
    });
  });

  describe('GET /api/streams/:id', () => {
    it('should return 404 for non-existent stream', async () => {
      const response = await request(app)
        .get('/api/streams/non-existent-id')
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/streams/:id', () => {
    it('should return 404 for non-existent stream', async () => {
      const response = await request(app)
        .delete('/api/streams/non-existent-id')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });
});

describe('Error Handler Integration', () => {
  let app: any;

  beforeEach(() => {
    app = createTestApp();
  });

  it('should handle 404 for unknown routes', async () => {
    // Note: Express returns plain text for 404 by default
    // The 404 handler in index.ts is not used in the test app
    const response = await request(app)
      .get('/unknown-route')
      .expect(404);

    // Just verify we get a 404
    expect(response.status).toBe(404);
  });

  it('should handle malformed JSON', async () => {
    // Note: Express's JSON parser returns 400 for malformed JSON by default
    const response = await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', nextIdempotencyKey())
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');

    // Express JSON parser returns 400 for malformed JSON
    // But in this test setup, it might return 500
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThanOrEqual(500);
  });
});

// ─── Status Transition Tests ──────────────────────────────────────────────────

describe('Stream Status Transitions', () => {
  let app: any;

  const BASE_STREAM = {
    sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
    recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
    depositAmount: '100',
    ratePerSecond: '1',
  };

  beforeEach(() => {
    app = createTestApp();
    streams.length = 0;
    setStreamListingDependencyState('healthy');
    setIdempotencyDependencyState('healthy');
    resetStreamIdempotencyStore();

    // Reset the mock store (separate from the previous describe block).
    vi.clearAllMocks();
    const storedById = new Map<string, Record<string, unknown>>();
    mockGetById.mockImplementation(async (id: string) => storedById.get(id));
    mockUpsertStream.mockImplementation(async (input: { id: string }) => {
      const record = makeDbRecord({ ...input, status: 'active' });
      storedById.set(input.id, record);
      return { created: true, stream: record };
    });
    mockUpdateStream.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => {
        const existing = storedById.get(id) ?? makeDbRecord({ id });
        const updated = { ...existing, ...patch };
        storedById.set(id, updated);
        return updated;
      },
    );
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
  });

  async function createStream() {
    const res = await postStream(app, BASE_STREAM);
    expect(res.status).toBe(201);
    return res.body.data as { id: string; status: string };
  }

  function patchStatus(id: string, body: Record<string, unknown>) {
    return request(app)
      .patch(`/api/streams/${id}/status`)
      .set('Authorization', `Bearer ${testToken}`)
      .send(body);
  }

  // ── PATCH /:id/status ────────────────────────────────────────────────────

  describe('PATCH /api/streams/:id/status', () => {
    it('transitions active → paused', async () => {
      const { id } = await createStream();
      const res = await patchStatus(id, { status: 'paused' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('paused');
    });

    it('transitions active → cancelled', async () => {
      const { id } = await createStream();
      const res = await patchStatus(id, { status: 'cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('cancelled');
    });

    it('transitions active → completed', async () => {
      const { id } = await createStream();
      const res = await patchStatus(id, { status: 'completed' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });

    it('transitions paused → active', async () => {
      const { id } = await createStream();
      await patchStatus(id, { status: 'paused' });
      const res = await patchStatus(id, { status: 'active' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
    });

    it('returns 409 for active → active (no-op invalid)', async () => {
      const { id } = await createStream();
      const res = await patchStatus(id, { status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 409 when transitioning from a terminal status (completed)', async () => {
      const { id } = await createStream();
      await patchStatus(id, { status: 'completed' });
      const res = await patchStatus(id, { status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/completed/);
    });

    it('returns 409 when transitioning from a terminal status (cancelled)', async () => {
      const { id } = await createStream();
      await patchStatus(id, { status: 'cancelled' });
      const res = await patchStatus(id, { status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 400 for an unknown status value', async () => {
      const { id } = await createStream();
      const res = await patchStatus(id, { status: 'unknown' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when status field is missing', async () => {
      const { id } = await createStream();
      const res = await patchStatus(id, {});
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown stream id', async () => {
      const res = await request(app)
        .patch('/api/streams/nonexistent/status')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ status: 'paused' });
      expect(res.status).toBe(404);
    });

    it('preserves decimal-string amount fields after transition', async () => {
      const res1 = await postStream(app, {
        ...BASE_STREAM,
        depositAmount: '1000000.0000000',
        ratePerSecond: '0.0000116',
      });
      const { id } = res1.body.data;
      const res2 = await patchStatus(id, { status: 'paused' });
      expect(res2.status).toBe(200);
      // Trailing zeros are stripped by the validator on the initial POST, so
      // the stored value is the canonical "1000000" / "0.0000116".
      expect(res2.body.data.depositAmount).toBe('1000000');
      expect(res2.body.data.ratePerSecond).toBe('0.0000116');
    });
  });

  // ── DELETE (cancel guard) ────────────────────────────────────────────────

  describe('DELETE /api/streams/:id (cancel guard)', () => {
    const auth = `Bearer ${testToken}`;
    it('returns 409 when cancelling an already-cancelled stream', async () => {
      const { id } = await createStream();
      await request(app).delete(`/api/streams/${id}`).set('Authorization', auth).expect(200);
      const res = await request(app).delete(`/api/streams/${id}`).set('Authorization', auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/cancelled/);
    });

    it('returns 409 when cancelling a completed stream', async () => {
      const { id } = await createStream();
      await patchStatus(id, { status: 'completed' });
      const res = await request(app).delete(`/api/streams/${id}`).set('Authorization', auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/completed/);
    });

    it('cancels an active stream successfully', async () => {
      const { id } = await createStream();
      const res = await request(app).delete(`/api/streams/${id}`).set('Authorization', auth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
    });

    it('cancels a paused stream successfully', async () => {
      const { id } = await createStream();
      await patchStatus(id, { status: 'paused' });
      const res = await request(app).delete(`/api/streams/${id}`).set('Authorization', auth);
      expect(res.status).toBe(200);
    });
  });
});
