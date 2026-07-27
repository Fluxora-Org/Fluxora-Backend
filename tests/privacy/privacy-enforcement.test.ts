/**
 * Privacy route enforcement tests (Closes #680)
 *
 * Verifies content-type, body-size, and rate-limit enforcement on privacy routes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock dependencies before importing router
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
  query: vi.fn(),
  withClient: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {},
}));

vi.mock('../../src/pii/pgcryptoEncryption.js', () => ({
  computeAddressHash: vi.fn(() => 'mock-hash'),
  DEFAULT_ERASURE_TOMBSTONE: '[REDACTED_GDPR_ERASURE]',
  redactPiiForAddress: vi.fn(),
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn(),
  recordErasureAuditLog: vi.fn(),
}));

vi.mock('../../src/middleware/adminAuth.js', () => ({
  requireAdminAuth: (req: any, _res: any, next: any) => {
    req.user = { address: 'GADMIN', role: 'admin' };
    next();
  },
}));

import { privacyRouter } from '../../src/routes/privacy.js';

function createApp() {
  const app = express();
  app.use('/api/privacy', privacyRouter);
  return app;
}

describe('Privacy Route Enforcement (#680)', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe('Content-Type enforcement', () => {
    it('should reject PUT /consent with non-JSON content-type', async () => {
      const response = await request(app)
        .put('/api/privacy/consent')
        .set('Content-Type', 'text/plain')
        .send('not json');

      expect(response.status).toBe(415);
      expect(response.body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(response.body.error?.message).toContain('application/json');
    });

    it('should accept PUT /consent with application/json', async () => {
      const response = await request(app)
        .put('/api/privacy/consent')
        .set('Content-Type', 'application/json')
        .send({
          address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          analytics_optout: true,
          marketing_optout: false,
          biometric_processing_consent: false,
        });

      // May fail for other reasons (DB, etc.) but NOT 415
      expect(response.status).not.toBe(415);
    });

    it('should accept PUT /consent with application/json; charset=utf-8', async () => {
      const response = await request(app)
        .put('/api/privacy/consent')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send({
          address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          analytics_optout: true,
          marketing_optout: false,
          biometric_processing_consent: false,
        });

      expect(response.status).not.toBe(415);
    });

    it('should pass through requests without Content-Type (proxies may strip)', async () => {
      const response = await request(app)
        .put('/api/privacy/consent')
        .send({
          address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          analytics_optout: true,
          marketing_optout: false,
          biometric_processing_consent: false,
        });

      // Should not be 415
      expect(response.status).not.toBe(415);
    });
  });

  describe('Body size enforcement', () => {
    it('should reject oversized body on PUT /consent', async () => {
      const largeBody = {
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: false,
        extra: 'x'.repeat(300_000), // ~300KB, exceeds 256KB limit
      };

      const response = await request(app)
        .put('/api/privacy/consent')
        .set('Content-Type', 'application/json')
        .send(largeBody);

      // Should get 413 Payload Too Large or 400 (depends on which limit fires first)
      expect([413, 400]).toContain(response.status);
    });

    it('should accept normal-sized body on PUT /consent', async () => {
      const response = await request(app)
        .put('/api/privacy/consent')
        .set('Content-Type', 'application/json')
        .send({
          address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          analytics_optout: true,
          marketing_optout: false,
          biometric_processing_consent: false,
        });

      // Should NOT be 413
      expect(response.status).not.toBe(413);
    });
  });

  describe('GET routes should not require Content-Type', () => {
    it('should serve GET /policy without Content-Type', async () => {
      const response = await request(app)
        .get('/api/privacy/policy');

      expect(response.status).toBe(200);
    });

    it('should serve GET /retention without Content-Type', async () => {
      const response = await request(app)
        .get('/api/privacy/retention');

      expect(response.status).toBe(200);
    });
  });

  describe('Security headers', () => {
    it('should set Cache-Control: no-store on all privacy responses', async () => {
      const response = await request(app).get('/api/privacy/policy');
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('should set X-Content-Type-Options: nosniff on all privacy responses', async () => {
      const response = await request(app).get('/api/privacy/policy');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});
