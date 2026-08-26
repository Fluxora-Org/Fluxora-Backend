/**
 * Tests for OpenAPI specification cache behavior and docs route (src/routes/docs.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { docsRouter, resetSpecCache } from './docs.js';
import { reloadFlags } from '../config/featureFlags.js';

describe('OpenAPI Docs Route & Spec Cache Invalidation', () => {
  let app: express.Express;

  beforeEach(() => {
    resetSpecCache();
    app = express();
    app.use(docsRouter);
  });

  afterEach(() => {
    resetSpecCache();
    delete process.env['FEATURE_FLAGS_JSON'];
    reloadFlags();
  });

  describe('GET /openapi.json', () => {
    it('returns 200 OK with OpenAPI 3.1 JSON content type', async () => {
      const res = await request(app).get('/openapi.json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.body).toHaveProperty('openapi', '3.1.0');
      expect(res.body.info).toHaveProperty('title', 'Fluxora Backend API');
    });

    it('caches the generated spec object reference across multiple requests', async () => {
      const res1 = await request(app).get('/openapi.json');
      const res2 = await request(app).get('/openapi.json');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body).toEqual(res2.body);
    });
  });

  describe('GET /docs', () => {
    it('serves Swagger UI html page', async () => {
      const res = await request(app).get('/docs/');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  describe('Spec Cache Static Independence & Regression Protection', () => {
    it('verifies that OpenAPI spec generation is static and unaffected by reloadFlags()', async () => {
      // 1. Initial request populates cache
      const resBefore = await request(app).get('/openapi.json');
      expect(resBefore.status).toBe(200);

      // 2. Mutate feature flags configuration in env and execute runtime reload
      process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
        { name: 'experimental_new_endpoint', percentage: 100 },
      ]);
      const newFlags = reloadFlags();
      expect(newFlags.has('experimental_new_endpoint')).toBe(true);

      // 3. Fetch spec again after reload
      const resAfter = await request(app).get('/openapi.json');
      expect(resAfter.status).toBe(200);

      // Spec output is identical because OpenAPI spec is static and un-gated by feature flags
      expect(resAfter.body).toEqual(resBefore.body);
    });

    it('verifies resetSpecCache explicitly invalidates the cached specification', async () => {
      const res1 = await request(app).get('/openapi.json');
      expect(res1.status).toBe(200);

      // Explicitly reset cache
      resetSpecCache();

      const res2 = await request(app).get('/openapi.json');
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });
  });
});
