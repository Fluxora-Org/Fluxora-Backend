import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { adminRouter } from '../../src/routes/admin.js';
import { createApiKey, _resetApiKeyStoreForTest } from '../../src/lib/apiKey.js';
import { DEFAULT_API_KEY_SCOPES, Permission } from '../../src/lib/permissions.js';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

const ADMIN_KEY = 'test-admin-key-for-apikey-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin API key routes', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    _resetApiKeyStoreForTest();
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
  it('creates an API key with 201 when authenticated', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' })
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('service-a');
    expect(res.body).toHaveProperty('key'); // Raw key should be returned
    expect(res.body.key).toMatch(/^flx_/);
    expect(res.body.scopes).toEqual([...DEFAULT_API_KEY_SCOPES]);
  });

  it('creates a least-privilege API key with explicit scopes', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'read-only', scopes: [Permission.STREAMS_READ] })
    );
    expect(res.status).toBe(201);
    expect(res.body.scopes).toEqual([Permission.STREAMS_READ]);

    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.apiKeys[0].scopes).toEqual([Permission.STREAMS_READ]);
  });

  it('rejects empty and unknown scopes with 400', async () => {
    const emptyRes = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'empty-scopes', scopes: [] })
    );
    expect(emptyRes.status).toBe(400);

    const unknownRes = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'bad-scope', scopes: ['streams:read', 'unknown:scope'] })
    );
    expect(unknownRes.status).toBe(400);
  });

  it('rejects creation when name is missing or invalid with 400', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({})
    );
    expect(res.status).toBe(400);
  });

  // 4. authenticated API-key listing
  it('lists API keys when authenticated', async () => {
    // First seed a key
    await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' })
    );

    const res = await authed(request(app).get('/api/admin/api-keys'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('apiKeys');
    expect(res.body.apiKeys).toHaveLength(1);
    expect(res.body.apiKeys[0].name).toBe('service-a');
    expect(res.body.apiKeys[0]).not.toHaveProperty('key'); // Raw key must never be listed
    expect(res.body.apiKeys[0]).toHaveProperty('keyHash');
    expect(res.body.apiKeys[0].scopes).toEqual([...DEFAULT_API_KEY_SCOPES]);
  });

  it('allows admin API-key credentials only for matching admin scopes', async () => {
    const { key: pauseKey } = createApiKey('pause-admin', [Permission.ADMIN_PAUSE]);
    const pauseRes = await request(app)
      .get('/api/admin/pause')
      .set('x-api-key', pauseKey);
    expect(pauseRes.status).toBe(200);

    const apiKeysRes = await request(app)
      .get('/api/admin/api-keys')
      .set('x-api-key', pauseKey);
    expect(apiKeysRes.status).toBe(403);
    expect(apiKeysRes.body.error.code).toBe('FORBIDDEN');

    const { key: keyAdmin } = createApiKey('key-admin', [Permission.ADMIN_API_KEYS]);
    const listRes = await request(app)
      .get('/api/admin/api-keys')
      .set('x-api-key', keyAdmin);
    expect(listRes.status).toBe(200);
  });

  // 5. authenticated API-key deletion
  it('revokes an API key with 204 when authenticated', async () => {
    const createRes = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' })
    );
    const keyId = createRes.body.id;

    // Delete (revoke) key
    const deleteRes = await authed(
      request(app).delete(`/api/admin/api-keys/${keyId}`)
    );
    expect(deleteRes.status).toBe(204);

    // Verify it is deactivated in listing
    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.apiKeys[0].active).toBe(false);
  });

  it('returns 404 when revoking non-existent API key', async () => {
    const res = await authed(
      request(app).delete('/api/admin/api-keys/does-not-exist')
    );
    expect(res.status).toBe(404);
  });

  // 6. duplicate API-key name handling
  it('handles duplicate API-key name gracefully', async () => {
    // Create first key
    const res1 = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' })
    );
    expect(res1.status).toBe(201);

    // Create second key with duplicate name
    const res2 = await authed(
      request(app)
        .post('/api/admin/api-keys')
        .send({ name: 'service-a' })
    );
    expect(res2.status).toBe(201);
    expect(res2.body.id).not.toBe(res1.body.id);

    // Verify both are present in the list
    const listRes = await authed(request(app).get('/api/admin/api-keys'));
    expect(listRes.body.apiKeys).toHaveLength(2);
    expect(listRes.body.apiKeys[0].name).toBe('service-a');
    expect(listRes.body.apiKeys[1].name).toBe('service-a');
  });
});
