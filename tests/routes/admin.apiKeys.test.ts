import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { ApiKeyRecord, ApiKeyStoredRecord } from '../../src/db/types.js';
import type { ApiKeyStore } from '../../src/lib/apiKey.js';

function publicRecord(record: ApiKeyStoredRecord): ApiKeyRecord {
  return {
    id: record.id,
    name: record.name,
    keyHash: record.keyHash,
    prefix: record.prefix,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
    active: record.active,
  };
}

const repositoryMock = vi.hoisted(() => {
  const records = new Map<string, ApiKeyStoredRecord>();
  const recordAuditEventToDb = vi.fn().mockResolvedValue({
    seq: 1,
    timestamp: '2026-06-22T00:00:00.000Z',
    action: 'API_KEY_CREATED',
    resourceType: 'api_key',
    resourceId: 'key-1',
  });
  const repo: ApiKeyStore & { records: Map<string, ApiKeyStoredRecord> } = {
    records,
    async create(input) {
      const record: ApiKeyStoredRecord = { ...input, revokedAt: null, active: true };
      records.set(record.id, record);
      return publicRecord(record);
    },
    async findById(id) {
      const record = records.get(id);
      return record ? publicRecord(record) : undefined;
    },
    async findActiveByLookupHash(lookupHash) {
      return [...records.values()].filter((record) => record.active && record.lookupHash === lookupHash);
    },
    async list() {
      return [...records.values()].map(publicRecord);
    },
    async rotate(id, input) {
      const current = records.get(id);
      if (!current || !current.active) return undefined;
      const next = { ...current, ...input };
      records.set(id, next);
      return publicRecord(next);
    },
    async revoke(id, revokedAt) {
      const current = records.get(id);
      if (!current) return undefined;
      const next = { ...current, revokedAt, active: false };
      records.set(id, next);
      return publicRecord(next);
    },
    async deleteAllForTest() {
      records.clear();
    },
  };
  return { repo, recordAuditEventToDb };
});

vi.mock('../../src/db/repositories/apiKeyRepository.js', () => ({
  apiKeyRepository: repositoryMock.repo,
}));

vi.mock('../../src/lib/auditLog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/auditLog.js')>();
  return {
    ...actual,
    recordAuditEventToDb: repositoryMock.recordAuditEventToDb,
  };
});

const { adminRouter } = await import('../../src/routes/admin.js');
const { _resetApiKeyStoreForTest } = await import('../../src/lib/apiKey.js');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

const ADMIN_KEY = 'test-admin-key-for-apikey-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin API key routes', () => {
  let originalKey: string | undefined;
  let originalPepper: string | undefined;

  beforeEach(async () => {
    originalKey = process.env.ADMIN_API_KEY;
    originalPepper = process.env.API_KEY_PEPPER;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.API_KEY_PEPPER = 'test-pepper-for-admin-api-key-routes-12345';
    repositoryMock.recordAuditEventToDb.mockClear();
    await _resetApiKeyStoreForTest();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
    if (originalPepper !== undefined) {
      process.env.API_KEY_PEPPER = originalPepper;
    } else {
      delete process.env.API_KEY_PEPPER;
    }
  });

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

  it('creates an API key with 201 when authenticated', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('service-a');
    expect(res.body).toHaveProperty('key');
    expect(res.body.key).toMatch(/^flx_/);
    expect(repositoryMock.recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_CREATED',
      'api_key',
      res.body.id,
      undefined,
      { prefix: res.body.prefix, name: 'service-a' },
    );
  });

  it('rejects creation when name is missing or invalid with 400', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({}),
    );
    expect(res.status).toBe(400);
  });

  it('lists API keys without raw keys, salts, or lookup hashes', async () => {
    await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' }),
    );

    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('apiKeys');
    expect(res.body.apiKeys).toHaveLength(1);
    expect(res.body.apiKeys[0].name).toBe('service-a');
    expect(res.body.apiKeys[0]).not.toHaveProperty('key');
    expect(res.body.apiKeys[0]).not.toHaveProperty('keySalt');
    expect(res.body.apiKeys[0]).not.toHaveProperty('lookupHash');
    expect(res.body.apiKeys[0]).toHaveProperty('keyHash');
  });

  it('revokes an API key with 204 when authenticated', async () => {
    const createRes = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' }),
    );
    const keyId = createRes.body.id;

    const deleteRes = await authed(
      request(app).delete(`/api/admin/api-keys/${keyId}`),
    );
    expect(deleteRes.status).toBe(204);

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.apiKeys[0].active).toBe(false);
    expect(listRes.body.apiKeys[0].revokedAt).not.toBeNull();
    expect(repositoryMock.recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_REVOKED',
      'api_key',
      keyId,
      undefined,
    );
  });

  it('rotates an API key and writes a durable audit row', async () => {
    const createRes = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' }),
    );

    const rotateRes = await authed(
      request(app).post(`/api/admin/api-keys/${createRes.body.id}/rotate`),
    );

    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.key).toMatch(/^flx_/);
    expect(rotateRes.body.key).not.toBe(createRes.body.key);
    expect(repositoryMock.recordAuditEventToDb).toHaveBeenCalledWith(
      'API_KEY_ROTATED',
      'api_key',
      createRes.body.id,
      undefined,
      { prefix: rotateRes.body.prefix, name: 'service-a' },
    );
  });

  it('returns 404 when revoking non-existent API key', async () => {
    const res = await authed(
      request(app).delete('/api/admin/api-keys/does-not-exist'),
    );
    expect(res.status).toBe(404);
  });

  it('handles duplicate API-key name gracefully', async () => {
    const res1 = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' }),
    );
    expect(res1.status).toBe(201);

    const res2 = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' }),
    );
    expect(res2.status).toBe(201);
    expect(res2.body.id).not.toBe(res1.body.id);

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.apiKeys).toHaveLength(2);
    expect(listRes.body.apiKeys[0].name).toBe('service-a');
    expect(listRes.body.apiKeys[1].name).toBe('service-a');
  });
});
