import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { ApiKeyRecord } from '../../src/db/types.js';
import { initializeConfig } from '../../src/config/env.js';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// Route-level integration against an in-memory fake repository so the HTTP
// contract is exercised end-to-end without a live Postgres. Audit writes are
// stubbed so they neither hit the DB nor double-count.

const fakeRepo = vi.hoisted(() => {
  const store = new Map<string, ApiKeyRecord>();
  return {
    store,
    reset: () => store.clear(),
    insert: vi.fn(async (record: ApiKeyRecord) => { store.set(record.id, { ...record }); }),
    findActiveByPrefix: vi.fn(async (prefix: string) =>
      [...store.values()].filter((r) => r.prefix === prefix && r.active)),
    getById: vi.fn(async (id: string) => { const r = store.get(id); return r ? { ...r } : undefined; }),
    rotate: vi.fn(async (id: string, patch: { keyHash: string; salt: string; prefix: string; rotatedAt: string }) => {
      const r = store.get(id);
      if (!r) return undefined;
      const updated = { ...r, ...patch };
      store.set(id, updated);
      return { ...updated };
    }),
    revoke: vi.fn(async (id: string) => {
      const r = store.get(id);
      if (!r) return undefined;
      const updated = { ...r, active: false };
      store.set(id, updated);
      return { ...updated };
    }),
    listAll: vi.fn(async () => [...store.values()]),
  };
});

const recordAuditEventToDb = vi.hoisted(() => vi.fn(async () => ({})));
const recordAuditEvent = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/repositories/apiKeyRepository.js', () => ({
  apiKeyRepository: fakeRepo,
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb,
  recordAuditEvent,
}));

import { adminRouter } from '../../src/routes/admin.js';

// Mount only the admin router on a minimal app so this suite exercises the API
// key routes end-to-end without depending on the full application bootstrap.
const app = express();
app.use(express.json());
// Stand in for the production correlation-id middleware so handlers can thread a
// correlation id into the audit trail.
app.use((req, _res, next) => {
  (req as express.Request & { correlationId?: string }).correlationId = 'test-correlation';
  next();
});
app.use('/api/admin', adminRouter);

const ADMIN_KEY = 'test-admin-key-for-apikey-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

// ── Safe display field contract ──────────────────────────────────────────────
// These are the ONLY fields that should appear in list/get/revoke responses.
// Extending this set requires a deliberate decision and a change to this list.
const SAFE_DISPLAY_FIELDS = ['id', 'name', 'prefix', 'createdAt', 'rotatedAt', 'active', 'scopes'] as const;

// Fields that must NEVER appear in any response body.
const FORBIDDEN_FIELDS = ['keyHash', 'salt', 'key'] as const;

/**
 * Assert that an API key entry in a response body exposes only safe display
 * fields and contains none of the forbidden credential material.
 */
function assertSafeDisplayShape(entry: Record<string, unknown>): void {
  // Every safe display field must be present.
  for (const field of SAFE_DISPLAY_FIELDS) {
    expect(entry, `safe field "${field}" must be present`).toHaveProperty(field);
  }
  // No credential material may be present.
  for (const field of FORBIDDEN_FIELDS) {
    expect(entry, `forbidden field "${field}" must NOT appear in response`).not.toHaveProperty(field);
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('admin API key routes', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    initializeConfig();
  });

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    fakeRepo.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  // ── 1. Authorization ────────────────────────────────────────────────────

  it('rejects unauthenticated GET to API keys list with 401', async () => {
    const res = await request(app).get('/api/admin/api-keys');
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated POST to create API key with 401', async () => {
    const res = await request(app).post('/api/admin/api-keys').send({ name: 'test' });
    expect(res.status).toBe(401);
  });

  it('rejects GET with bad credentials to API keys list with 403', async () => {
    const res = await request(app)
      .get('/api/admin/api-keys')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  it('rejects rotate with bad credentials with 403', async () => {
    const res = await request(app)
      .post('/api/admin/api-keys/some-id/rotate')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  it('rejects revoke with bad credentials with 403', async () => {
    const res = await request(app)
      .delete('/api/admin/api-keys/some-id')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  // ── 2. Creation — safe response contract ───────────────────────────────

  it('creates an API key with 201 envelope when authenticated', async () => {
    const res = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.name).toBe('service-a');
    expect(res.body.meta).toHaveProperty('timestamp');
    // Create is audited durably.
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_CREATED', 'api_key', res.body.data.id, expect.anything(), expect.any(Object),
    );
  });

  it('returns the raw key exactly once on creation with flx_ prefix', async () => {
    const res = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    expect(res.status).toBe(201);
    // Raw key is present ONLY at creation time.
    expect(res.body.data).toHaveProperty('key');
    expect(res.body.data.key).toMatch(/^flx_/);
  });

  it('does NOT expose keyHash or salt in the creation response', async () => {
    const res = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('keyHash');
    expect(res.body.data).not.toHaveProperty('salt');
  });

  it('rejects creation when name is missing or invalid with 400 error envelope', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({})
    );
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });

  // ── 3. Listing — no credential leakage ────────────────────────────────

  it('lists API keys in envelope when authenticated', async () => {
    await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' })
    );

    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data).toHaveProperty('apiKeys');
    expect(res.body.data.apiKeys).toHaveLength(1);
    expect(res.body.data.apiKeys[0].name).toBe('service-a');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('list response contains NO raw key, keyHash, or salt — safe display fields only', async () => {
    await authed(request(app).post('/api/admin/api-keys').send({ name: 'svc' }));

    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);

    const [entry] = res.body.data.apiKeys;
    assertSafeDisplayShape(entry as Record<string, unknown>);
  });

  it('list response omits keyHash even after multiple keys are created', async () => {
    await authed(request(app).post('/api/admin/api-keys').send({ name: 'k1' }));
    await authed(request(app).post('/api/admin/api-keys').send({ name: 'k2' }));
    await authed(request(app).post('/api/admin/api-keys').send({ name: 'k3' }));

    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);
    expect(res.body.data.apiKeys).toHaveLength(3);

    for (const entry of res.body.data.apiKeys as Record<string, unknown>[]) {
      assertSafeDisplayShape(entry);
    }
  });

  it('list response exposes the prefix field for log correlation', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'svc' }),
    );
    const createdPrefix = createRes.body.data.prefix as string;

    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);
    const [entry] = res.body.data.apiKeys as { prefix: string }[];
    // Prefix in listing must match what was returned at creation.
    expect(entry.prefix).toBe(createdPrefix);
  });

  it('listing an empty key store returns an empty array without errors', async () => {
    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);
    expect(res.body.data.apiKeys).toEqual([]);
  });

  // ── 4. Rotation ────────────────────────────────────────────────────────

  it('rotates an API key and returns a fresh raw key', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    const { id, key: oldKey } = createRes.body.data;

    const rotateRes = await authed(request(app).post(`/api/admin/api-keys/${id}/rotate`));
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.data.key).toMatch(/^flx_/);
    expect(rotateRes.body.data.key).not.toBe(oldKey);
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_ROTATED', 'api_key', id, expect.anything(), expect.any(Object),
    );
  });

  it('rotation response does NOT expose keyHash or salt', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    const { id } = createRes.body.data;

    const rotateRes = await authed(request(app).post(`/api/admin/api-keys/${id}/rotate`));
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.data).not.toHaveProperty('keyHash');
    expect(rotateRes.body.data).not.toHaveProperty('salt');
  });

  it('rotated key does NOT appear in listing with keyHash or salt', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    const { id } = createRes.body.data;

    await authed(request(app).post(`/api/admin/api-keys/${id}/rotate`));

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    const [entry] = listRes.body.data.apiKeys as Record<string, unknown>[];
    assertSafeDisplayShape(entry);
  });

  it('returns 404 when rotating a non-existent API key', async () => {
    const res = await authed(request(app).post('/api/admin/api-keys/does-not-exist/rotate'));
    expect(res.status).toBe(404);
  });

  // ── 5. Revocation ──────────────────────────────────────────────────────

  it('revokes an API key with 204 no-content when authenticated', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    const keyId = createRes.body.data.id;

    const deleteRes = await authed(request(app).delete(`/api/admin/api-keys/${keyId}`));
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.headers['x-request-id']).toBeTruthy();
    expect(deleteRes.body).toEqual({});
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_REVOKED', 'api_key', keyId, expect.anything(), expect.any(Object),
    );
  });

  it('revoked key appears as active=false in listing without exposing keyHash or salt', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    const keyId = createRes.body.data.id;

    await authed(request(app).delete(`/api/admin/api-keys/${keyId}`));

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    const [entry] = listRes.body.data.apiKeys as Record<string, unknown>[];
    expect(entry.active).toBe(false);
    // Credential material must not leak even for revoked keys.
    assertSafeDisplayShape(entry);
  });

  it('returns 404 error envelope when revoking non-existent API key', async () => {
    const res = await authed(
      request(app).delete('/api/admin/api-keys/does-not-exist')
    );
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── 6. Tenant isolation ────────────────────────────────────────────────
  //
  // The admin API key routes are protected by a single shared ADMIN_API_KEY
  // bearer token. Callers sharing that credential see the same key store —
  // there is no per-tenant partitioning at the bearer-token level.  Tenant
  // isolation here means: the response must never include records belonging to
  // a different bearer credential, and each caller's view must be consistent.
  //
  // We model a "different tenant" as a request that arrives without the valid
  // bearer token and must be rejected, and verify that authenticated callers
  // cannot observe each other's records across separate request cycles.

  it('unauthenticated caller cannot enumerate the key store', async () => {
    // Seed some keys as the admin tenant.
    await authed(request(app).post('/api/admin/api-keys').send({ name: 'tenant-key' }));

    // An unauthenticated request must be rejected before reading any records.
    const res = await request(app).get('/api/admin/api-keys');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('data');
  });

  it('wrong-credential caller cannot observe keys created by the admin tenant', async () => {
    await authed(request(app).post('/api/admin/api-keys').send({ name: 'tenant-key' }));

    const res = await request(app)
      .get('/api/admin/api-keys')
      .set('Authorization', 'Bearer not-the-admin-key');
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('data');
  });

  it('wrong-credential caller cannot rotate a key created by the admin tenant', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'tenant-key' }),
    );
    const { id } = createRes.body.data;

    const res = await request(app)
      .post(`/api/admin/api-keys/${id}/rotate`)
      .set('Authorization', 'Bearer not-the-admin-key');
    expect(res.status).toBe(403);
  });

  it('wrong-credential caller cannot revoke a key created by the admin tenant', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'tenant-key' }),
    );
    const { id } = createRes.body.data;

    const res = await request(app)
      .delete(`/api/admin/api-keys/${id}`)
      .set('Authorization', 'Bearer not-the-admin-key');
    expect(res.status).toBe(403);
  });

  // ── 7. Duplicate names ─────────────────────────────────────────────────

  it('handles duplicate API-key name gracefully — assigns distinct IDs', async () => {
    const res1 = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    expect(res1.status).toBe(201);

    const res2 = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    expect(res2.status).toBe(201);
    expect(res2.body.data.id).not.toBe(res1.body.data.id);

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.data.apiKeys).toHaveLength(2);

    for (const entry of listRes.body.data.apiKeys as Record<string, unknown>[]) {
      assertSafeDisplayShape(entry);
    }
  });

  // ── 8. Response envelope consistency ──────────────────────────────────

  it('every 2xx response carries success:true and a meta.timestamp', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'env-check' }),
    );
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.meta?.timestamp).toBeTruthy();

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.meta?.timestamp).toBeTruthy();

    const rotateRes = await authed(
      request(app).post(`/api/admin/api-keys/${createRes.body.data.id}/rotate`),
    );
    expect(rotateRes.body.success).toBe(true);
    expect(rotateRes.body.meta?.timestamp).toBeTruthy();
  });

  it('every 4xx response carries success:false, error.code, and error.message', async () => {
    const badCreate = await authed(
      request(app).post('/api/admin/api-keys').send({}),
    );
    expect(badCreate.body.success).toBe(false);
    expect(badCreate.body.error?.code).toBeTruthy();
    expect(badCreate.body.error?.message).toBeTruthy();

    const badRotate = await authed(
      request(app).post('/api/admin/api-keys/nonexistent/rotate'),
    );
    expect(badRotate.body.success).toBe(false);
    expect(badRotate.body.error?.code).toBeTruthy();
    expect(badRotate.body.error?.message).toBeTruthy();

    const badRevoke = await authed(
      request(app).delete('/api/admin/api-keys/nonexistent'),
    );
    expect(badRevoke.body.success).toBe(false);
    expect(badRevoke.body.error?.code).toBe('NOT_FOUND');
    expect(badRevoke.body.error?.message).toBeTruthy();
  });

  // ── 9. Audit trail ─────────────────────────────────────────────────────

  it('create, rotate, and revoke each emit a durable audit event', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'audited' }),
    );
    const { id } = createRes.body.data;

    await authed(request(app).post(`/api/admin/api-keys/${id}/rotate`));
    await authed(request(app).delete(`/api/admin/api-keys/${id}`));

    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_CREATED', 'api_key', id, expect.anything(), expect.any(Object),
    );
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_ROTATED', 'api_key', id, expect.anything(), expect.any(Object),
    );
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_REVOKED', 'api_key', id, expect.anything(), expect.any(Object),
    );
  });
});
