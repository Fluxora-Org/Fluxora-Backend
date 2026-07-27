/**
 * Integration tests for admin tenant rate-limit override endpoints.
 *
 * Covered behaviour
 * -----------------
 * POST   /  — create override (happy path, validation, conflict, auth)
 * GET    /  — list overrides (happy path, empty list, auth)
 * DELETE /:id — delete override (happy path, not-found, unexpected error, auth)
 *
 * Auth edge-cases
 * --------------
 * • ADMIN_API_KEY unset              → 503
 * • No Authorization header          → 401
 * • Wrong Bearer token               → 403
 * • Valid static ADMIN_API_KEY       → passes
 * • JWT with role=admin              → passes
 * • JWT with role=data-protection-officer → passes
 * • JWT with role=viewer             → 403
 *
 * Validation edge-cases
 * ---------------------
 * • keyId empty string               → 400
 * • keyId missing                    → 400
 * • maxRequests = 0                  → 400
 * • maxRequests negative             → 400
 * • windowMs < 1000                  → 400
 * • expiresAt invalid string         → 400
 * • expiresAt valid ISO-8601 string  → 201
 *
 * Response envelope
 * -----------------
 * All success responses wrap data in { success: true, data, meta: { timestamp } }.
 * All error responses wrap errors in { success: false, error: { code, message } }.
 *
 * createdBy audit field
 * ---------------------
 * The service is called with `admin:<first-8-chars-of-token>` as createdBy.
 *
 * Unexpected service errors
 * -------------------------
 * A non-ApiError thrown from deleteOverride is re-thrown (not silently swallowed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { tenantRateLimitOverridesRouter } from '../../../src/routes/admin/tenantRateLimitOverrides.js';
import * as overrideService from '../../../src/services/tenantRateLimitOverride.service.js';
import { ApiError } from '../../../src/errors.js';
import { generateToken } from '../../../src/lib/auth.js';
import { initializeConfig } from '../../../src/config/env.js';

const ADMIN_KEY = 'test-admin-key-for-overrides';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/', tenantRateLimitOverridesRouter);
  return app;
}

function makeOverride(overrides: Partial<ReturnType<typeof makeOverride>> = {}) {
  return {
    id: 'override-1',
    keyId: 'key-1',
    maxRequests: 5000,
    windowMs: 60000,
    expiresAt: null as string | null,
    createdBy: `admin:${ADMIN_KEY.slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Admin rate-limit override endpoints', () => {
  let prevAdminKey: string | undefined;

  beforeEach(() => {
    prevAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    vi.clearAllMocks();
    // Ensure JWT config is loaded for token-based auth tests.
    initializeConfig();
  });

  afterEach(() => {
    if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdminKey;
  });

  // ---------------------------------------------------------------------------
  // POST /
  // ---------------------------------------------------------------------------
  describe('POST /', () => {
    it('creates override — returns 201 with success envelope', async () => {
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      vi.spyOn(overrideService, 'createOverride').mockResolvedValue(makeOverride());

      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.keyId).toBe('key-1');
      expect(res.body.data.maxRequests).toBe(5000);
      // Response envelope must include meta.timestamp
      expect(res.body.meta).toBeDefined();
      expect(typeof res.body.meta.timestamp).toBe('string');
    });

    it('passes createdBy = admin:<first-8-chars-of-token> to createOverride', async () => {
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      const createSpy = vi
        .spyOn(overrideService, 'createOverride')
        .mockResolvedValue(makeOverride());

      await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ keyId: 'key-1' }),
        `admin:${ADMIN_KEY.slice(0, 8)}`,
      );
    });

    it('creates override with optional expiresAt — returns 201', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      vi.spyOn(overrideService, 'createOverride').mockResolvedValue(
        makeOverride({ keyId: 'key-ttl', expiresAt: futureDate }),
      );

      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-ttl',
          maxRequests: 1000,
          windowMs: 60000,
          expiresAt: futureDate,
        }),
      );

      expect(res.status).toBe(201);
      expect(res.body.data.expiresAt).toBe(futureDate);
    });

    it('returns 409 when override already exists — body has CONFLICT code', async () => {
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(makeOverride());

      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 400 — keyId is empty string', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: '',
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 — keyId is missing', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 — maxRequests is zero', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 0,
          windowMs: 60000,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 — maxRequests is negative', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: -1,
          windowMs: 60000,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 — windowMs below 1000', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 500,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 — windowMs is exactly 999', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 999,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts windowMs at the minimum boundary (1000)', async () => {
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      vi.spyOn(overrideService, 'createOverride').mockResolvedValue(
        makeOverride({ windowMs: 1000 }),
      );

      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-min-window',
          maxRequests: 100,
          windowMs: 1000,
        }),
      );
      expect(res.status).toBe(201);
    });

    it('returns 400 — expiresAt is not a valid ISO-8601 datetime', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
          expiresAt: 'not-a-date',
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 — no Authorization header', async () => {
      const res = await request(createTestApp()).post('/').send({
        keyId: 'key-1',
        maxRequests: 5000,
        windowMs: 60000,
      });
      expect(res.status).toBe(401);
    });

    it('returns 503 — ADMIN_API_KEY not set', async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await request(createTestApp())
        .post('/')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ keyId: 'key-1', maxRequests: 5000, windowMs: 60000 });
      expect(res.status).toBe(503);
    });

    it('returns 403 — wrong static token', async () => {
      const res = await request(createTestApp())
        .post('/')
        .set('Authorization', 'Bearer definitely-wrong-key')
        .send({ keyId: 'key-1', maxRequests: 5000, windowMs: 60000 });
      expect(res.status).toBe(403);
    });

    it('accepts a JWT with role=admin', async () => {
      const token = generateToken({ address: 'GADMIN', role: 'admin' });
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      vi.spyOn(overrideService, 'createOverride').mockResolvedValue(makeOverride());

      const res = await request(createTestApp())
        .post('/')
        .set('Authorization', `Bearer ${token}`)
        .send({ keyId: 'key-1', maxRequests: 5000, windowMs: 60000 });
      expect(res.status).toBe(201);
    });

    it('accepts a JWT with role=data-protection-officer', async () => {
      const token = generateToken({ address: 'GDPO', role: 'data-protection-officer' });
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      vi.spyOn(overrideService, 'createOverride').mockResolvedValue(makeOverride());

      const res = await request(createTestApp())
        .post('/')
        .set('Authorization', `Bearer ${token}`)
        .send({ keyId: 'key-1', maxRequests: 5000, windowMs: 60000 });
      expect(res.status).toBe(201);
    });

    it('returns 403 — JWT with non-admin role (viewer)', async () => {
      const token = generateToken({ address: 'GVIEWER', role: 'viewer' });
      const res = await request(createTestApp())
        .post('/')
        .set('Authorization', `Bearer ${token}`)
        .send({ keyId: 'key-1', maxRequests: 5000, windowMs: 60000 });
      expect(res.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /
  // ---------------------------------------------------------------------------
  describe('GET /', () => {
    it('returns all overrides — success envelope with data array', async () => {
      vi.spyOn(overrideService, 'listOverrides').mockResolvedValue([
        makeOverride({ id: 'override-1', keyId: 'key-1' }),
        makeOverride({
          id: 'override-2',
          keyId: 'key-2',
          maxRequests: 10000,
          windowMs: 120000,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      ]);

      const res = await authed(request(createTestApp()).get('/'));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toBeDefined();
      expect(typeof res.body.meta.timestamp).toBe('string');
    });

    it('returns empty array when no overrides exist — not null', async () => {
      vi.spyOn(overrideService, 'listOverrides').mockResolvedValue([]);

      const res = await authed(request(createTestApp()).get('/'));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    it('returns 401 — no Authorization header', async () => {
      const res = await request(createTestApp()).get('/');
      expect(res.status).toBe(401);
    });

    it('returns 503 — ADMIN_API_KEY not set', async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await request(createTestApp())
        .get('/')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(503);
    });

    it('returns 403 — wrong static token', async () => {
      const res = await request(createTestApp())
        .get('/')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id
  // ---------------------------------------------------------------------------
  describe('DELETE /:id', () => {
    it('deletes correctly — returns 204 with empty body', async () => {
      vi.spyOn(overrideService, 'deleteOverride').mockResolvedValue(undefined);

      const res = await authed(request(createTestApp()).delete('/override-1'));
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
    });

    it('returns 404 for nonexistent ID — body has NOT_FOUND code', async () => {
      vi.spyOn(overrideService, 'deleteOverride').mockRejectedValue(
        new ApiError(404, 'NOT_FOUND', 'Override not found: nonexistent'),
      );

      const res = await authed(request(createTestApp()).delete('/nonexistent'));
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('re-throws unexpected (non-ApiError) errors from deleteOverride', async () => {
      // The route catches ApiError 404 and handles it; all other errors must propagate.
      // supertest surfaces unhandled errors as 500 when no error handler is registered.
      const app = createTestApp();
      // Attach a minimal error handler so Express doesn't swallow the throw silently.
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
      });

      vi.spyOn(overrideService, 'deleteOverride').mockRejectedValue(
        new Error('Unexpected DB failure'),
      );

      const res = await authed(request(app).delete('/override-1'));
      expect(res.status).toBe(500);
    });

    it('returns 401 — no Authorization header', async () => {
      const res = await request(createTestApp()).delete('/override-1');
      expect(res.status).toBe(401);
    });

    it('returns 503 — ADMIN_API_KEY not set', async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await request(createTestApp())
        .delete('/override-1')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(503);
    });

    it('returns 403 — wrong static token', async () => {
      const res = await request(createTestApp())
        .delete('/override-1')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(403);
    });
  });
});
