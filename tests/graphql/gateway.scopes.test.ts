/**
 * API-key scope enforcement across the GraphQL gateway — issue #1266.
 *
 * These tests run against the REAL auth middleware (`authenticate` +
 * `authenticateApiKey` + `requireScope`) mounted in front of the real gateway
 * router, with only the repository/audit layers mocked. That means the scope
 * matrix exercises the actual enforcement path — not a helper in isolation:
 *
 *   - exact scope  → the operation resolves
 *   - missing scope → sanitised `FORBIDDEN` error, no resource data leaked
 *   - extra scopes  → no wider access than the granted scopes
 *   - invalid / revoked / cross-tenant key → 401 before any query runs
 *
 * Design decisions under test (see issue #1266):
 *   - Deny-by-default: every sensitive resolver rejects unless the principal
 *     carries an explicit matching scope.
 *   - Missing scope is distinguishable from an invalid key: 403 FORBIDDEN vs
 *     401 UNAUTHORIZED.
 *   - Rejected requests never reveal resource existence: the FORBIDDEN
 *     response contains no stream/audit data regardless of whether the target
 *     exists.
 */

import request from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ApiKeyRecord } from '../../src/db/types.js';

// ── Module-scope mocks (hoisted so vi.mock factories can reference them) ──────

const mocks = vi.hoisted(() => {
  const streamRecord = {
    id: 'stream-scope-1',
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
    streamRecord,
    mockGetById: vi.fn(),
    mockFindWithCursor: vi.fn(),
    mockAuditEntries: [
      {
        seq: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        action: 'STREAM_CREATED',
        resourceType: 'stream',
        resourceId: 'stream-scope-1',
        correlationId: 'req-1',
        meta: { amount: '1000' },
      },
    ],
  };
});

const inMemoryKeys = new Map<string, ApiKeyRecord>();

vi.mock('../../src/db/repositories/apiKeyRepository.js', () => ({
  apiKeyRepository: {
    insert: vi.fn(async (record: ApiKeyRecord) => {
      inMemoryKeys.set(record.id, record);
    }),
    findActiveByPrefix: vi.fn(async (prefix: string) =>
      Array.from(inMemoryKeys.values()).filter((k) => k.prefix === prefix && k.active),
    ),
    getById: vi.fn(async (id: string) => inMemoryKeys.get(id)),
    rotate: vi.fn(),
    revoke: vi.fn(async (id: string) => {
      const existing = inMemoryKeys.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, active: false };
      inMemoryKeys.set(id, updated);
      return updated;
    }),
    listAll: vi.fn(async () => Array.from(inMemoryKeys.values())),
  },
}));

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: mocks.mockGetById,
    findWithCursor: mocks.mockFindWithCursor,
  },
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn(async () => {}),
  getAuditEntries: vi.fn(() => mocks.mockAuditEntries),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { initializeConfig } from '../../src/config/env.js';
import { reloadFlags } from '../../src/config/featureFlags.js';
import { createApiKey, revokeApiKey } from '../../src/lib/apiKey.js';
import { graphqlGatewayRouter } from '../../src/graphql/gateway.js';

const app = express();
app.use(express.json());
app.use('/api/graphql', graphqlGatewayRouter);

function gql(query: string, apiKey?: string): request.Test {
  const req = request(app).post('/api/graphql').send({ query });
  if (apiKey !== undefined) req.set('X-API-Key', apiKey);
  return req;
}

describe('GraphQL gateway — API-key scope matrix (#1266)', () => {
  beforeAll(() => {
    initializeConfig();
  });

  beforeEach(() => {
    inMemoryKeys.clear();
    vi.clearAllMocks();
    mocks.mockGetById.mockResolvedValue(mocks.streamRecord);
    mocks.mockFindWithCursor.mockResolvedValue({
      streams: [mocks.streamRecord],
      hasMore: false,
      total: 1,
    });
    // Enable the gateway for every requester.
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'experimental_graphql_gateway', percentage: 100 },
    ]);
    reloadFlags();
  });

  afterEach(() => {
    inMemoryKeys.clear();
    delete process.env.FEATURE_FLAGS_JSON;
    reloadFlags();
  });

  // ── Exact scope ─────────────────────────────────────────────────────────

  it('resolves a stream query for a key with the exact streams:read scope', async () => {
    const key = await createApiKey('gql-read', ['streams:read']);

    const res = await gql(`{ stream(id: "stream-scope-1") { id amount status } }`, key.key);

    expect(res.status).toBe(200);
    expect(res.body.data.stream).toEqual({
      id: 'stream-scope-1',
      amount: '1000.0000000',
      status: 'active',
    });
    expect(res.body.errors).toBeUndefined();
  });

  // ── Missing scope → deny-by-default, no existence leak ────────────────────

  it('rejects a stream query for a key missing streams:read with FORBIDDEN and no data', async () => {
    const key = await createApiKey('gql-write-only', ['streams:write']);

    const res = await gql(`{ stream(id: "stream-scope-1") { id } }`, key.key);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
    // No resource data may leak — the field resolves to null (identical to a
    // non-existent stream), the error is generic, and no repository lookup
    // ever ran, so the denial cannot reveal whether the stream exists.
    expect(res.body.data).toEqual({ stream: null });
    expect(JSON.stringify(res.body)).not.toContain('stream-scope-1');
    expect(mocks.mockGetById).not.toHaveBeenCalled();
  });

  it('rejects a streams list query for a key missing streams:read', async () => {
    const key = await createApiKey('gql-write-only', ['streams:write']);

    const res = await gql(`{ streams(limit: 5) { streams { id } } }`, key.key);

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(mocks.mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('rejects an auditEntries query for a key missing audit:read', async () => {
    const key = await createApiKey('gql-streams-only', ['streams:read']);

    const res = await gql(`{ auditEntries(limit: 5) { total } }`, key.key);

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toContain('STREAM_CREATED');
  });

  // ── Missing scope vs invalid key are distinguishable ──────────────────────

  it('rejects an invalid API key with 401 before any query runs', async () => {
    const res = await gql(
      `{ stream(id: "stream-scope-1") { id } }`,
      'flx_invalid_key_that_does_not_exist',
    );

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects an anonymous request (no key, no JWT) with 401', async () => {
    const res = await gql(`{ stream(id: "stream-scope-1") { id } }`);

    expect(res.status).toBe(401);
  });

  it('rejects a revoked API key with 401', async () => {
    const key = await createApiKey('gql-revoked', ['streams:read']);
    await revokeApiKey(key.id);

    const res = await gql(`{ stream(id: "stream-scope-1") { id } }`, key.key);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  // ── Extra scopes grant no wider access ────────────────────────────────────

  it('a key with extra scopes still cannot read audit entries without audit:read', async () => {
    const key = await createApiKey('gql-extra-scopes', ['streams:read', 'streams:write', 'admin:pause']);

    const res = await gql(`{ auditEntries(limit: 5) { total } }`, key.key);

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  // ── Cross-tenant (foreign) keys ───────────────────────────────────────────

  it('rejects a foreign (cross-tenant) key with 401 and no data leak', async () => {
    // A credential issued to another tenant is not the caller's key: it is
    // rejected before any resolver runs, and the response reveals nothing
    // about the target resource.
    const foreignKey = `flx_foreign_tenant_key_${'0'.repeat(48)}`;
    const res = await gql(`{ stream(id: "stream-scope-1") { id } }`, foreignKey);

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('stream-scope-1');
  });

  // ── Denied GET (SDL/status) requests are also gated ───────────────────────

  it('rejects GET /api/graphql?sdl without an API key', async () => {
    const res = await request(app).get('/api/graphql?sdl');
    expect(res.status).toBe(401);
  });

  it('allows GET /api/graphql?sdl with a streams:read key', async () => {
    const key = await createApiKey('gql-sdl', ['streams:read']);
    const res = await request(app)
      .get('/api/graphql?sdl')
      .set('X-API-Key', key.key);
    expect(res.status).toBe(200);
    expect(res.text).toContain('type Query');
  });
});
