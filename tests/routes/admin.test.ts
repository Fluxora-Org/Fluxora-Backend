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
});
