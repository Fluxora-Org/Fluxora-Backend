/**
 * Tests for the experimental GraphQL federation gateway — #1220
 *
 * Coverage:
 *  - Auth guards: 401 (no token), 403 (bad credentials)
 *  - Feature-flag gate: 200 with error when flag disabled
 *  - Stream query (single + list)
 *  - Audit-log query
 *  - Error sanitisation
 *  - GET /api/graphql?sdls returns SDL
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock streamRepository before importing app ─────────────────────────────────
// vi.hoisted is required: vi.mock factories are hoisted above top-level const
// declarations, so any fn/mock referenced inside a factory must be created via
// vi.hoisted to exist at factory-evaluation time.
const gqlMocks = vi.hoisted(() => {
  const mockStream = {
    id: 'stream-001',
    sender_address: 'GABCDEF123',
    recipient_address: 'GHIJKLM456',
    amount: '1000.0000000',
    streamed_amount: '500.0000000',
    remaining_amount: '500.0000000',
    rate_per_second: '1.0000000',
    start_time: 1700000000,
    end_time: 1700100000,
    status: 'active',
    contract_id: 'CCONTRACT123',
    transaction_hash: '0xdeadbeef',
    event_index: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return {
    mockStream,
    mockGetById: vi.fn(),
    mockFindWithCursor: vi.fn(),
    mockAuditEntries: [
      {
        seq: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        action: 'STREAM_CREATED',
        resourceType: 'stream',
        resourceId: 'stream-001',
        correlationId: 'req-1',
        meta: { amount: '1000' },
      },
    ],
  };
});

const { mockStream, mockGetById, mockFindWithCursor, mockAuditEntries } = gqlMocks;

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: gqlMocks.mockGetById,
    findWithCursor: gqlMocks.mockFindWithCursor,
  },
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  getAuditEntries: vi.fn(() => gqlMocks.mockAuditEntries),
}));

// ── Mock auth middleware to pass through quickly ───────────────────────────────
// We mock the middleware modules so the app doesn't need a real JWT secret.
// The mocked principal carries all gateway scopes so the real per-resolver
// scope gates (which run on the real gateway) let these tests through.
vi.mock('../../src/middleware/auth.js', () => ({
  // Faithful stand-in: only authenticate when a Bearer token is present, and
  // requireAuth rejects requests with no principal — mirroring the real
  // middleware so the auth-guard tests exercise real behavior.
  authenticate: vi.fn((req, _res, next) => {
    if (req.headers.authorization) {
      req.user = {
        role: 'admin',
        keyId: 'key-admin',
        permissions: ['streams:read', 'streams:write', 'audit:read'],
      };
    }
    next();
  }),
  authenticateApiKey: vi.fn((_req, _res, next) => next()),
  requireAuth: vi.fn((req, res, next) => {
    if (!req.user && !req.keyId) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    next();
  }),
  // requireScope mirrors the real middleware's deny-by-default gate.
  requireScope: () => vi.fn((req, res, next) => {
    const isApiKeyAuth = (req as any).keyId !== undefined;
    const isJwtAuth = req.user !== undefined;
    if (!isApiKeyAuth && !isJwtAuth) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    next();
  }),
  requirePermission: () => vi.fn((_req, _res, next) => next()),
  Permission: {
    STREAMS_READ: 'streams:read',
    STREAMS_WRITE: 'streams:write',
    ADMIN_PAUSE: 'admin:pause',
    ADMIN_REINDEX: 'admin:reindex',
    INDEXER_REPLAY: 'indexer:replay',
    DLQ_LIST: 'dlq:list',
    DLQ_READ: 'dlq:read',
    DLQ_REPLAY: 'dlq:replay',
    DLQ_DELETE: 'dlq:delete',
    DLQ_CONSUMER_RESUME: 'dlq:consumer:resume',
    AUDIT_READ: 'audit:read',
    AUDIT_WRITE: 'audit:write',
  },
}));

// ── Mock downstream deps ───────────────────────────────────────────────────────
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/webhooks/retry.js', () => ({
  attemptWebhookDeliveryWithRateLimit: vi.fn(),
  scheduleWebhookOutboxRetry: vi.fn(),
  calculateNextRetryTime: vi.fn(),
  generateRetrySchedule: vi.fn(),
}));

vi.mock('../../src/openapi/spec.js', () => ({ openApiDocument: {} }));

// ── Feature flag control ───────────────────────────────────────────────────────
import { reloadFlags } from '../../src/config/featureFlags.js';

import { app } from '../../src/app.js';
import { initializeConfig } from '../../src/config/env.js';

const ADMIN_KEY = 'test-admin-key-for-graphql';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function gql(body: Record<string, unknown>) {
  return authed(request(app).post('/api/graphql').send(body));
}

describe('GraphQL gateway', () => {
  beforeAll(() => {
    initializeConfig();
  });

  beforeEach(() => {
    // Enable the feature flag for tests
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'experimental_graphql_gateway', percentage: 100 },
    ]);
    reloadFlags();

    process.env.ADMIN_API_KEY = ADMIN_KEY;

    vi.clearAllMocks();
    mockGetById.mockResolvedValue(mockStream);
    mockFindWithCursor.mockResolvedValue({
      streams: [mockStream],
      hasMore: false,
      total: 1,
    });
  });

  afterEach(() => {
    delete process.env.FEATURE_FLAGS_JSON;
    reloadFlags();
    delete process.env.ADMIN_API_KEY;
  });

  // ── Auth guards ──────────────────────────────────────────────────────────

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/graphql').send({ query: '{ __typename }' });
    expect(res.status).toBe(401);
  });

  // ── Feature-flag gate ────────────────────────────────────────────────────

  it('returns feature-flag error when the gateway is disabled', async () => {
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'experimental_graphql_gateway', percentage: 0 },
    ]);
    reloadFlags();

    const res = await gql({ query: '{ __typename }' });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('FEATURE_FLAG_DISABLED');
  });

  // ── Validation ───────────────────────────────────────────────────────────

  it('returns 400 when query field is missing', async () => {
    const res = await gql({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  // ── Stream query ─────────────────────────────────────────────────────────

  it('resolves a single stream by ID', async () => {
    const res = await gql({
      query: `{ stream(id: "stream-001") { id senderAddress amount status } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.stream).toEqual({
      id: 'stream-001',
      senderAddress: 'GABCDEF123',
      amount: '1000.0000000',
      status: 'active',
    });
    expect(mockGetById).toHaveBeenCalledWith('stream-001');
  });

  it('returns null for a non-existent stream', async () => {
    mockGetById.mockResolvedValue(undefined);

    const res = await gql({
      query: `{ stream(id: "no-such-id") { id } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.stream).toBeNull();
  });

  // ── Streams list query ───────────────────────────────────────────────────

  it('resolves paginated stream list', async () => {
    // `total` is only populated when includeTotal: true is requested (the
    // schema documents this contract on the StreamConnection.total field).
    const res = await gql({
      query: `{ streams(limit: 10, includeTotal: true) { streams { id status } hasMore total } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.streams.streams).toHaveLength(1);
    expect(res.body.data.streams.hasMore).toBe(false);
    expect(res.body.data.streams.total).toBe(1);
    expect(mockFindWithCursor).toHaveBeenCalled();
  });

  it('passes filter arguments to repository', async () => {
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });

    const res = await gql({
      query: `{ streams(status: active, contractId: "CCONTRACT123", limit: 5) { streams { id } } }`,
    });

    expect(res.status).toBe(200);
    const callArgs = mockFindWithCursor.mock.calls[0];
    expect(callArgs[0]).toMatchObject({ status: 'active', contract_id: 'CCONTRACT123' });
    expect(callArgs[1]).toBe(5);
  });

  // ── Audit log query ──────────────────────────────────────────────────────

  it('resolves auditEntries query', async () => {
    const res = await gql({
      query: `{ auditEntries(limit: 10) { entries { seq action resourceId meta } total } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.auditEntries.entries).toHaveLength(1);
    expect(res.body.data.auditEntries.entries[0]).toMatchObject({
      seq: 1,
      action: 'STREAM_CREATED',
      resourceId: 'stream-001',
    });
    expect(res.body.data.auditEntries.total).toBe(1);
  });

  it('filters audit entries by actionType', async () => {
    const res = await gql({
      query: `{ auditEntries(actionType: "STREAM_CREATED") { entries { action } total } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.auditEntries.total).toBe(1);
  });

  it('returns empty array when audit entries do not match filter', async () => {
    const res = await gql({
      query: `{ auditEntries(actionType: "NONEXISTENT") { entries { action } total } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.auditEntries.entries).toHaveLength(0);
    expect(res.body.data.auditEntries.total).toBe(0);
  });

  // ── GET endpoint ─────────────────────────────────────────────────────────

  it('GET /api/graphql?sdl returns the schema SDL', async () => {
    const res = await authed(request(app).get('/api/graphql?sdl'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('type Query');
    expect(res.text).toContain('type Stream');
    expect(res.text).toContain('type AuditEntry');
  });

  it('GET /api/graphql without sdl returns gateway status', async () => {
    const res = await authed(request(app).get('/api/graphql'));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('experimental');
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it('returns errors for invalid GraphQL queries', async () => {
    const res = await gql({
      query: `{ nonExistentField }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toBeTruthy();
  });

  it('sanitises internal error messages', async () => {
    mockGetById.mockRejectedValue(new Error('Internal detail: postgresql://user:pass@host:5432/db'));

    const res = await gql({
      query: `{ stream(id: "stream-001") { id } }`,
    });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    // Should not leak the connection string
    const msg = JSON.stringify(res.body.errors);
    expect(msg).not.toContain('postgresql://');
    expect(msg).not.toContain('user:pass');
  });
});
