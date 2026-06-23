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

  // 1. unauthorized requests → 401
  it('rejects unauthenticated GET to API keys list with 401', async () => {
    const res = await request(app).get('/api/admin/api-keys');
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated POST to create API key with 401', async () => {
    const res = await request(app).post('/api/admin/api-keys').send({ name: 'test' });
    expect(res.status).toBe(401);
  });

  // 2. invalid credentials → 403
  it('rejects GET with bad credentials to API keys list with 403', async () => {
    const res = await request(app)
      .get('/api/admin/api-keys')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  // 3. authenticated API-key creation
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
    expect(res.body.data).toHaveProperty('key'); // Raw key should be returned
    expect(res.body.data.key).toMatch(/^flx_/);
    expect(res.body.meta).toHaveProperty('timestamp');
    // Create is audited durably.
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_CREATED', 'api_key', res.body.data.id, expect.anything(), expect.any(Object),
    );
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

  // 4. authenticated API-key listing
  it('lists API keys in envelope when authenticated', async () => {
    // First seed a key
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
    expect(res.body.data.apiKeys[0]).not.toHaveProperty('key'); // Raw key must never be listed
    expect(res.body.data.apiKeys[0]).toHaveProperty('keyHash');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  // 5. rotation invalidates the old key and returns a new one
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

  it('returns 404 when rotating a non-existent API key', async () => {
    const res = await authed(request(app).post('/api/admin/api-keys/does-not-exist/rotate'));
    expect(res.status).toBe(404);
  });

  // 6. authenticated API-key revocation
  it('revokes an API key with 204 no-content when authenticated', async () => {
    const createRes = await authed(
      request(app).post('/api/admin/api-keys').send({ name: 'service-a' }),
    );
    const keyId = createRes.body.data.id;

    const deleteRes = await authed(request(app).delete(`/api/admin/api-keys/${keyId}`));
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.body).toEqual({}); // 204 should have empty body
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_REVOKED', 'api_key', keyId, expect.anything(), expect.any(Object),
    );

    // Verify it is deactivated in listing
    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.data.apiKeys[0].active).toBe(false);
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

  // 7. duplicate API-key name handling
  it('handles duplicate API-key name gracefully', async () => {
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
    expect(listRes.body.data.apiKeys[0].name).toBe('service-a');
    expect(listRes.body.data.apiKeys[1].name).toBe('service-a');
  });
});
