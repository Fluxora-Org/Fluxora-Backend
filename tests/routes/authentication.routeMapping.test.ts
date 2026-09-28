/**
 * authentication.routeMapping.test.ts
 *
 * Asserts that the route-to-credential mapping documented in
 * docs/authentication.md (Section 4) matches what the live Express application
 * actually enforces.
 *
 * Strategy
 * --------
 * For every route group in the documentation we issue an HTTP request that
 * should produce a specific status code when the correct credential is absent.
 * We use the *absence* of the credential (rather than trying to supply a
 * valid one) because:
 *   - It avoids standing up real databases, Redis, or external IDPs.
 *   - A 401 / 403 / 503 response proves the guard middleware ran.
 *   - A 200 response (or 404) from an unguarded route proves the route is
 *     public, which is itself the assertion for no-auth routes.
 *
 * Credential categories tested
 * ----------------------------
 *   A. Public routes           → 200 (or non-401 non-403)
 *   B. Admin Bearer required   → 401 when Authorization is absent
 *   C. JWT Bearer required     → 401 when Authorization is absent
 *   D. Indexer worker token    → 401 when x-indexer-worker-token is absent
 *   E. HMAC-verified (webhook) → 4xx when signature headers are absent
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { Express } from 'express';

// ── App setup ─────────────────────────────────────────────────────────────────

let app: Express;
const ADMIN_KEY = 'test-route-mapping-admin-key';

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = 'test-jwt-secret-for-route-mapping-tests';
  // Disable mTLS enforcement so indexer route auth is the only gate tested.
  process.env.INDEXER_MTLS_REQUIRED = 'false';
  process.env.INDEXER_WORKER_TOKEN = 'test-indexer-worker-token-xxxxxxxxxx';
  app = createApp();
});

afterAll(() => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.JWT_SECRET;
  delete process.env.INDEXER_MTLS_REQUIRED;
  delete process.env.INDEXER_WORKER_TOKEN;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Assert a route is public (no credential required).
 * Accepts any 2xx or a 404 (route may conditionally 404 on missing data) or
 * 503 (health-check / dependency unavailable) but must NOT return 401 or 403.
 */
function expectPublic(res: { status: number }): void {
  expect(
    res.status,
    `Expected public route but got ${res.status} — the route may have gained an auth guard`,
  ).not.toBe(401);
  expect(res.status).not.toBe(403);
}

/**
 * Assert a route requires an admin Bearer token.
 * Without the token the service should return 401.
 */
function expectAdminRequired(res: { status: number }): void {
  expect(
    res.status,
    `Expected 401 for missing admin token but got ${res.status}`,
  ).toBe(401);
}

/**
 * Assert a route requires JWT Bearer authentication.
 * Without the token the service should return 401.
 */
function expectJwtRequired(res: { status: number }): void {
  expect(
    res.status,
    `Expected 401 for missing JWT but got ${res.status}`,
  ).toBe(401);
}

/**
 * Assert a route requires the indexer worker token.
 * Without the token the service should return 401.
 */
function expectIndexerTokenRequired(res: { status: number }): void {
  expect(
    res.status,
    `Expected 401 for missing indexer worker token but got ${res.status}`,
  ).toBe(401);
}

// ── Section A: Public routes (no credential required) ────────────────────────
// docs/authentication.md §4 — rows with "None" in the "Credential required"
// column.

describe('Public routes — no credential required', () => {
  it('GET /health is public', async () => {
    const res = await request(app).get('/health');
    expectPublic(res);
  });

  it('GET /health/ready is public', async () => {
    const res = await request(app).get('/health/ready');
    expectPublic(res);
  });

  it('GET /health/live is public', async () => {
    const res = await request(app).get('/health/live');
    expectPublic(res);
  });

  it('GET /health/deployment is public', async () => {
    const res = await request(app).get('/health/deployment');
    expectPublic(res);
  });

  it('GET /docs is public', async () => {
    const res = await request(app).get('/docs');
    expectPublic(res);
  });

  it('GET /api/auth/session (POST endpoint — no auth guard on GET)', async () => {
    // POST /api/auth/session has no authentication guard (only rate-limiting).
    // Sending a POST with no body should return 400 (schema validation), not 401.
    const res = await request(app)
      .post('/api/auth/session')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('GET /api/streams requires streams:read scope (JWT or API key)', async () => {
    // The GET list route applies requireScope('streams:read'), so an unauthenticated
    // request without any credential is rejected with 401.
    const res = await request(app)
      .get('/api/streams')
      .set('Accept', 'application/json');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/status/read-only is public', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expectPublic(res);
  });

  it('GET /api/privacy/policy is public', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expectPublic(res);
  });

  it('GET /api/privacy/retention is public', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expectPublic(res);
  });
});

// ── Section B: Routes requiring Admin Bearer token ────────────────────────────
// docs/authentication.md §4 — rows with "Admin Bearer (§1.3)"

describe('Admin Bearer token required', () => {
  it('GET /metrics requires admin Bearer token', async () => {
    const res = await request(app).get('/metrics');
    expectAdminRequired(res);
  });

  it('GET /api/admin/status requires admin Bearer token', async () => {
    const res = await request(app).get('/api/admin/status');
    expectAdminRequired(res);
  });

  it('GET /api/admin/pause requires admin Bearer token', async () => {
    const res = await request(app).get('/api/admin/pause');
    expectAdminRequired(res);
  });

  it('PUT /api/admin/pause requires admin Bearer token', async () => {
    const res = await request(app)
      .put('/api/admin/pause')
      .set('Content-Type', 'application/json')
      .send({ streamCreation: true });
    expectAdminRequired(res);
  });

  it('GET /api/admin/reindex requires admin Bearer token', async () => {
    const res = await request(app).get('/api/admin/reindex');
    expectAdminRequired(res);
  });

  it('POST /api/admin/reindex requires admin Bearer token', async () => {
    const res = await request(app)
      .post('/api/admin/reindex')
      .set('Content-Type', 'application/json');
    expectAdminRequired(res);
  });

  it('GET /api/admin/api-keys requires admin Bearer token', async () => {
    const res = await request(app).get('/api/admin/api-keys');
    expectAdminRequired(res);
  });

  it('POST /api/admin/api-keys requires admin Bearer token', async () => {
    const res = await request(app)
      .post('/api/admin/api-keys')
      .set('Content-Type', 'application/json')
      .send({ name: 'test' });
    expectAdminRequired(res);
  });

  it('DELETE /api/admin/api-keys/:id requires admin Bearer token', async () => {
    const res = await request(app).delete('/api/admin/api-keys/some-id');
    expectAdminRequired(res);
  });

  it('GET /api/admin/deprecations requires admin Bearer token', async () => {
    const res = await request(app).get('/api/admin/deprecations');
    expectAdminRequired(res);
  });

  it('GET /api/admin/rate-limits/overrides requires admin Bearer token', async () => {
    const res = await request(app).get('/api/admin/rate-limits/overrides');
    expectAdminRequired(res);
  });

  it('POST /api/admin/rate-limits/overrides requires admin Bearer token', async () => {
    const res = await request(app)
      .post('/api/admin/rate-limits/overrides')
      .set('Content-Type', 'application/json')
      .send({ keyId: 'k', maxRequests: 10, windowMs: 1000 });
    expectAdminRequired(res);
  });

  it('DELETE /api/admin/rate-limits/overrides/:id requires admin Bearer token', async () => {
    const res = await request(app).delete('/api/admin/rate-limits/overrides/some-id');
    expectAdminRequired(res);
  });

  it('DELETE /api/privacy/erasure/:address requires admin Bearer token', async () => {
    const res = await request(app).delete('/api/privacy/erasure/GABC1234');
    expectAdminRequired(res);
  });

  it('GET /internal/webhooks (non-receive) routes require admin Bearer token', async () => {
    const res = await request(app).get('/internal/webhooks/outbox');
    expectAdminRequired(res);
  });
});

// ── Section C: Routes requiring JWT Bearer token ──────────────────────────────
// docs/authentication.md §4 — rows with "JWT Bearer (§1.1)" only

describe('JWT Bearer token required', () => {
  it('GET /api/streams requires streams:read scope (JWT or API key)', async () => {
    // The GET list route applies requireScope('streams:read'), so an unauthenticated
    // request without any credential is rejected with 401.
    const res = await request(app)
      .get('/api/streams')
      .set('Accept', 'application/json');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/revoke requires JWT with admin:pause permission', async () => {
    const res = await request(app)
      .post('/api/auth/revoke')
      .set('Content-Type', 'application/json')
      .send({ jti: 'abc', exp: Math.floor(Date.now() / 1000) + 3600 });
    // requirePermission checks req.user first; no user → 401
    expect(res.status).toBe(401);
  });

  it('POST /api/streams requires authentication (JWT or API key)', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'test-key-123')
      .send({
        sender: 'GABC1234',
        recipient: 'GXYZ5678',
        amount: '10.0000000',
        token: 'XLM',
        startTime: new Date().toISOString(),
        duration: 3600,
      });
    // No credential → 401
    expect(res.status).toBe(401);
  });

  it('GET /admin/dlq requires authentication', async () => {
    const res = await request(app).get('/admin/dlq');
    expect(res.status).toBe(401);
  });

  it('GET /admin/dlq/:id requires authentication', async () => {
    const res = await request(app).get('/admin/dlq/dlq-123');
    expect(res.status).toBe(401);
  });

  it('DELETE /admin/dlq/:id requires authentication', async () => {
    const res = await request(app).delete('/admin/dlq/dlq-123');
    expect(res.status).toBe(401);
  });

  it('GET /api/audit requires authentication', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
  });

  it('GET /api/audit/export requires authentication', async () => {
    const res = await request(app).get('/api/audit/export');
    expect(res.status).toBe(401);
  });

  it('POST /internal/indexer/events/replay requires JWT authentication', async () => {
    // This route requires JWT + INDEXER_REPLAY permission (not the worker token).
    // Without any credential → 401.
    const res = await request(app)
      .post('/internal/indexer/events/replay')
      .set('Content-Type', 'application/json')
      .set('x-indexer-worker-token', 'test-indexer-worker-token-xxxxxxxxxx') // provide worker token
      .send({ contract_id: 'c', ledger: 1, from_block: 1, to_block: 2 });
    // Worker token is not valid for this endpoint — needs JWT instead.
    // authenticate() will find no JWT and leave req.user unset → requireAuth → 401
    expect(res.status).toBe(401);
  });

  it('GET /internal/indexer/status requires JWT authentication', async () => {
    const res = await request(app)
      .get('/internal/indexer/status')
      .set('x-indexer-worker-token', 'test-indexer-worker-token-xxxxxxxxxx');
    // Worker token provided but still needs JWT → 401
    expect(res.status).toBe(401);
  });
});

// ── Section D: Routes requiring indexer worker token ─────────────────────────
// docs/authentication.md §4 — rows with "Indexer Worker Token (§1.7)"

describe('Indexer worker token required', () => {
  it('POST /internal/indexer/contract-events requires x-indexer-worker-token', async () => {
    const res = await request(app)
      .post('/internal/indexer/contract-events')
      .set('Content-Type', 'application/json')
      .send({ events: [] });
    expectIndexerTokenRequired(res);
  });

  it('GET /internal/indexer/events requires x-indexer-worker-token', async () => {
    const res = await request(app).get('/internal/indexer/events');
    expectIndexerTokenRequired(res);
  });

  it('GET /internal/indexer/events/replay requires x-indexer-worker-token', async () => {
    const res = await request(app).get('/internal/indexer/events/replay');
    expectIndexerTokenRequired(res);
  });
});

// ── Section E: Webhook HMAC verification ─────────────────────────────────────
// docs/authentication.md §4 — POST /internal/webhooks/receive

describe('Webhook inbound HMAC verification', () => {
  it('POST /internal/webhooks/receive without signature headers returns 4xx', async () => {
    // The route uses express.raw({ type: '*/*' }) so we send raw bytes.
    // Without valid x-fluxora-signature headers the preflight/signature check rejects.
    const res = await request(app)
      .post('/internal/webhooks/receive')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(JSON.stringify({ event: 'test' })));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ── Section F: Documented admin-only routes accept valid admin token ──────────
// Positive tests confirming the admin token actually grants access (not just
// that absent-token rejects; the guard must also pass through).

describe('Admin Bearer token grants access to admin routes', () => {
  it('GET /metrics returns 200 with valid admin token', async () => {
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/status returns 200 with valid admin token', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/status/read-only returns 200 without token (public)', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/pause returns 200 with valid admin token', async () => {
    const res = await request(app)
      .get('/api/admin/pause')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
  });
});
