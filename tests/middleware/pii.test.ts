import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { privacyHeaders, safeErrorHandler } from '../../src/middleware/pii.js';

describe('PII middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const app = createApp();

  describe('privacyHeaders', () => {
    it('sets Cache-Control: no-store on every response', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sets X-Content-Type-Options: nosniff', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('advertises the privacy policy endpoint', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-privacy-policy']).toBe('/api/privacy/policy');
    });
  });

  describe('requestLogger', () => {
    it('does not leak IP addresses or auth tokens in log output', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await request(app)
        .get('/health')
        .set('Authorization', 'Bearer secret-token-123')
        .set('X-Forwarded-For', '192.168.1.42');

      const allOutput = logSpy.mock.calls.map((c) => c[0] as string).join(' ');
      expect(allOutput).not.toContain('secret-token-123');
      expect(allOutput).not.toContain('192.168.1.42');
    });
  });

  describe('safeErrorHandler', () => {
    it('returns a generic 500 without leaking internal details', async () => {
      const errorApp = express();
      errorApp.use(express.json());
      errorApp.use(privacyHeaders);
      errorApp.get('/boom', () => {
        throw new Error('sensitive internal detail');
      });
      errorApp.use(safeErrorHandler);

      const res = await request(errorApp).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      expect(JSON.stringify(res.body)).not.toContain('sensitive internal detail');
    });
  });
});
