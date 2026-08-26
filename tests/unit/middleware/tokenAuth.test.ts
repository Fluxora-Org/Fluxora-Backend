/**
 * Edge-case tests for src/middleware/tokenAuth.ts — createBearerTokenAuth.
 *
 * Covers the implicit edge-case behaviour that was previously untested:
 *  1. required=false with no token configured → middleware is a no-op (passes all requests).
 *  2. required=false with a token configured → auth is enforced.
 *  3. required=true with no token configured → service-unavailable error (fail-closed).
 *  4. Empty bearer value in Authorization header (e.g., "Bearer ").
 *  5. Whitespace-only bearer value (e.g., "Bearer    ").
 *  6. Missing Authorization header entirely when auth is enforced.
 *  7. Mismatched bearer token → 401 unauthorized.
 *  8. Correct bearer token → passes through.
 *  9. Non-Bearer Authorization scheme → 401 unauthorized.
 * 10. Token with surrounding whitespace in Authorization header (getBearerToken trims value).
 */

import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createBearerTokenAuth } from '../../../src/middleware/tokenAuth.js';
import { errorHandler } from '../../../src/middleware/errorHandler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(options: Parameters<typeof createBearerTokenAuth>[0]) {
  const app = express();
  app.use(express.json());
  app.use(createBearerTokenAuth(options));
  app.get('/protected', (_req: Request, res: Response) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createBearerTokenAuth — required=false with no token configured', () => {
  // When required=false and no token is provided, auth is disabled entirely.
  // Every request must pass regardless of Authorization header.

  it('passes request with no Authorization header', async () => {
    const app = buildApp({ role: 'partner', required: false });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('passes request with an Authorization header (auth disabled — header is ignored)', async () => {
    const app = buildApp({ role: 'partner', required: false });
    const res = await request(app).get('/protected').set('Authorization', 'Bearer any-value');
    expect(res.status).toBe(200);
  });

  it('passes request with a malformed Authorization header when auth is disabled', async () => {
    const app = buildApp({ role: 'partner', required: false });
    const res = await request(app).get('/protected').set('Authorization', 'NotBearer xyz');
    expect(res.status).toBe(200);
  });
});

describe('createBearerTokenAuth — required=false with a token configured', () => {
  // When a token is provided but required=false, auth is still enforced.
  // (authEnabled = required || Boolean(token) → true when token is set)

  const token = 'my-secret-partner-token';

  it('passes request with the correct bearer token', async () => {
    const app = buildApp({ role: 'partner', required: false, token });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('returns 401 for missing Authorization header', async () => {
    const app = buildApp({ role: 'partner', required: false, token });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong bearer token', async () => {
    const app = buildApp({ role: 'partner', required: false, token });
    const res = await request(app).get('/protected').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });
});

describe('createBearerTokenAuth — required=true with no token configured (fail-closed)', () => {
  // When required=true but token is absent, the service is misconfigured.
  // The middleware must fail closed — 503 Service Unavailable, not a silent pass.

  it('returns 503 when token is not configured', async () => {
    const app = buildApp({ role: 'administrator', required: true });
    const res = await request(app).get('/protected').set('Authorization', 'Bearer anything');
    expect(res.status).toBe(503);
  });

  it('returns 503 even when no Authorization header is present', async () => {
    const app = buildApp({ role: 'administrator', required: true });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(503);
  });
});

describe('createBearerTokenAuth — empty / whitespace bearer values', () => {
  const token = 'real-token-value';

  it('returns 401 for "Bearer " (empty bearer value after split)', async () => {
    // getBearerToken splits on space — "Bearer " yields value="" which is falsy
    const app = buildApp({ role: 'partner', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('returns 401 for "Bearer    " (whitespace-only bearer value)', async () => {
    // trim() turns "   " into "" which is treated as no token
    const app = buildApp({ role: 'partner', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', 'Bearer    ');
    expect(res.status).toBe(401);
  });

  it('returns 401 for Authorization header with just the scheme and no space', async () => {
    // "Bearer" with no space → split gives ["Bearer"], no value
    const app = buildApp({ role: 'partner', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', 'Bearer');
    expect(res.status).toBe(401);
  });
});

describe('createBearerTokenAuth — non-Bearer Authorization schemes', () => {
  const token = 'correct-token';

  it('returns 401 for Basic scheme', async () => {
    const app = buildApp({ role: 'partner', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', `Basic ${token}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for APIKey scheme', async () => {
    const app = buildApp({ role: 'partner', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', `APIKey ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('createBearerTokenAuth — correct token always passes', () => {
  it('accepts correct token and calls next() for administrator role', async () => {
    const token = 'admin-secret-token';
    const app = buildApp({ role: 'administrator', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('accepts correct token and calls next() for partner role', async () => {
    const token = 'partner-secret-token';
    const app = buildApp({ role: 'partner', required: true, token });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('createBearerTokenAuth — token with extra whitespace in Authorization header', () => {
  it('trims trailing whitespace from bearer value before comparing', async () => {
    // getBearerToken uses split(' ', 2) and then trim() on the value.
    // "Bearer correct-token  " should parse to "correct-token" after trim.
    const token = 'correct-token';
    const app = buildApp({ role: 'partner', required: true, token });
    // supertest normalizes headers; inject raw header value via a passthrough middleware
    const innerApp = express();
    innerApp.use(express.json());
    innerApp.use((req: Request, _res: Response, next) => {
      req.headers['authorization'] = `Bearer ${token}  `; // trailing spaces
      next();
    });
    innerApp.use(createBearerTokenAuth({ role: 'partner', required: true, token }));
    innerApp.get('/protected', (_req: Request, res: Response) => res.json({ ok: true }));
    innerApp.use(errorHandler);

    const res = await request(innerApp).get('/protected');
    expect(res.status).toBe(200);
  });
});
