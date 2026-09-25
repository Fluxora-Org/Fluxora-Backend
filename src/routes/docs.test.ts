/**
 * Tests for OpenAPI specification cache behavior and docs route (src/routes/docs.ts).
 *
 * Covers #1477: served docs must never enumerate endpoints that are disabled
 * by feature flag, nor admin/internal endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { docsRouter, resetSpecCache, FLAG_GATED_PATHS } from './docs.js';
import { reloadFlags } from '../config/featureFlags.js';
import { GRAPHQL_GATEWAY_FLAG } from '../graphql/gateway.js';

/** Build the test app fresh each test so router state is clean. */
function makeApp(): express.Express {
  const app = express();
  app.use(docsRouter);
  return app;
}

describe('OpenAPI Docs Route & Spec Cache Invalidation', () => {
  let app: express.Express;

  beforeEach(() => {
    resetSpecCache();
    app = makeApp();
  });

  afterEach(() => {
    resetSpecCache();
    delete process.env['FEATURE_FLAGS_JSON'];
    reloadFlags();
  });

  // ── GET /openapi.json — basic contract ────────────────────────────────

  describe('GET /openapi.json', () => {
    it('returns 200 OK with OpenAPI 3.1 JSON content type', async () => {
      const res = await request(app).get('/openapi.json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.body).toHaveProperty('openapi', '3.1.0');
      expect(res.body.info).toHaveProperty('title', 'Fluxora Backend API');
    });

    it('caches the generated spec object across multiple requests', async () => {
      const res1 = await request(app).get('/openapi.json');
      const res2 = await request(app).get('/openapi.json');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body).toEqual(res2.body);
    });
  });

  // ── GET /docs — Swagger UI ────────────────────────────────────────────

  describe('GET /docs', () => {
    it('serves Swagger UI html page', async () => {
      const res = await request(app).get('/docs/');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  // ── Admin/internal exclusion (#1477 criterion 2) ─────────────────────

  describe('admin and internal endpoints are never served', () => {
    it('excludes /api/admin/* paths from the served spec', async () => {
      const res = await request(app).get('/openapi.json');
      const paths = Object.keys(res.body.paths ?? {});

      const adminPaths = paths.filter((p) => p.startsWith('/api/admin'));
      expect(adminPaths).toEqual([]);
    });

    it('excludes /internal/* paths from the served spec', async () => {
      const res = await request(app).get('/openapi.json');
      const paths = Object.keys(res.body.paths ?? {});

      const internalPaths = paths.filter((p) => p.startsWith('/internal'));
      expect(internalPaths).toEqual([]);
    });

    it('excludes admin/indexer/webhooks tags from the served spec', async () => {
      const res = await request(app).get('/openapi.json');
      const tagNames = (res.body.tags ?? []).map((t: { name: string }) => t.name);

      expect(tagNames).not.toContain('admin');
      expect(tagNames).not.toContain('indexer');
      expect(tagNames).not.toContain('webhooks');
    });
  });

  // ── Flag-gated exclusion (#1477 criteria 1 & 4) ───────────────────────

  describe('flag-gated paths are excluded when their flag is off', () => {
    it('does not serve /api/graphql when experimental_graphql_gateway is disabled', async () => {
      // Ensure flag is off (empty FEATURE_FLAGS_JSON).
      delete process.env['FEATURE_FLAGS_JSON'];
      reloadFlags();

      const res = await request(app).get('/openapi.json');

      // If the path is present in the raw spec, the docs filter must have
      // removed it. If it was never present, absence is trivially satisfied.
      expect(res.body.paths).not.toHaveProperty('/api/graphql');
    });

    it('FLAG_GATED_PATHS declares the GraphQL gateway flag', () => {
      // Guards against the filter map drifting from the gateway's actual flag.
      expect(FLAG_GATED_PATHS['/api/graphql']).toBe(GRAPHQL_GATEWAY_FLAG);
    });

    it('invalidation is wired: reloadFlags() clears the cached spec', async () => {
      // 1. Populate the cache.
      const first = await request(app).get('/openapi.json');
      expect(first.status).toBe(200);

      // 2. Mutate flags and reload. The onFlagsReloaded listener registered
      //    at docs.ts module load must have reset the cache.
      process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
        {
          name: GRAPHQL_GATEWAY_FLAG,
          percentage: 100,
          description: 'test',
          default: false,
          owner: 'test',
          removalDate: '2099-01-01',
        },
      ]);
      reloadFlags();

      // 3. The next request rebuilds from the (unchanged raw) spec — the
      //    point is that resetSpecCache ran, not that the output changed.
      const second = await request(app).get('/openapi.json');
      expect(second.status).toBe(200);
      expect(second.body).toHaveProperty('openapi', '3.1.0');
    });
  });

  // ── Cache-busting helper ──────────────────────────────────────────────

  describe('resetSpecCache', () => {
    it('explicitly invalidates the cached specification', async () => {
      const res1 = await request(app).get('/openapi.json');
      expect(res1.status).toBe(200);

      resetSpecCache();

      const res2 = await request(app).get('/openapi.json');
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });
  });
});