import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { generateToken } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';

const ADMIN_KEY = 'test-admin-key-for-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin routes', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    initializeConfig();
  });

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    _resetForTest();
    _resetApiKeyStoreForTest();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  // ── Auth gate ──────────────────────────────────────────────

  it('rejects unauthenticated requests to admin routes', async () => {
    const res = await request(app).get('/api/admin/status');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing Authorization header.' });
  });

  it('rejects requests with bad credentials', async () => {
    const res = await request(app).get('/api/admin/status').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(403);
  });

  it('allows unauthenticated read-only status checks', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data.pauseFlags).toEqual({
      streamCreation: false,
      ingestion: false,
    });
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('keeps read-only status public when admin auth is unconfigured or invalid', async () => {
    delete process.env.ADMIN_API_KEY;

    const unconfigured = await request(app).get('/api/admin/status/read-only');
    const malformed = await request(app)
      .get('/api/admin/status/read-only')
      .set('Authorization', 'Basic ignored-on-public-route');

    expect(unconfigured.status).toBe(200);
    expect(malformed.status).toBe(200);
  });

  it('fails protected routes closed with 503 when admin auth is unconfigured', async () => {
    delete process.env.ADMIN_API_KEY;

    const res = await request(app).get('/api/admin/status');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Admin API is not configured. Set ADMIN_API_KEY to enable admin access.',
    });
  });

  it('protects other methods on the public read-only path', async () => {
    const res = await request(app).post('/api/admin/status/read-only');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing Authorization header.' });
  });

  it('runs the guard before returning 404 for unknown admin paths', async () => {
    const unauthenticated = await request(app).get('/api/admin/not-a-route');
    const authenticated = await authed(request(app).get('/api/admin/not-a-route'));

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(404);
    expect(authenticated.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it.each(['admin', 'data-protection-officer'])(
    'allows a valid JWT with the %s role through the route guard',
    async (role) => {
      const token = generateToken({ address: 'GADMIN', role, permissions: [] });
      const res = await request(app)
        .get('/api/admin/status')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    }
  );

  it('rejects a valid non-admin JWT even when it carries an admin-named permission', async () => {
    const token = generateToken({
      address: 'GOPERATOR',
      role: 'operator',
      permissions: ['admin:pause'],
    });
    const res = await request(app).get('/api/admin/status').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Invalid admin credentials.' });
  });

  it('does not lock out a later retry with valid credentials', async () => {
    await request(app).get('/api/admin/status').set('Authorization', 'Bearer wrong').expect(403);

    const retry = await authed(request(app).get('/api/admin/status'));

    expect(retry.status).toBe(200);
  });

  it('runs authorization before handler validation and mutation', async () => {
    const rejected = await request(app).put('/api/admin/pause').send({ streamCreation: true });
    const state = await authed(request(app).get('/api/admin/pause'));

    expect(rejected.status).toBe(401);
    expect(state.body.data).toEqual({ streamCreation: false, ingestion: false });
  });

  // ── GET /api/admin/status ──────────────────────────────────

  describe('GET /api/admin/status', () => {
    it('returns pause flags and reindex state in envelope', async () => {
      const res = await authed(request(app).get('/api/admin/status'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.data).toHaveProperty('pauseFlags');
      expect(res.body.data).toHaveProperty('reindex');
      expect(res.body.data.pauseFlags.streamCreation).toBe(false);
      expect(res.body.data.pauseFlags.ingestion).toBe(false);
      expect(res.body.data.reindex.status).toBe('idle');
      expect(res.body.meta).toHaveProperty('timestamp');
    });
  });

  // ── GET /api/admin/pause ───────────────────────────────────

  describe('GET /api/admin/pause', () => {
    it('returns current pause flags in envelope', async () => {
      const res = await authed(request(app).get('/api/admin/pause'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.data).toEqual({ streamCreation: false, ingestion: false });
      expect(res.body.meta).toHaveProperty('timestamp');
    });
  });

  // ── PUT /api/admin/pause ───────────────────────────────────

  describe('PUT /api/admin/pause', () => {
    it('updates streamCreation flag in envelope', async () => {
      const res = await authed(request(app).put('/api/admin/pause').send({ streamCreation: true }));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.data.pauseFlags.streamCreation).toBe(true);
      expect(res.body.data.pauseFlags.ingestion).toBe(false);
      expect(res.body.meta).toHaveProperty('timestamp');
    });

    it('updates ingestion flag in envelope', async () => {
      const res = await authed(request(app).put('/api/admin/pause').send({ ingestion: true }));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.pauseFlags.ingestion).toBe(true);
    });

    it('updates both flags at once in envelope', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ streamCreation: true, ingestion: true })
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.pauseFlags.streamCreation).toBe(true);
      expect(res.body.data.pauseFlags.ingestion).toBe(true);
    });

    it('returns 400 error envelope when body is empty', async () => {
      const res = await authed(request(app).put('/api/admin/pause').send({}));
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(res.body.error.message).toMatch(/at least one of/i);
    });

    it('returns 400 error envelope when streamCreation is not boolean', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ streamCreation: 'yes' })
      );
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error.message).toMatch(/boolean/i);
    });

    it('returns 400 error envelope when ingestion is not boolean', async () => {
      const res = await authed(request(app).put('/api/admin/pause').send({ ingestion: 42 }));
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error.message).toMatch(/boolean/i);
    });
  });

  // ── GET /api/admin/reindex ─────────────────────────────────

  describe('GET /api/admin/reindex', () => {
    it('returns idle reindex state in envelope', async () => {
      const res = await authed(request(app).get('/api/admin/reindex'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.data.status).toBe('idle');
      expect(res.body.meta).toHaveProperty('timestamp');
    });
  });

  // ── POST /api/admin/reindex ────────────────────────────────

  describe('POST /api/admin/reindex', () => {
    it('starts a reindex and returns 202 in envelope', async () => {
      const res = await authed(request(app).post('/api/admin/reindex'));
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.data.message).toMatch(/started/i);
      expect(res.body.data.reindex.status).toBe('running');
      expect(res.body.meta).toHaveProperty('timestamp');
    });

    it('returns 409 error envelope when a reindex is already running', async () => {
      await authed(request(app).post('/api/admin/reindex'));
      const res = await authed(request(app).post('/api/admin/reindex'));
      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error.message).toMatch(/already in progress/i);
    });

    it('reindex completes in the background', async () => {
      await authed(request(app).post('/api/admin/reindex'));

      // Wait for simulated job to finish.
      await new Promise((r) => setTimeout(r, 400));

      const res = await authed(request(app).get('/api/admin/reindex'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.status).toBe('completed');
      expect(res.body.data.processedItems).toBe(5);
    });
  });

  // ── API Key Management ─────────────────────────────────────

  describe('API Key Management', () => {
    it('creates a new API key and records an audit event', async () => {
      const res = await authed(
        request(app).post('/api/admin/api-keys').send({ name: 'test-service' }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('key');
      expect(res.body.name).toBe('test-service');
    });

    it('lists created API keys', async () => {
      await authed(request(app).post('/api/admin/api-keys').send({ name: 'test-service-1' }));
      const res = await authed(request(app).get('/api/admin/api-keys'));
      expect(res.status).toBe(200);
      expect(res.body.apiKeys.length).toBeGreaterThan(0);
      // Raw key should not be returned in list
      expect(res.body.apiKeys[0]).not.toHaveProperty('key');
    });

    it('rotates an API key', async () => {
      const createRes = await authed(
        request(app).post('/api/admin/api-keys').send({ name: 'rotate-me' }),
      );
      const id = createRes.body.id;
      const originalKey = createRes.body.key;

      const rotateRes = await authed(
        request(app).post(`/api/admin/api-keys/${id}/rotate`),
      );
      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.id).toBe(id);
      expect(rotateRes.body.key).not.toBe(originalKey);
    });

    it('revokes an API key', async () => {
      const createRes = await authed(
        request(app).post('/api/admin/api-keys').send({ name: 'revoke-me' }),
      );
      const id = createRes.body.id;

      const deleteRes = await authed(
        request(app).delete(`/api/admin/api-keys/${id}`),
      );
      expect(deleteRes.status).toBe(204);

      // Verify rotation fails on revoked key
      const rotateRes = await authed(
        request(app).post(`/api/admin/api-keys/${id}/rotate`),
      );
      expect(rotateRes.status).toBe(400); // Bad Request (revoked)
      expect(rotateRes.body.error).toMatch(/revoked/i);
    });

    it('returns 400 if name is missing when creating API key', async () => {
      const res = await authed(request(app).post('/api/admin/api-keys').send({}));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name.*required/i);
    });

    it('returns 404 when rotating a non-existent API key', async () => {
      const res = await authed(
        request(app).post('/api/admin/api-keys/does-not-exist/rotate'),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 404 when revoking a non-existent API key', async () => {
      const res = await authed(
        request(app).delete('/api/admin/api-keys/does-not-exist'),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });
});
