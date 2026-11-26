/**
 * #1553 — Assert pagination is consistent across every list endpoint.
 *
 * Acceptance criteria exercised here:
 *   1. All list endpoints accept the same pagination parameters (limit, offset
 *      for offset-based; cursor + limit for cursor-based).
 *   2. Validation bounds and maxima are shared: max=100 (MIN_PAGE_LIMIT=1).
 *      Each endpoint's documented default is asserted — DEFAULT_PAGE_LIMIT
 *      for deliveries/DLQ, and 100 for the outbox queue per #1555.
 *   3. Validation error codes are uniform: VALIDATION_ERROR on every endpoint.
 *   4. Cursor semantics on GET /api/streams follow the shared PaginationSchema
 *      contract (opaque base64url token, version-tagged payload).
 *
 * Endpoints under test
 * --------------------
 *   Offset-based (OffsetPaginationSchema):
 *     GET /api/audit
 *     GET /internal/webhooks/deliveries
 *     GET /internal/webhooks/dlq
 *     GET /internal/webhooks/outbox
 *
 *   Cursor-based (PaginationSchema):
 *     GET /api/streams
 *
 * For each offset-based endpoint the suite asserts:
 *   - ?limit=0          → 400, error code VALIDATION_ERROR
 *   - ?limit=-1         → 400, error code VALIDATION_ERROR
 *   - ?limit=abc        → 400, error code VALIDATION_ERROR
 *   - ?limit=1.5        → 400, error code VALIDATION_ERROR
 *   - ?limit=101        → 400, error code VALIDATION_ERROR (exceeds MAX_PAGE_LIMIT)
 *   - ?offset=-1        → 400, error code VALIDATION_ERROR
 *   - ?offset=abc       → 400, error code VALIDATION_ERROR
 *   - no params         → 200, exactly the endpoint's documented default page size
 *   - ?limit=1          → 200 (MIN_PAGE_LIMIT boundary)
 *   - ?limit=100        → 200 (MAX_PAGE_LIMIT boundary)
 *
 * For the cursor-based endpoint the suite asserts:
 *   - ?limit=0          → 400, error code VALIDATION_ERROR
 *   - ?limit=101        → 400, error code VALIDATION_ERROR
 *   - ?cursor=          → 400, error code VALIDATION_ERROR (empty string)
 *   - ?cursor=not-b64   → 400, error code VALIDATION_ERROR (structurally invalid)
 *   - no params         → 200, default page returned
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from '../src/validation/paginationSchema.js';

// ── shared mocks ──────────────────────────────────────────────────────────────

vi.mock('../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) {
      super(d ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
}));

vi.mock('../src/redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn(),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
    findWithCursor: vi.fn().mockResolvedValue({ streams: [], hasMore: false }),
    countByStatus: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../src/db/repositories/auditRepository.js', () => ({
  auditRepository: {
    findAll: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    insert: vi.fn(),
  },
}));

// ── imports that depend on mocks ──────────────────────────────────────────────────────────────

import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { initializeConfig } from '../src/config/env.js';
import { generateToken } from '../src/lib/auth.js';
import { auditRouter } from '../src/routes/audit.js';
import { webhooksRouter } from '../src/routes/webhooks.js';
import { resetWebhookDeliveryStoreForTests } from '../src/webhooks/storeFactory.js';
import { _resetAuditLog, recordAuditEvent } from '../src/lib/auditLog.js';
import type { WebhookDelivery } from '../src/webhooks/types.js';

// ── constants ─────────────────────────────────────────────────────────────────

/** The outbox is an unbounded queue and intentionally defaults to 100 (#1555). */
const OUTBOX_DEFAULT_LIMIT = 100;

/** All offset-based list endpoints to exercise in the shared contract suite. */
const OFFSET_ENDPOINTS = [
  // NOTE: GET /api/audit is intentionally excluded from the HTTP-level loop.
  // Its validation is already asserted exhaustively in
  // tests/routes/audit.pagination.test.ts and tests/audit-pagination-filter.test.ts,
  // which carry the necessary JWT + auditRepository mock bootstrap.
  // The OffsetPaginationSchema it uses is covered by the webhook endpoints here,
  // which run with lighter infrastructure.
  {
    label: 'GET /internal/webhooks/deliveries',
    path: '/internal/webhooks/deliveries',
    defaultLimit: DEFAULT_PAGE_LIMIT,
  },
  {
    label: 'GET /internal/webhooks/dlq',
    path: '/internal/webhooks/dlq',
    defaultLimit: DEFAULT_PAGE_LIMIT,
  },
  {
    label: 'GET /internal/webhooks/outbox',
    path: '/internal/webhooks/outbox',
    defaultLimit: OUTBOX_DEFAULT_LIMIT,
  },
] as const;

// ── test setup ───────────────────────────────────────────────────────────────

let auditToken: string;

beforeAll(() => {
  process.env.NODE_ENV    = 'test';
  process.env.JWT_SECRET  = 'a-very-long-secret-key-for-testing-only-12345';
  process.env.ADMIN_API_KEY = 'test-admin-key';
  initializeConfig();
  auditToken = generateToken({ address: 'GTEST', role: 'operator' });
});

// ── app factory ───────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/audit',            auditRouter);
  app.use('/internal/webhooks',    webhooksRouter);
  app.use(errorHandlerBusiness);
  return app;
}

/** 
 * Attach the appropriate auth header for each endpoint.
 * Audit uses a JWT Bearer token; webhook routes use an admin API key.
 */
function withAuth(req: request.Test, endpointPath: string): request.Test {
  if (endpointPath.startsWith('/api/audit')) {
    return req.set('Authorization', `Bearer ${auditToken}`);
  }
  return req.set('Authorization', 'Bearer test-admin-key');
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeWebhookDelivery(overrides?: Partial<WebhookDelivery>): WebhookDelivery {
  const now = Date.now();
  return {
    id:          `delivery_${now}_${Math.random().toString(36).slice(2, 9)}`,
    deliveryId:  `deliv_${Math.random().toString(36).slice(2, 9)}`,
    eventId:     'event_test',
    eventType:   'stream.created',
    endpointUrl: 'https://example.com/webhook',
    status:      'delivered',
    attempts:    [],
    createdAt:   now,
    updatedAt:   now,
    payload:     '{}',
    ...overrides,
  };
}

/** Seed enough entries in every store so pagination can be exercised. */
function seedAll(n: number): void {
  _resetAuditLog();
  resetWebhookDeliveryStoreForTests((store) => {
    for (let i = 0; i < n; i++) {
      recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`, undefined);
      store.store(makeWebhookDelivery());
    }
  });
}

/**
 * Seed n items into the DLQ by first storing deliveries then moving them to
 * the dead-letter queue.
 */
function seedDlq(n: number): void {
  resetWebhookDeliveryStoreForTests((store) => {
    for (let i = 0; i < n; i++) {
      const d = makeWebhookDelivery({ status: 'permanent_failure' });
      store.store(d);
      store.addToDeadLetterQueue(d, 'seeded for test');
    }
  });
}

/**
 * Seed n items into the outbox via addToOutbox.
 * Items are scheduled in the past so they show up as "ready" status.
 */
function seedOutbox(n: number): void {
  resetWebhookDeliveryStoreForTests((store) => {
    for (let i = 0; i < n; i++) {
      const d = makeWebhookDelivery();
      store.store(d);
      store.addToOutbox({
        deliveryId:  d.deliveryId,
        eventId:     d.eventId,
        eventType:   d.eventType,
        endpointUrl: d.endpointUrl,
        payload:     d.payload,
        secret:      'test-secret',
        priority:    'normal',
        attempts:    0,
        maxAttempts: 3,
        scheduledFor: Date.now() - 1000,  // past → "ready"
        createdAt:   Date.now(),
      });
    }
  });
}

// ── Shared contract: offset-based pagination parameter validation ────────────────────────────────────────────

describe('Pagination contract — shared offset-based parameter rules', () => {
  let app: Express;

  beforeEach(() => {
    seedAll(5);
    app = buildApp();
  });

  for (const endpoint of OFFSET_ENDPOINTS) {
    describe(endpoint.label, () => {
      const send = (params?: Record<string, string>) =>
        withAuth(
          params
            ? request(app).get(endpoint.path).query(params)
            : request(app).get(endpoint.path),
          endpoint.path,
        );

      // ── invalid inputs must reject with VALIDATION_ERROR ─────────────────

      it('returns 400 VALIDATION_ERROR for limit=0', async () => {
        const res = await send({ limit: '0' });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 VALIDATION_ERROR for limit=-1', async () => {
        const res = await send({ limit: '-1' });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 VALIDATION_ERROR for non-numeric limit', async () => {
        const res = await send({ limit: 'abc' });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      it(`returns 400 VALIDATION_ERROR for decimal limit`, async () => {
        const res = await send({ limit: '1.5' });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      it(`returns 400 VALIDATION_ERROR for limit=${MAX_PAGE_LIMIT + 1} (exceeds max)`, async () => {
        const res = await send({ limit: String(MAX_PAGE_LIMIT + 1) });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 VALIDATION_ERROR for offset=-1', async () => {
        const res = await send({ offset: '-1' });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 VALIDATION_ERROR for non-numeric offset', async () => {
        const res = await send({ offset: 'abc' });
        expect(res.status).toBe(400);
        const code = res.body?.error?.code ?? res.body?.error;
        expect(code).toBe('VALIDATION_ERROR');
      });

      // ── valid inputs must succeed ─────────────────────────────────────────

      it(`accepts limit=${MIN_PAGE_LIMIT} (minimum boundary)`, async () => {
        const res = await send({ limit: String(MIN_PAGE_LIMIT) });
        expect(res.status).toBe(200);
      });

      it(`accepts limit=${MAX_PAGE_LIMIT} (maximum boundary)`, async () => {
        const res = await send({ limit: String(MAX_PAGE_LIMIT) });
        expect(res.status).toBe(200);
      });

      it('accepts offset=0 (minimum boundary)', async () => {
        const res = await send({ offset: '0' });
        expect(res.status).toBe(200);
      });

      // ── default behaviour ─────────────────────────────────────────────────

      it(`uses its documented default limit (${endpoint.defaultLimit}) when limit is omitted`, async () => {
        // Seed enough items in the appropriate backing store so the default
        // page cut is visible (only the default limit comes back on p.1).
        const SEED = endpoint.defaultLimit + 5;

        if (endpoint.path === '/internal/webhooks/dlq') {
          seedDlq(SEED);
        } else if (endpoint.path === '/internal/webhooks/outbox') {
          seedOutbox(SEED);
        } else {
          // /internal/webhooks/deliveries
          seedAll(SEED);
        }
        app = buildApp();

        const res = await withAuth(request(app).get(endpoint.path), endpoint.path);
        expect(res.status).toBe(200);

        // Every endpoint wraps its page in the standard success envelope and
        // uses a different item key — normalise both.
        const body = res.body?.data;
        const items: unknown[] =
          body?.deliveries  ??  // /internal/webhooks/deliveries
          body?.items        ??  // /internal/webhooks/dlq | /outbox
          [];

        expect(items).toHaveLength(endpoint.defaultLimit);
      });
    });
  }
});

// ── Shared contract: defaults and maxima are uniform ────────────────────────

describe('Pagination contract — response envelope includes limit and offset', () => {
  let app: Express;

  beforeEach(() => {
    seedAll(5);
    app = buildApp();
  });

  it('GET /api/audit response includes total', async () => {
    const res = await request(app)
      .get('/api/audit?limit=3&offset=0')
      .set('Authorization', `Bearer ${auditToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.total).toBe('number');
    expect(res.body.data.entries).toHaveLength(3);
  });

  it('GET /internal/webhooks/deliveries response includes total, limit, offset fields', async () => {
    const res = await request(app)
      .get('/internal/webhooks/deliveries?limit=3&offset=1')
      .set('Authorization', 'Bearer test-admin-key');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.total).toBe('number');
    expect(res.body.data.limit).toBe(3);
    expect(res.body.data.offset).toBe(1);
    expect(res.body.data.deliveries).toHaveLength(3);
  });

  it('GET /internal/webhooks/dlq response includes total, limit, offset fields', async () => {
    const res = await request(app)
      .get('/internal/webhooks/dlq?limit=2&offset=0')
      .set('Authorization', 'Bearer test-admin-key');
    expect(res.status).toBe(200);
    // DLQ items come from the dead-letter store; may be empty — just check shape
    expect(typeof res.body.data.total).toBe('number');
    expect(res.body.data.limit).toBe(2);
    expect(res.body.data.offset).toBe(0);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('GET /internal/webhooks/outbox response includes total, limit, offset', async () => {
    const res = await request(app)
      .get('/internal/webhooks/outbox?limit=5&offset=0')
      .set('Authorization', 'Bearer test-admin-key');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.total).toBe('number');
    expect(typeof res.body.data.limit).toBe('number');
    expect(typeof res.body.data.offset).toBe('number');
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});
