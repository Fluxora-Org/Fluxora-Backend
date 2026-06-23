import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';

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
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data.pauseFlags).toEqual({
      streamCreation: false,
      ingestion: false,
    });
    expect(res.body.meta).toHaveProperty('timestamp');
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
      const res = await authed(
        request(app).put('/api/admin/pause').send({ streamCreation: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.data.pauseFlags.streamCreation).toBe(true);
      expect(res.body.data.pauseFlags.ingestion).toBe(false);
      expect(res.body.meta).toHaveProperty('timestamp');
    });

    it('updates ingestion flag in envelope', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ ingestion: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.pauseFlags.ingestion).toBe(true);
    });

    it('updates both flags at once in envelope', async () => {
      const res = await authed(
        request(app)
          .put('/api/admin/pause')
          .send({ streamCreation: true, ingestion: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.pauseFlags.streamCreation).toBe(true);
      expect(res.body.data.pauseFlags.ingestion).toBe(true);
    });

    it('returns 400 error envelope when body is empty', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({}),
      );
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(res.body.error.message).toMatch(/at least one of/i);
    });

    it('returns 400 error envelope when streamCreation is not boolean', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ streamCreation: 'yes' }),
      );
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error.message).toMatch(/boolean/i);
    });

    it('returns 400 error envelope when ingestion is not boolean', async () => {
      const res = await authed(
        request(app).put('/api/admin/pause').send({ ingestion: 42 }),
      );
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
});
