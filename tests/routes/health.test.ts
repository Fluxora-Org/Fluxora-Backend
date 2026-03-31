import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';

describe('health routes', () => {
  describe('GET /health', () => {
    it('returns status ok with service name', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('fluxora-backend');
      expect(res.body.timestamp).toBeTruthy();
    });

    it('returns a valid ISO timestamp', async () => {
      const res = await request(app).get('/health');
      const parsed = new Date(res.body.timestamp);
      expect(parsed.toISOString()).toBe(res.body.timestamp);
    });
  });

  describe('GET /', () => {
    it('returns API info', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Fluxora API');
      expect(res.body.version).toBe('0.1.0');
    });
  });
});
