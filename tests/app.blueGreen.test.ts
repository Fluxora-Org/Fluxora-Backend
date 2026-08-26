/**
 * @file tests/app.blueGreen.test.ts
 *
 * Blue/Green Deployment Slot Header Tests
 * ========================================
 *
 * Verifies every behavioural guarantee of the `deploymentSlotMiddleware`
 * defined in `src/app.ts`:
 *
 *   1. The `X-Fluxora-Deployment-Slot` header is present on **every** HTTP
 *      response, regardless of status code (2xx, 4xx, 5xx).
 *   2. The header value mirrors the `DEPLOYMENT_SLOT` environment variable.
 *   3. When `DEPLOYMENT_SLOT` is absent or empty the value falls back to
 *      `"blue"`.
 *   4. Non-conforming values (header-injection attempts, special chars) are
 *      sanitised to `"blue"`.
 *   5. The env var is read at **request time**, not at module-load time, so
 *      live mutations (e.g. during a rolling deploy) are reflected
 *      immediately.
 *   6. The header is present across all HTTP methods (GET, POST, PUT, PATCH,
 *      DELETE, HEAD, OPTIONS).
 *   7. Custom slot names that satisfy `[a-z0-9-]+` (e.g. `canary-1`,
 *      `release-2025`) are passed through unchanged.
 *
 * Coverage targets:
 *   - Lines / statements : ≥ 95 %
 *   - Branches           : ≥ 95 %
 *
 * Closes: #739
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Save and restore `DEPLOYMENT_SLOT` around each test so that tests are fully
 * isolated even when they mutate `process.env` mid-test.
 */
function useDeploymentSlot(value: string | undefined) {
  const original = process.env.DEPLOYMENT_SLOT;

  beforeEach(() => {
    if (value === undefined) {
      delete process.env.DEPLOYMENT_SLOT;
    } else {
      process.env.DEPLOYMENT_SLOT = value;
    }
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DEPLOYMENT_SLOT;
    } else {
      process.env.DEPLOYMENT_SLOT = original;
    }
  });
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('Blue/Green deployment slot header (deploymentSlotMiddleware)', () => {

  // ── 1.  Default / fallback behaviour ──────────────────────────────────────

  describe('default slot when DEPLOYMENT_SLOT is absent', () => {
    useDeploymentSlot(undefined);

    it('returns "blue" on GET /health', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });

    it('returns "blue" on GET /', async () => {
      const app = createApp();
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });

    it('returns "blue" on an unknown route (404)', async () => {
      const app = createApp();
      const res = await request(app).get('/this-route-does-not-exist-xyz');
      expect(res.status).toBe(404);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });
  });

  describe('default slot when DEPLOYMENT_SLOT is an empty string', () => {
    useDeploymentSlot('');

    it('falls back to "blue" for an empty string', async () => {
      // An empty string does not match /^[a-z0-9-]+$/i, so the middleware
      // must sanitise it to the default "blue".
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });
  });

  // ── 2.  Explicit slot values ───────────────────────────────────────────────

  describe('DEPLOYMENT_SLOT=blue', () => {
    useDeploymentSlot('blue');

    it('header is "blue" on GET /health', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });

    it('header is "blue" on GET /health/live', async () => {
      const app = createApp();
      const res = await request(app).get('/health/live');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });
  });

  describe('DEPLOYMENT_SLOT=green', () => {
    useDeploymentSlot('green');

    it('header is "green" on GET /health', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
    });

    it('header is "green" on GET /health/live', async () => {
      const app = createApp();
      const res = await request(app).get('/health/live');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
    });

    it('header is "green" on GET /', async () => {
      const app = createApp();
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
    });

    it('header is "green" on a 404 response', async () => {
      const app = createApp();
      const res = await request(app).get('/nonexistent-route-xyz');
      expect(res.status).toBe(404);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
    });
  });

  // ── 3.  Custom / canary slot names ────────────────────────────────────────

  describe('custom slot names conforming to [a-z0-9-]+', () => {
    const cases: string[] = ['canary-1', 'release-2025', 'hotfix', 'v2', 'BLUE'];

    for (const slot of cases) {
      it(`passes through "${slot}" unchanged`, async () => {
        process.env.DEPLOYMENT_SLOT = slot;
        const app = createApp();
        const res = await request(app).get('/health');
        expect(res.headers['x-fluxora-deployment-slot']).toBe(slot);
        delete process.env.DEPLOYMENT_SLOT;
      });
    }
  });

  // ── 4.  Header-injection / sanitisation ───────────────────────────────────

  describe('header injection prevention', () => {
    const injectionCases: Array<{ label: string; value: string }> = [
      {
        label: 'CRLF injection',
        value: 'blue\r\nX-Evil-Header: injected',
      },
      {
        label: 'LF injection',
        value: 'blue\nX-Evil-Header: injected',
      },
      {
        label: 'null byte',
        value: 'blue\x00green',
      },
      {
        label: 'space in value',
        value: 'blue green',
      },
      {
        label: 'semicolon',
        value: 'blue;green',
      },
      {
        label: 'angle brackets',
        value: '<script>',
      },
      {
        label: 'unicode',
        value: 'blüe',
      },
    ];

    for (const { label, value } of injectionCases) {
      it(`sanitises "${label}" to "blue"`, async () => {
        process.env.DEPLOYMENT_SLOT = value;
        const app = createApp();
        const res = await request(app).get('/health');
        // Must fall back to "blue" — no injection characters allowed
        expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
        // Must not introduce a new injected header
        expect(res.headers['x-evil-header']).toBeUndefined();
        delete process.env.DEPLOYMENT_SLOT;
      });
    }
  });

  // ── 5.  Runtime env-var mutation (reads at request time) ─────────────────

  describe('reads DEPLOYMENT_SLOT at request time, not module-load time', () => {
    it('reflects an env change between requests on the same app instance', async () => {
      process.env.DEPLOYMENT_SLOT = 'blue';
      const app = createApp();

      const res1 = await request(app).get('/health');
      expect(res1.headers['x-fluxora-deployment-slot']).toBe('blue');

      // Simulate an in-place slot switch (e.g. live env override in k8s)
      process.env.DEPLOYMENT_SLOT = 'green';

      const res2 = await request(app).get('/health');
      expect(res2.headers['x-fluxora-deployment-slot']).toBe('green');

      delete process.env.DEPLOYMENT_SLOT;
    });

    it('falls back to "blue" if env var is deleted between requests', async () => {
      process.env.DEPLOYMENT_SLOT = 'green';
      const app = createApp();

      const res1 = await request(app).get('/health');
      expect(res1.headers['x-fluxora-deployment-slot']).toBe('green');

      delete process.env.DEPLOYMENT_SLOT;

      const res2 = await request(app).get('/health');
      expect(res2.headers['x-fluxora-deployment-slot']).toBe('blue');
    });
  });

  // ── 6.  Header present across HTTP methods ────────────────────────────────

  describe('header is emitted for all HTTP methods', () => {
    beforeEach(() => {
      process.env.DEPLOYMENT_SLOT = 'blue';
    });

    afterEach(() => {
      delete process.env.DEPLOYMENT_SLOT;
    });

    it('GET /health', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBeDefined();
    });

    it('HEAD /health', async () => {
      const app = createApp();
      const res = await request(app).head('/health');
      // HEAD responses have headers but no body
      expect(res.headers['x-fluxora-deployment-slot']).toBeDefined();
    });

    it('OPTIONS /health', async () => {
      const app = createApp();
      const res = await request(app).options('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBeDefined();
    });

    it('POST to a non-existent route returns 404 with header', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/nonexistent-xyz')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' });
      expect(res.status).toBe(404);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });

    it('PUT to a non-existent route returns 404 with header', async () => {
      const app = createApp();
      const res = await request(app)
        .put('/nonexistent-xyz')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' });
      expect(res.status).toBe(404);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });

    it('PATCH to a non-existent route returns 404 with header', async () => {
      const app = createApp();
      const res = await request(app)
        .patch('/nonexistent-xyz')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' });
      expect(res.status).toBe(404);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });

    it('DELETE to a non-existent route returns 404 with header', async () => {
      const app = createApp();
      const res = await request(app).delete('/nonexistent-xyz');
      expect(res.status).toBe(404);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    });
  });

  // ── 7.  Header present on 5xx responses ──────────────────────────────────

  describe('header is emitted on 5xx error responses', () => {
    beforeEach(() => {
      process.env.DEPLOYMENT_SLOT = 'green';
    });

    afterEach(() => {
      delete process.env.DEPLOYMENT_SLOT;
    });

    it('500 from a thrown error carries the deployment slot header', async () => {
      // includeTestRoutes mounts GET /__test/error which always throws.
      const app = createApp({ includeTestRoutes: true });
      const res = await request(app).get('/__test/error');
      expect(res.status).toBe(500);
      expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
    });
  });

  // ── 8.  Header consistency across multiple requests ───────────────────────

  describe('header consistency across concurrent requests', () => {
    it('returns the same slot for many simultaneous requests', async () => {
      process.env.DEPLOYMENT_SLOT = 'blue';
      const app = createApp();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => request(app).get('/health')),
      );

      for (const res of responses) {
        expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
      }

      delete process.env.DEPLOYMENT_SLOT;
    });
  });

  // ── 9.  Header value is not overrideable by clients ───────────────────────

  describe('client cannot spoof the deployment slot header', () => {
    it('the server-side value always wins over a client-supplied header', async () => {
      process.env.DEPLOYMENT_SLOT = 'blue';
      const app = createApp();

      const res = await request(app)
        .get('/health')
        // Attacker tries to pre-set the slot header
        .set('X-Fluxora-Deployment-Slot', 'evil-slot');

      // Response header must reflect the server env, not the client request
      expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');

      delete process.env.DEPLOYMENT_SLOT;
    });
  });

  // ── 10.  app.ts exports ───────────────────────────────────────────────────

  describe('module exports', () => {
    it('createApp returns an Express application', async () => {
      const app = createApp();
      // Express apps expose a `listen` function
      expect(typeof app.listen).toBe('function');
    });

    it('default export (app) is also a valid Express application', async () => {
      // The default export is the singleton created by `createApp()` at the
      // bottom of app.ts — it must also expose the slot header.
      const { default: defaultApp } = await import('../src/app.js');
      process.env.DEPLOYMENT_SLOT = 'blue';
      const res = await request(defaultApp).get('/health');
      expect(res.headers['x-fluxora-deployment-slot']).toBeDefined();
      delete process.env.DEPLOYMENT_SLOT;
    });
  });

  // ── 11.  Regression: header key casing ───────────────────────────────────

  describe('header name casing (regression guard)', () => {
    it('header is accessible under lowercase key (HTTP/2 canonical form)', async () => {
      process.env.DEPLOYMENT_SLOT = 'green';
      const app = createApp();
      const res = await request(app).get('/health');
      // supertest normalises header names to lowercase; assert the lowercase key
      expect(res.headers).toHaveProperty('x-fluxora-deployment-slot');
      expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
      delete process.env.DEPLOYMENT_SLOT;
    });
  });
});
