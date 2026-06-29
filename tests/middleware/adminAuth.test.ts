import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { requireAdminAuth } from '../../src/middleware/adminAuth.js';
import { authApiKeyLookupDurationSeconds } from '../../src/metrics/businessMetrics.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requireAdminAuth);
  app.get('/protected', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireAdminAuth middleware', () => {
  const ADMIN_KEY = 'test-admin-secret-key-1234';
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('returns 503 when ADMIN_API_KEY is not set', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(buildApp()).get('/protected');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('returns 401 when Authorization header is missing', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing Authorization/i);
  });

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Bearer scheme/i);
  });

  it('returns 401 when Authorization header has too many parts', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer token extra');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Bearer scheme/i);
  });

  it('returns 403 when token is wrong', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid admin credentials/i);
  });

  it('returns 403 when token has wrong length', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer short');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid admin credentials/i);
  });

  it('passes through when token matches ADMIN_API_KEY', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 401 when Authorization header exceeds maximum length', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const oversized = 'Bearer ' + 'A'.repeat(8186);
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', oversized);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('processes Authorization header at exactly maximum length through normal auth flow', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const exact = 'Bearer ' + 'A'.repeat(8185);
    expect(exact.length).toBe(8192);
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', exact);
    // Header passed the length check and entered normal auth (token won't match)
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid admin credentials/i);
  });

  it('rejects oversized headers before token parsing and timing-safe comparison', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const oversized = 'Bearer ' + ADMIN_KEY + 'A'.repeat(8200);
    expect(oversized.length).toBeGreaterThan(8192);
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', oversized);
    // Returns oversized error (401) rather than credential error (403),
    // proving split/timingSafeEqual were never reached.
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/too large/i);
  });

  // ── API key lookup histogram (issue #361) ──
  describe('fluxora_auth_apikey_lookup_duration_seconds histogram', () => {
    beforeEach(() => {
      authApiKeyLookupDurationSeconds.reset();
    });

    /**
     * prom-client Histogram `get()` emits bucket observations (which include
     * `le`) alongside `_count` / `_sum` series (which carry only the metric's
     * declared labels). We assert on the count series to confirm the label
     * set is bounded to `outcome`.
     */
    function findApiKeyCountSeries(values: any[], outcome: string) {
      return values.find(
        (v) =>
          v.metricName === 'fluxora_auth_apikey_lookup_duration_seconds_count' &&
          (v.labels as Record<string, string>).outcome === outcome,
      );
    }

    it('records outcome=success for a correct admin token (count series labels limited to outcome)', async () => {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      await request(buildApp())
        .get('/protected')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .expect(200);

      const val = await authApiKeyLookupDurationSeconds.get();
      const success = findApiKeyCountSeries(val.values, 'success');
      expect(success).toBeDefined();
      expect(success?.value).toBeGreaterThanOrEqual(1);
      expect(Object.keys(success!.labels)).toEqual(['outcome']);
    });

    it('records outcome=failure for an incorrect admin token', async () => {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      await request(buildApp())
        .get('/protected')
        .set('Authorization', 'Bearer wrong-key')
        .expect(403);

      const val = await authApiKeyLookupDurationSeconds.get();
      const failure = findApiKeyCountSeries(val.values, 'failure');
      expect(failure).toBeDefined();
      expect(failure?.value).toBeGreaterThanOrEqual(1);
    });

    it('records outcome=failure when ADMIN_API_KEY is not configured (still observable, no credential leak)', async () => {
      delete process.env.ADMIN_API_KEY;
      await request(buildApp())
        .get('/protected')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .expect(503);

      const val = await authApiKeyLookupDurationSeconds.get();
      const failure = findApiKeyCountSeries(val.values, 'failure');
      expect(failure).toBeDefined();
      expect(failure?.value).toBeGreaterThanOrEqual(1);
      for (const v of val.values) {
        for (const forbidden of ['keyId', 'prefix', 'token']) {
          expect((v.labels as Record<string, unknown>)[forbidden]).toBeUndefined();
        }
      }
    });
  });
});
