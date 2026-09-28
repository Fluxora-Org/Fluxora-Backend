/**
 * Security headers must be present on EVERY response, not just the success
 * path. Error responses frequently render attacker-influenced content (echoed
 * paths, validation details), so an unprotected 4xx/5xx is a real exposure.
 *
 * The `assertSecurityHeaders` helper is deliberately a closed, exhaustive list
 * rather than a spot-check of two or three headers: if a header is ever dropped
 * from the helmet configuration, every assertion in this file fails loudly
 * instead of silently degrading coverage.
 */
import express from 'express';
import request from 'supertest';
import { cspNonceMiddleware, createHelmetMiddleware } from '../src/middleware/helmet.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { notFound } from '../src/errors.js';
import { _setPhase } from '../src/startup/readiness.js';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * The complete set of security headers `createHelmetMiddleware()` must emit.
 *
 * Every entry is asserted on every response this suite exercises — success,
 * handled error, unhandled error, redirect and pre-routing rejection alike.
 *
 * `valid` is a value that satisfies `expected`. The synthetic-baseline tests
 * below depend on it: without a genuinely valid value for every *other* header
 * they would throw on the placeholder instead of on the header under test, and
 * would pass for the wrong reason.
 */
const REQUIRED_SECURITY_HEADERS = [
  {
    name: 'content-security-policy',
    expected: expect.stringContaining("default-src 'self'"),
    valid: "default-src 'self'",
  },
  { name: 'cross-origin-opener-policy', expected: 'same-origin', valid: 'same-origin' },
  { name: 'cross-origin-resource-policy', expected: 'same-origin', valid: 'same-origin' },
  { name: 'origin-agent-cluster', expected: '?1', valid: '?1' },
  {
    name: 'referrer-policy',
    expected: 'strict-origin-when-cross-origin',
    valid: 'strict-origin-when-cross-origin',
  },
  {
    name: 'strict-transport-security',
    expected: 'max-age=31536000; includeSubDomains; preload',
    valid: 'max-age=31536000; includeSubDomains; preload',
  },
  { name: 'x-content-type-options', expected: 'nosniff', valid: 'nosniff' },
  { name: 'x-dns-prefetch-control', expected: 'off', valid: 'off' },
  { name: 'x-download-options', expected: 'noopen', valid: 'noopen' },
  { name: 'x-frame-options', expected: 'SAMEORIGIN', valid: 'SAMEORIGIN' },
  { name: 'x-permitted-cross-domain-policies', expected: 'none', valid: 'none' },
  { name: 'x-xss-protection', expected: '0', valid: '0' },
] as const;

/**
 * Assert the full required header set on a response.
 *
 * Every failure is labelled with the offending header name so a regression
 * points straight at the header that was dropped or changed.
 */
function assertSecurityHeaders(headers: Record<string, string>): void {
  for (const { name, expected } of REQUIRED_SECURITY_HEADERS) {
    if (typeof expected === 'string') {
      expect(headers[name], `missing or wrong value for security header "${name}"`).toBe(expected);
    } else {
      expect(headers[name], `missing or wrong value for security header "${name}"`).toEqual(expected);
    }
  }
}

/** A header set that satisfies every requirement — used as the baseline. */
function allSecurityHeadersValidExcept(omit?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { name, valid } of REQUIRED_SECURITY_HEADERS) {
    if (name !== omit) headers[name] = valid;
  }
  return headers;
}

/** Minimal app mirroring the production mount order: nonce, then helmet. */
function buildApp(): express.Application {
  const app = express();
  app.use(cspNonceMiddleware);
  app.use(createHelmetMiddleware());
  return app;
}

describe('createHelmetMiddleware', () => {
  describe('header presence across response types', () => {
    it('applies the full header set to a success response', async () => {
      const app = buildApp();
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get('/ok').expect(200);

      assertSecurityHeaders(res.headers);
    });

    it('applies the full header set to a handled error response', async () => {
      const app = buildApp();
      app.get('/handled', (_req, _res, next) => {
        next(notFound('The requested resource was'));
      });
      app.use(errorHandler);

      const res = await request(app).get('/handled').expect(404);

      assertSecurityHeaders(res.headers);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('applies the full header set to an unhandled error response', async () => {
      const app = buildApp();
      app.get('/unhandled', () => {
        throw new Error('Intentional test error');
      });
      app.use(errorHandler);

      const res = await request(app).get('/unhandled').expect(500);

      assertSecurityHeaders(res.headers);
      // The raw message must not leak — and the response is still hardened.
      expect(JSON.stringify(res.body)).not.toContain('Intentional test error');
    });

    it('applies the full header set to a redirect response', async () => {
      const app = buildApp();
      app.get('/redirect', (_req, res) => {
        res.redirect(302, '/ok');
      });
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get('/redirect').expect(302);

      expect(res.headers.location).toBe('/ok');
      assertSecurityHeaders(res.headers);
    });

    it('applies the full header set to a 404 produced by the catch-all', async () => {
      const app = buildApp();
      app.use((_req, _res, next) => {
        next(notFound('The requested resource was'));
      });
      app.use(errorHandler);

      const res = await request(app).get('/nope').expect(404);

      assertSecurityHeaders(res.headers);
    });
  });

  describe('responses produced before routing', () => {
    it('applies headers when middleware answers before any route matches', async () => {
      // Simulates the production mount order for early-reject middleware such
      // as readinessGuardMiddleware(): it terminates the request, so nothing
      // downstream (including the routers) ever runs.
      const app = express();
      app.use(cspNonceMiddleware);
      app.use(createHelmetMiddleware());
      app.use((_req, res) => {
        res.status(503).json({ status: 'unavailable' });
      });
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get('/ok').expect(503);

      assertSecurityHeaders(res.headers);
    });

    it('applies headers to a rejected request body before the route runs', async () => {
      const app = buildApp();
      app.use(express.json({ limit: '10b' }));
      app.post('/write', (_req, res) => {
        res.status(201).json({ ok: true });
      });
      app.use(errorHandler);

      const res = await request(app)
        .post('/write')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ blob: 'x'.repeat(500) }))
        .expect(413);

      assertSecurityHeaders(res.headers);
    });

    it('applies headers to the readiness guard 503 raised by the real app', async () => {
      const { createApp } = await import('../src/app.js');
      const app = createApp({ includeTestRoutes: true });

      // Drive the startup phase out of READY so readinessGuardMiddleware()
      // answers 503 itself — a response produced before any router runs.
      _setPhase('INITIALIZING');
      try {
        const res = await request(app).get('/health').expect(503);

        expect(res.body.status).toBe('unavailable');
        assertSecurityHeaders(res.headers);
      } finally {
        _setPhase('READY');
      }
    });
  });

  describe('a missing header fails the assertion', () => {
    it('accepts the complete header set', () => {
      // Baseline: the helper must not throw when everything is present and
      // correct, otherwise the "must throw" cases below prove nothing.
      expect(() => assertSecurityHeaders(allSecurityHeadersValidExcept())).not.toThrow();
    });

    it('fails when any single required header is absent', () => {
      // Guards the guard: delete each required header in turn and confirm the
      // assertion throws *because of that header* — the message names it.
      for (const { name } of REQUIRED_SECURITY_HEADERS) {
        const headers = allSecurityHeadersValidExcept(name);
        expect(headers[name], 'baseline must omit exactly one header').toBeUndefined();

        expect(
          () => assertSecurityHeaders(headers),
          `expected a failure for missing "${name}"`,
        ).toThrow(name);
      }
    });

    it('fails when a required header carries the wrong value', () => {
      const headers = allSecurityHeadersValidExcept();
      headers['x-content-type-options'] = 'off';

      expect(() => assertSecurityHeaders(headers)).toThrow(/x-content-type-options/);
    });
  });

  describe('content security policy', () => {
    it('emits the documented strict directives', async () => {
      const app = buildApp();
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get('/ok').expect(200);
      const csp = res.headers['content-security-policy'];

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data: https:");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("media-src 'self'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain('upgrade-insecure-requests');
      // No 'unsafe-inline' / 'unsafe-eval' anywhere in the policy.
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
    });

    it('carries a per-request nonce in script-src and style-src', async () => {
      const app = buildApp();
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });

      const first = await request(app).get('/ok').expect(200);
      const second = await request(app).get('/ok').expect(200);

      const nonceOf = (csp: string): string | undefined =>
        /'nonce-([^']+)'/.exec(csp)?.[1];

      const firstNonce = nonceOf(first.headers['content-security-policy']);
      const secondNonce = nonceOf(second.headers['content-security-policy']);

      expect(firstNonce).toBeTruthy();
      expect(secondNonce).toBeTruthy();
      // A replayed nonce would let an attacker reuse an injected script tag.
      expect(firstNonce).not.toBe(secondNonce);
      expect(first.headers['content-security-policy']).toContain(`script-src 'self' 'nonce-${firstNonce}'`);
      expect(first.headers['content-security-policy']).toContain(`style-src 'self' 'nonce-${firstNonce}'`);
    });

    it('omits the nonce directives when cspNonceMiddleware is not mounted', async () => {
      const app = express();
      app.use(createHelmetMiddleware());
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get('/ok').expect(200);
      const csp = res.headers['content-security-policy'];

      // Degrades to a nonce-free (still 'self'-only) policy rather than
      // throwing or emitting an empty 'nonce-' directive.
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("'nonce-");
    });
  });

  describe('createApp integration', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const { createApp } = await import('../src/app.js');
      server = createApp({ includeTestRoutes: true }).listen(0);
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      server.close();
      await once(server, 'close');
    });

    it('sets the full header set on a real success response', async () => {
      const res = await fetch(`${baseUrl}/`);

      expect(res.status).toBe(200);
      assertSecurityHeaders(Object.fromEntries(res.headers));
    });

    it('sets the full header set on a real handled error response', async () => {
      const res = await fetch(`${baseUrl}/does-not-exist`);

      expect(res.status).toBe(404);
      assertSecurityHeaders(Object.fromEntries(res.headers));
    });

    it('sets the full header set on a real unhandled error response', async () => {
      const res = await fetch(`${baseUrl}/__test/error`);

      expect(res.status).toBe(500);
      assertSecurityHeaders(Object.fromEntries(res.headers));
    });
  });
});
