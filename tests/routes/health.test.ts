import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';

describe('health routes', () => {
  describe('GET /health', () => {
    it('returns status ok with service name', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ok');
      expect(res.body.data.service).toBe('fluxora-backend');
      expect(res.body.meta.timestamp).toBeTruthy();
    });

    it('returns a valid ISO timestamp', async () => {
      const res = await request(app).get('/health');
      const parsed = new Date(res.body.meta.timestamp);
      expect(parsed.toISOString()).toBe(res.body.meta.timestamp);
    });
  });

  describe('GET /', () => {
    it('returns API info', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Fluxora API');
      expect(res.body.data.version).toBe('0.1.0');
    });
  });
});
