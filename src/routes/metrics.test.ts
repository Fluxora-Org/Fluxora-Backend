import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { metricsRouter } from './metrics.js';
import { registry } from '../metrics.js';
import { generateToken } from '../lib/auth.js';
import * as logger from '../lib/logger.js';

describe('src/routes/metrics.ts (dedicated module test)', () => {
  const TEST_ADMIN_KEY = 'fluxora-metrics-test-admin-key-999';
  let originalKey: string | undefined;
  let app: express.Express;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

    app = express();
    app.use(express.json());
    app.use('/metrics', metricsRouter);
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
    vi.restoreAllMocks();
  });

  describe('Authorization & Refusal', () => {
    it('refuses uncredentialed external request with 401 and logs warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error', 'Missing Authorization header.');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Admin authorization refused — missing Authorization header'),
        expect.objectContaining({
          path: '/metrics',
          method: 'GET',
        })
      );
    });

    it('refuses non-Bearer authorization scheme with 401 and logs warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Basic ${TEST_ADMIN_KEY}`);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error', 'Authorization header must use Bearer scheme.');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Admin authorization refused — invalid Authorization header scheme'),
        expect.objectContaining({
          path: '/metrics',
          method: 'GET',
        })
      );
    });

    it('refuses invalid Bearer token with 403 and logs warning without leaking token', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const badToken = 'unauthorized-token-12345';

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${badToken}`);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('error', 'Invalid admin credentials.');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Admin authorization refused — invalid admin credentials'),
        expect.objectContaining({
          path: '/metrics',
          method: 'GET',
        })
      );

      // Verify no token material is leaked in the log call
      for (const call of warnSpy.mock.calls) {
        const loggedString = JSON.stringify(call);
        expect(loggedString).not.toContain(badToken);
        expect(loggedString).not.toContain(TEST_ADMIN_KEY);
      }
    });

    it('refuses request when ADMIN_API_KEY is not configured with 503 and logs warning', async () => {
      delete process.env.ADMIN_API_KEY;
      const warnSpy = vi.spyOn(logger, 'warn');

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${TEST_ADMIN_KEY}`);

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Admin authorization refused — ADMIN_API_KEY is not configured'),
        expect.objectContaining({
          path: '/metrics',
          method: 'GET',
        })
      );
    });

    it('refuses JWT with non-admin role (e.g. viewer) with 403 and logs warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const token = generateToken({ address: 'GUSER1111111111111111111111111111111111111111111111111111111', role: 'viewer' });

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('error', 'Invalid admin credentials.');
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('Authorized Access', () => {
    it('returns 200 with Prometheus metrics when authenticated via ADMIN_API_KEY Bearer token', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${TEST_ADMIN_KEY}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);
      expect(res.text).toContain('# HELP');
      expect(res.text).toContain('fluxora');
    });

    it('returns 200 with Prometheus metrics when authenticated via admin JWT', async () => {
      const token = generateToken({ address: 'GADMIN11111111111111111111111111111111111111111111111111111', role: 'admin' });

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);
      expect(res.text).toContain('# HELP');
    });

    it('returns 200 with Prometheus metrics when authenticated via data-protection-officer JWT', async () => {
      const token = generateToken({ address: 'GDPO1111111111111111111111111111111111111111111111111111111', role: 'data-protection-officer' });

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('# HELP');
    });
  });

  describe('Cardinality and Privacy Guarantees', () => {
    it('ensures no high-cardinality label exposes per-user data in the scraped metrics payload', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${TEST_ADMIN_KEY}`);

      expect(res.status).toBe(200);
      const metricsText = res.text;

      // Assert no Stellar public key addresses (G followed by 55 alphanumeric chars)
      expect(metricsText).not.toMatch(/G[A-Z0-9]{55}/);

      // Assert no email addresses
      expect(metricsText).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

      // Assert no secret key or token material is leaked in labels
      expect(metricsText).not.toContain(TEST_ADMIN_KEY);

      // Assert that standard high-cardinality user labels do not exist
      const lines = metricsText.split('\n');
      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;

        // Extract label block {label1="val", ...}
        const labelMatch = line.match(/\{([^}]+)\}/);
        if (labelMatch) {
          const labelsString = labelMatch[1];
          // Check for dangerous user-specific label names
          expect(labelsString).not.toMatch(/\b(user_id|userId|user_email|email|wallet_address|account_id|secret|token|password|auth_token)\b/i);
        }
      }
    });
  });

  describe('Error handling', () => {
    it('returns 500 when registry.metrics() fails and logs the error', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      vi.spyOn(registry, 'metrics').mockRejectedValueOnce(new Error('Registry scrape failed'));

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${TEST_ADMIN_KEY}`);

      expect(res.status).toBe(500);
      expect(res.text).toBe('Failed to generate metrics');
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to generate metrics',
        expect.objectContaining({ error: 'Registry scrape failed' })
      );
    });
  });
});
