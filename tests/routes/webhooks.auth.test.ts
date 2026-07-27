/**
 * Tests for webhook route authentication (Issue #838)
 *
 * Asserts:
 *  - Every non-/receive route returns 401 with no credentials
 *  - Every non-/receive route returns 403 with invalid credentials
 *  - Every non-/receive route returns a 2xx (or non-auth error) with valid admin credentials
 *  - POST /receive remains publicly accessible (HMAC-verified only, no Bearer token needed)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter } from '../../src/routes/webhooks.js';
import { webhookDeliveryStore } from '../../src/webhooks/storeFactory.js';
import { computeWebhookSignature } from '../../src/webhooks/signature.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key-webhook-auth-838';
const WEBHOOK_SECRET = 'test-webhook-secret-for-receive';
const BASE = '/internal/webhooks';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal express app that mounts only the webhooks router. */
function buildApp() {
  const app = express();
  app.use(BASE, webhooksRouter);
  return app;
}

/** Returns supertest agent that adds a valid Bearer token. */
function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

/** Returns supertest agent with an invalid Bearer token. */
function badAuth(req: request.Test): request.Test {
  return req.set('Authorization', 'Bearer wrong-key');
}

/** Build a valid signed receive request. */
function makeReceiveHeaders(overrides: Record<string, string> = {}) {
  const now = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ event: 'stream.created', streamId: 'stream-1' });
  const sig = computeWebhookSignature(WEBHOOK_SECRET, now, body);
  return {
    body,
    headers: {
      'x-fluxora-delivery-id': `deliv-auth-test-${Date.now()}`,
      'x-fluxora-timestamp': now,
      'x-fluxora-signature': sig,
      'x-fluxora-event': 'stream.created',
      ...overrides,
    } as Record<string, string>,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const app = buildApp();

// ── Setup / teardown ──────────────────────────────────────────────────────────

let originalAdminKey: string | undefined;
let originalWebhookSecret: string | undefined;

beforeEach(() => {
  originalAdminKey = process.env.ADMIN_API_KEY;
  originalWebhookSecret = process.env.FLUXORA_WEBHOOK_SECRET;

  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.FLUXORA_WEBHOOK_SECRET = WEBHOOK_SECRET;

  webhookDeliveryStore.clear();
});

afterEach(() => {
  if (originalAdminKey !== undefined) {
    process.env.ADMIN_API_KEY = originalAdminKey;
  } else {
    delete process.env.ADMIN_API_KEY;
  }
  if (originalWebhookSecret !== undefined) {
    process.env.FLUXORA_WEBHOOK_SECRET = originalWebhookSecret;
  } else {
    delete process.env.FLUXORA_WEBHOOK_SECRET;
  }
});

// ── /receive stays public ─────────────────────────────────────────────────────

describe('POST /internal/webhooks/receive — remains public (no admin token)', () => {
  it('accepts a validly-signed delivery without any Authorization header', async () => {
    const { body, headers } = makeReceiveHeaders();
    const res = await request(app)
      .post(`${BASE}/receive`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects a bad signature (HMAC failure, not auth failure)', async () => {
    const { body, headers } = makeReceiveHeaders({ 'x-fluxora-signature': 'badbadbadbad' });
    const res = await request(app)
      .post(`${BASE}/receive`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);
    // 401 from HMAC failure, NOT from the admin-auth middleware
    expect(res.status).toBe(401);
    expect(res.body.error).not.toBeUndefined();
  });

  it('does NOT require a Bearer token even when ADMIN_API_KEY is set', async () => {
    const { body, headers } = makeReceiveHeaders();
    const res = await request(app)
      .post(`${BASE}/receive`)
      .set(headers)
      // Deliberately no Authorization header
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });
});

// ── Secret-based auth regression tests ──────────────────────────────────────

describe('Protected webhook routes do not trust caller-supplied secrets', () => {
  it('rejects /process-outbox when only a bogus secret is supplied', async () => {
    const res = await request(app)
      .post(`${BASE}/process-outbox`)
      .set('Content-Type', 'application/json')
      .query({ secret: 'not-the-admin-key' })
      .send({});

    expect(res.status).toBe(401);
  });

  it('rejects /retry when only a bogus secret is supplied', async () => {
    const res = await request(app)
      .post(`${BASE}/retry`)
      .set('Content-Type', 'application/json')
      .query({ secret: 'not-the-admin-key' })
      .send({ secret: 'not-the-admin-key' });

    expect(res.status).toBe(401);
  });

  it('rejects /dlq/:dlqId/retry when only a bogus secret is supplied', async () => {
    const res = await request(app)
      .post(`${BASE}/dlq/nonexistent/retry`)
      .set('Content-Type', 'application/json')
      .send({ secret: 'not-the-admin-key' });

    expect(res.status).toBe(401);
  });
});

// ── Auth gate matrix ──────────────────────────────────────────────────────────
//
// For each protected endpoint we verify:
//   1. No credentials  → 401
//   2. Bad credentials → 403
//   3. Good credentials → NOT 401 and NOT 403

interface RouteCase {
  method: 'get' | 'post';
  path: string;
  /** Body to send (for POST requests that need content). */
  body?: Record<string, unknown>;
}

const protectedRoutes: RouteCase[] = [
  { method: 'get',  path: '/deliveries' },
  { method: 'get',  path: '/deliveries/nonexistent-id' },
  { method: 'get',  path: '/outbox' },
  { method: 'get',  path: '/dlq' },
  { method: 'get',  path: '/circuit-breakers' },
  { method: 'get',  path: '/metrics' },
  { method: 'post', path: '/queue',           body: {} },
  { method: 'post', path: '/dlq/nonexistent/retry', body: { secret: 'x' } },
  { method: 'post', path: '/circuit-breakers/https%3A%2F%2Fexample.com/reset' },
  // NOTE: /verify is intentionally excluded from the "valid auth → not 401/403" matrix
  // because the endpoint itself returns 401 when the webhook signature is invalid —
  // that is a feature, not an auth failure. It is tested separately below.
  { method: 'post', path: '/process-outbox',  body: {} },
  { method: 'post', path: '/retry',           body: {} },
  { method: 'post', path: '/cleanup',         body: {} },
];

describe('Protected routes — unauthenticated → 401', () => {
  for (const route of protectedRoutes) {
    it(`${route.method.toUpperCase()} ${BASE}${route.path}`, async () => {
      const req = request(app)[route.method](`${BASE}${route.path}`)
        .set('Content-Type', 'application/json');
      const res = await (route.body !== undefined ? req.send(route.body) : req);
      expect(res.status).toBe(401);
    });
  }
});

describe('Protected routes — bad credentials → 403', () => {
  for (const route of protectedRoutes) {
    it(`${route.method.toUpperCase()} ${BASE}${route.path}`, async () => {
      const base = request(app)[route.method](`${BASE}${route.path}`)
        .set('Content-Type', 'application/json');
      const authedReq = badAuth(base);
      const res = await (route.body !== undefined ? authedReq.send(route.body) : authedReq);
      expect(res.status).toBe(403);
    });
  }
});

describe('Protected routes — valid admin credentials → not 401/403', () => {
  for (const route of protectedRoutes) {
    it(`${route.method.toUpperCase()} ${BASE}${route.path}`, async () => {
      const base = request(app)[route.method](`${BASE}${route.path}`)
        .set('Content-Type', 'application/json');
      const authedReq = authed(base);
      const res = await (route.body !== undefined ? authedReq.send(route.body) : authedReq);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  }
});

// ── Auth gate when ADMIN_API_KEY is not configured ────────────────────────────

describe('Protected routes — ADMIN_API_KEY not set → 503 (fail-closed)', () => {
  beforeEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it('GET /deliveries returns 503 when admin key is unconfigured', async () => {
    const res = await request(app)
      .get(`${BASE}/deliveries`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
  });

  it('POST /process-outbox returns 503 when admin key is unconfigured', async () => {
    const res = await request(app)
      .post(`${BASE}/process-outbox`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(503);
  });

  it('POST /receive still works without admin key (HMAC-only auth)', async () => {
    const { body, headers } = makeReceiveHeaders();
    const res = await request(app)
      .post(`${BASE}/receive`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);
    // /receive does not use requireAdminAuth, so should still work
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── /verify auth tests (excluded from generic matrix — explained above) ──────

describe('POST /verify — auth gate', () => {
  it('returns 401 when no credentials are provided', async () => {
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 when bad credentials are provided', async () => {
    const res = await badAuth(
      request(app)
        .post(`${BASE}/verify`)
        .set('Content-Type', 'application/json')
    ).send({});
    expect(res.status).toBe(403);
  });

  it('passes the auth gate with valid admin credentials (may return 401 for bad sig)', async () => {
    // With valid admin auth, the request reaches the handler. Without a valid
    // webhook signature the handler itself returns 401 — that is the expected
    // signature-verification 401, not the auth-gate 401.
    const res = await authed(
      request(app)
        .post(`${BASE}/verify`)
        .set('Content-Type', 'application/json')
    ).send({});
    // 401 here means signature failed (handler reached), not auth rejection.
    // The admin auth layer never returned 403, so we only assert not 403.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });
});

// ── Functional smoke tests with valid auth ────────────────────────────────────

describe('GET /deliveries — functional', () => {
  it('returns an empty deliveries list initially', async () => {
    const res = await authed(request(app).get(`${BASE}/deliveries`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.deliveries).toEqual([]);
  });
});

describe('GET /outbox — functional', () => {
  it('returns an empty outbox', async () => {
    const res = await authed(request(app).get(`${BASE}/outbox`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe('GET /dlq — functional', () => {
  it('returns an empty DLQ', async () => {
    const res = await authed(request(app).get(`${BASE}/dlq`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe('GET /metrics — functional', () => {
  it('returns metric fields', async () => {
    const res = await authed(request(app).get(`${BASE}/metrics`));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalDeliveries');
    expect(res.body).toHaveProperty('successRate');
    expect(res.body).toHaveProperty('failureRate');
  });
});

describe('GET /circuit-breakers — functional', () => {
  it('returns empty states without endpointUrl param', async () => {
    const res = await authed(request(app).get(`${BASE}/circuit-breakers`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe('POST /process-outbox — functional', () => {
  it('processes an empty outbox successfully with valid auth', async () => {
    const res = await authed(
      request(app)
        .post(`${BASE}/process-outbox`)
        .set('Content-Type', 'application/json')
        .send({})
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(0);
  });

  it('processes outbox items and removes them', async () => {
    // Seed the outbox
    webhookDeliveryStore.addToOutbox({
      deliveryId: 'deliv_test_001',
      eventId: 'event_001',
      eventType: 'stream.created',
      endpointUrl: 'https://example.com/webhook',
      payload: '{"test": true}',
      secret: 'secret123',
      priority: 'normal',
      createdAt: Date.now(),
      scheduledFor: Date.now() - 1000, // Already due
      attempts: 0,
      maxAttempts: 5,
    });

    const res = await authed(
      request(app)
        .post(`${BASE}/process-outbox`)
        .set('Content-Type', 'application/json')
        .send({})
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(1);
    expect(res.body.total).toBe(1);
  });
});

describe('POST /retry — functional', () => {
  it('returns success with valid auth', async () => {
    const res = await authed(
      request(app)
        .post(`${BASE}/retry`)
        .set('Content-Type', 'application/json')
        .send({ secret: '' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

describe('POST /cleanup — functional', () => {
  it('returns cleaned count with valid auth', async () => {
    const res = await authed(
      request(app)
        .post(`${BASE}/cleanup`)
        .set('Content-Type', 'application/json')
        .send({ olderThanDays: 7 })
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('cleaned');
  });
});

describe('POST /queue — functional', () => {
  it('returns 400 when missing required fields', async () => {
    const res = await authed(
      request(app)
        .post(`${BASE}/queue`)
        .set('Content-Type', 'application/json')
        .send({})
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /dlq/:dlqId/retry — functional', () => {
  it('returns 404 for a non-existent DLQ item', async () => {
    const res = await authed(
      request(app)
        .post(`${BASE}/dlq/nonexistent-dlq-id/retry`)
        .set('Content-Type', 'application/json')
        .send({ secret: 'mysecret' })
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /circuit-breakers/:endpointUrl/reset — functional', () => {
  it('resets the circuit breaker and returns 200', async () => {
    const encodedUrl = encodeURIComponent('https://example.com/hook');
    const res = await authed(
      request(app).post(`${BASE}/circuit-breakers/${encodedUrl}/reset`)
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /deliveries/:deliveryId — functional', () => {
  it('returns 404 for a non-existent delivery id', async () => {
    const res = await authed(
      request(app).get(`${BASE}/deliveries/nonexistent-delivery-id`)
    );
    expect(res.status).toBe(404);
  });
});

// ── No more ad-hoc secret checks on process-outbox / retry ───────────────────

describe('Removal of ad-hoc secret checks', () => {
  it('POST /process-outbox no longer requires ?secret= query param', async () => {
    // With valid admin auth and NO ?secret= param, should succeed
    const res = await authed(
      request(app)
        .post(`${BASE}/process-outbox`)
        .set('Content-Type', 'application/json')
        .send({})
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /retry no longer requires ?secret= query param', async () => {
    // With valid admin auth and NO ?secret= query param, should succeed
    const res = await authed(
      request(app)
        .post(`${BASE}/retry`)
        .set('Content-Type', 'application/json')
        .send({})
    );
    expect(res.status).toBe(200);
  });

  it('POST /process-outbox without auth returns 401 even with ?secret=present', async () => {
    const res = await request(app)
      .post(`${BASE}/process-outbox?secret=whatever`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(401);
  });

  it('POST /retry without auth returns 401 even with ?secret=present', async () => {
    const res = await request(app)
      .post(`${BASE}/retry?secret=whatever`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(401);
  });
});
