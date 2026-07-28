import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { _resetApiKeyStoreForTest } from '../../src/lib/apiKey.js';

const ADMIN_KEY = 'test-admin-key-for-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin routes', () => {
  let originalKey: string | undefined;

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
  });

  it('rejects requests with bad credentials', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(403);
  });

  it('allows unauthenticated read-only status checks', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pauseFlags: {
        streamCreation: false,
        ingestion: false,
      },
    });
  });

  // ── GET /api/admin/status ──────────────────────────────────

  describe('GET /api/admin/status', () => {
    it('returns pause flags and reindex state', async () => {
      const res = await authed(request(app).get('/api/admin/status'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('pauseFlags');
      expect(res.body).toHaveProperty('reindex');
      expect(res.body.pauseFlags.streamCreation).toBe(false);
      expect(res.body.pauseFlags.ingestion).toBe(false);
      expect(res.body.reindex.status).toBe('idle');
    });
  });

  // ── GET /api/admin/pause ───────────────────────────────────

  describe('GET /api/admin/pause', () => {
    it('returns current pause flags', async () => {
      const res = await authed(request(app).get('/api/admin/pause'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ streamCreation: false, ingestion: false });
    });
  });

  // ── PUT /api/admin/pause ───────────────────────────────────

  describe('PUT /api/admin/pause', () => {
    it('updates streamCreation flag', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ streamCreation: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body.pauseFlags.streamCreation).toBe(true);
      expect(res.body.pauseFlags.ingestion).toBe(false);
    });

    it('updates ingestion flag', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ ingestion: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body.pauseFlags.ingestion).toBe(true);
    });

    it('updates both flags at once', async () => {
      const res = await authed(
        request(app)
          .put('/api/admin/pause')
          .send({ streamCreation: true, ingestion: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body.pauseFlags.streamCreation).toBe(true);
      expect(res.body.pauseFlags.ingestion).toBe(true);
    });

    it('returns 400 when body is empty', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({}),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one of/i);
    });

    it('returns 400 when streamCreation is not boolean', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ streamCreation: 'yes' }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/boolean/i);
    });

    it('returns 400 when ingestion is not boolean', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ ingestion: 42 }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/boolean/i);
    });
  });

  // ── GET /api/admin/reindex ─────────────────────────────────

  describe('GET /api/admin/reindex', () => {
    it('returns idle reindex state by default', async () => {
      const res = await authed(request(app).get('/api/admin/reindex'));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('idle');
    });
  });

  // ── POST /api/admin/reindex ────────────────────────────────

  describe('POST /api/admin/reindex', () => {
    it('starts a reindex and returns 202', async () => {
      const res = await authed(request(app).post('/api/admin/reindex'));
      expect(res.status).toBe(202);
      expect(res.body.message).toMatch(/started/i);
      expect(res.body.reindex.status).toBe('running');
    });

    it('returns 409 when a reindex is already running', async () => {
      await authed(request(app).post('/api/admin/reindex'));
      const res = await authed(request(app).post('/api/admin/reindex'));
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already in progress/i);
    });

    it('reindex completes in the background', async () => {
      await authed(request(app).post('/api/admin/reindex'));

      // Wait for simulated job to finish.
      await new Promise((r) => setTimeout(r, 400));

      const res = await authed(request(app).get('/api/admin/reindex'));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.processedItems).toBe(5);
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
