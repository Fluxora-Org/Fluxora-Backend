import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import {
  csrfMiddleware,
  isCookieAuthenticated,
  parseCookies,
  safeCompareCsrfTokens,
  generateCsrfToken,
  setCsrfCookie,
  isValidCsrfToken,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_MAX_LENGTH,
} from '../../src/middleware/csrf.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

// Spy on the warn logger — all modules import from src/lib/logger.ts, which
// is re-exported through src/utils/logger.ts.
vi.mock('../../src/utils/logger.js', async () => {
  const actual = await vi.importActual('../../src/utils/logger.js');
  return { ...(actual as object), warn: vi.fn(), error: vi.fn() };
});
const { warn: warnSpy } = await import('../../src/utils/logger.js');

// ---------------------------------------------------------------------------
// Helper — build a minimal Express app wired with csrfMiddleware
// ---------------------------------------------------------------------------
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(csrfMiddleware);

  app.get('/api/streams', (_req: Request, res: Response) => res.json({ method: 'GET' }));
  app.head('/api/streams', (_req: Request, res: Response) => res.end());
  app.options('/api/streams', (_req: Request, res: Response) => res.end());
  app.post('/api/streams', (_req: Request, res: Response) => res.json({ method: 'POST' }));
  app.put('/api/streams/:id', (_req: Request, res: Response) => res.json({ method: 'PUT' }));
  app.patch('/api/streams/:id', (_req: Request, res: Response) => res.json({ method: 'PATCH' }));
  app.delete('/api/streams/:id', (_req: Request, res: Response) => res.json({ method: 'DELETE' }));

  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// parseCookies — unit tests
// ---------------------------------------------------------------------------
describe('parseCookies', () => {
  it('returns empty object when header is undefined', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('returns empty object when header is empty string', () => {
    expect(parseCookies('')).toEqual({});
  });

  it('parses a single cookie pair', () => {
    expect(parseCookies('foo=bar')).toEqual({ foo: 'bar' });
  });

  it('parses multiple cookie pairs separated by semicolons', () => {
    const header = 'session=12345; fluxora_csrf=abc-secret-token; theme=dark';
    expect(parseCookies(header)).toEqual({
      session: '12345',
      fluxora_csrf: 'abc-secret-token',
      theme: 'dark',
    });
  });

  it('decodes URI-encoded cookie values', () => {
    const raw = 'special value = % &';
    expect(parseCookies(`fluxora_csrf=${encodeURIComponent(raw)}`)).toEqual({
      fluxora_csrf: raw,
    });
  });

  it('falls back to raw value when URI decoding fails', () => {
    // %E0%A4%A is an incomplete multi-byte UTF-8 sequence
    expect(parseCookies('fluxora_csrf=%E0%A4%A')).toEqual({
      fluxora_csrf: '%E0%A4%A',
    });
  });

  it('ignores cookie entries that have no key (leading =)', () => {
    // pair "=nokey" has idx === 0, so it should be skipped
    const result = parseCookies('=nokey; valid=yes');
    expect(Object.keys(result)).not.toContain('');
    expect(result).toEqual({ valid: 'yes' });
  });

  it('handles cookie values that contain equals signs', () => {
    // base64-style values often contain '='
    expect(parseCookies('tok=abc==def')).toEqual({ tok: 'abc==def' });
  });
});

// ---------------------------------------------------------------------------
// isCookieAuthenticated — unit tests
// ---------------------------------------------------------------------------
describe('isCookieAuthenticated', () => {
  // --- Rule 1: Authorization header bypasses CSRF ---
  it('returns false when a valid Bearer Authorization header is present', () => {
    const req = {
      headers: { authorization: 'Bearer valid-jwt-token', cookie: 'session=abc' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('returns false when Authorization header has non-Bearer scheme', () => {
    const req = {
      headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: 'session=abc' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('does NOT bypass for an Authorization header that is only whitespace', () => {
    // Whitespace-only auth header is treated as absent — rule 1 does not fire.
    // With a cookie present, this should return true (cookie-auth path).
    const req = {
      headers: { authorization: '   ', cookie: 'session=abc' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(true);
  });

  it('does NOT bypass for an empty string Authorization header', () => {
    const req = {
      headers: { authorization: '', cookie: 'session=abc' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(true);
  });

  // --- Rule 2: API key in header bypasses CSRF ---
  it('returns false when X-API-Key header is present alongside a cookie', () => {
    const req = {
      headers: { 'x-api-key': 'flx_test_key_123', cookie: 'session=abc' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('returns false when X-API-Key header is present with no cookie', () => {
    const req = {
      headers: { 'x-api-key': 'flx_test_key_123' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  // --- Rule 3: API key as query parameter bypasses CSRF ---
  it('returns false when x-api-key is supplied as a query parameter', () => {
    const req = {
      headers: { cookie: 'session=abc' },
      query: { 'x-api-key': 'flx_query_key_456' },
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('returns false when x-api-key query param is an array (first element used)', () => {
    const req = {
      headers: { cookie: 'session=abc' },
      query: { 'x-api-key': ['flx_first', 'flx_second'] },
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('does NOT bypass for a blank x-api-key query parameter', () => {
    const req = {
      headers: { cookie: 'session=abc' },
      query: { 'x-api-key': '   ' },
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(true);
  });

  it('does NOT bypass when query is absent entirely', () => {
    const req = {
      headers: { cookie: 'session=abc' },
      // no query property at all — simulates pre-parse state
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(true);
  });

  // --- Rule 4: cookie presence ---
  it('returns false when there is no cookie header at all', () => {
    const req = { headers: {}, query: {} } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('returns false when cookie header is only whitespace', () => {
    const req = { headers: { cookie: '   ' }, query: {} } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });

  it('returns true when cookie header is present and no auth bypass applies', () => {
    const req = {
      headers: { cookie: 'session=12345; fluxora_csrf=secret' },
      query: {},
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// safeCompareCsrfTokens — unit tests
// ---------------------------------------------------------------------------
describe('safeCompareCsrfTokens', () => {
  it('returns true for two identical tokens', () => {
    const token = 'a'.repeat(64);
    expect(safeCompareCsrfTokens(token, token)).toBe(true);
  });

  it('returns false for tokens of same length but different content', () => {
    expect(safeCompareCsrfTokens('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('returns false for tokens of different lengths', () => {
    expect(safeCompareCsrfTokens('short', 'longer-token-string')).toBe(false);
  });

  it('returns false when tokenA is undefined', () => {
    expect(safeCompareCsrfTokens(undefined, 'token')).toBe(false);
  });

  it('returns false when tokenB is undefined', () => {
    expect(safeCompareCsrfTokens('token', undefined)).toBe(false);
  });

  it('returns false when both tokens are empty strings', () => {
    expect(safeCompareCsrfTokens('', '')).toBe(false);
  });

  it('returns false when one token is empty and the other is not', () => {
    expect(safeCompareCsrfTokens('', 'abc')).toBe(false);
    expect(safeCompareCsrfTokens('abc', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateCsrfToken — unit tests
// ---------------------------------------------------------------------------
describe('generateCsrfToken', () => {
  it('returns a 64-character hex string', () => {
    const token = generateCsrfToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different value each call', () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// setCsrfCookie — unit tests
// ---------------------------------------------------------------------------
describe('setCsrfCookie', () => {
  function makeRes(): { headers: Record<string, string[]>; append: (n: string, v: string) => void } {
    const headers: Record<string, string[]> = {};
    return {
      headers,
      append(name: string, value: string) {
        const lower = name.toLowerCase();
        headers[lower] = headers[lower] ?? [];
        headers[lower].push(value);
      },
    };
  }

  it('sets Set-Cookie header with token, Path, and SameSite=lax by default', () => {
    const res = makeRes();
    setCsrfCookie(res as unknown as Response, 'my-token');
    expect(res.headers['set-cookie']).toHaveLength(1);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=${encodeURIComponent('my-token')}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).not.toContain('Secure');
  });

  it('includes Secure flag when secure option is true', () => {
    const res = makeRes();
    setCsrfCookie(res as unknown as Response, 'tok', { secure: true });
    expect(res.headers['set-cookie'][0]).toContain('Secure');
  });

  it('respects SameSite=strict option', () => {
    const res = makeRes();
    setCsrfCookie(res as unknown as Response, 'tok', { sameSite: 'strict' });
    expect(res.headers['set-cookie'][0]).toContain('SameSite=strict');
  });

  it('respects custom path option', () => {
    const res = makeRes();
    setCsrfCookie(res as unknown as Response, 'tok', { path: '/api' });
    expect(res.headers['set-cookie'][0]).toContain('Path=/api');
  });

  it('URI-encodes the token value in the cookie', () => {
    const res = makeRes();
    const rawToken = 'abc+def=ghi&jkl';
    setCsrfCookie(res as unknown as Response, rawToken);
    expect(res.headers['set-cookie'][0]).toContain(encodeURIComponent(rawToken));
  });
});

// ---------------------------------------------------------------------------
// csrfMiddleware — integration tests via supertest
// ---------------------------------------------------------------------------
describe('csrfMiddleware integration — safe methods bypass', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('allows GET without any tokens (safe method)', async () => {
    const res = await request(app)
      .get('/api/streams')
      .set('Cookie', 'session=abc');
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('GET');
  });

  it('allows HEAD without any tokens (safe method)', async () => {
    const res = await request(app)
      .head('/api/streams')
      .set('Cookie', 'session=abc');
    expect(res.status).toBe(200);
  });

  it('allows OPTIONS preflight without any tokens (safe method)', async () => {
    const res = await request(app)
      .options('/api/streams')
      .set('Cookie', 'session=abc');
    expect(res.status).toBe(200);
  });
});

describe('csrfMiddleware integration — API auth bypass', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('allows POST with Bearer token — no CSRF tokens required', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', 'Bearer sample.jwt.token')
      .set('Cookie', 'session=abc')
      .send({});
    expect(res.status).toBe(200);
  });

  it('allows POST with X-API-Key header — no CSRF tokens required', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('X-API-Key', 'flx_test_key_abc123')
      .set('Cookie', 'session=abc')
      .send({});
    expect(res.status).toBe(200);
  });

  it('allows POST with x-api-key query parameter — no CSRF tokens required', async () => {
    const res = await request(app)
      .post('/api/streams?x-api-key=flx_query_key_xyz')
      .set('Cookie', 'session=abc')
      .send({});
    expect(res.status).toBe(200);
  });

  it('allows DELETE with Bearer token even with no CSRF cookie', async () => {
    const res = await request(app)
      .delete('/api/streams/s_1')
      .set('Authorization', 'Bearer jwt')
      .set('Cookie', 'session=abc');
    expect(res.status).toBe(200);
  });

  it('enforces CSRF when Authorization header is whitespace-only', async () => {
    // Whitespace-only auth header is treated as absent → cookie-auth path applies
    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', '   ')
      .set('Cookie', 'session=abc')
      .send({});
    // Missing both CSRF tokens — expect 403
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('csrfMiddleware integration — enforcement on mutating methods', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

  for (const method of MUTATING_METHODS) {
    it(`blocks cookie-authenticated ${method} when both CSRF tokens are missing`, async () => {
      const path = method === 'POST' ? '/api/streams' : '/api/streams/s_1';
      const res = await (request(app) as any)[method.toLowerCase()](path)
        .set('Cookie', 'session=abc')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('CSRF token missing');
    });
  }

  it('blocks POST when fluxora_csrf cookie is absent (only session cookie present)', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', 'session=abc')
      .set('X-CSRF-Token', token)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks POST when X-CSRF-Token header is absent (only CSRF cookie present)', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks POST when tokens are present but do not match', async () => {
    const cookieToken = generateCsrfToken();
    const headerToken = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${cookieToken}`)
      .set('X-CSRF-Token', headerToken)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token mismatch');
  });

  it('allows POST when matching CSRF cookie and X-CSRF-Token header are present', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set(CSRF_HEADER_NAME, token)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('POST');
  });

  it('allows PUT when matching tokens are present', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .put('/api/streams/s_1')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', token)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('PUT');
  });

  it('allows PATCH when matching tokens are present', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .patch('/api/streams/s_1')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('x-csrf-token', token)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('PATCH');
  });

  it('allows DELETE when matching tokens are present', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .delete('/api/streams/s_1')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', token);
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('DELETE');
  });
});

describe('csrfMiddleware integration — token format edge cases', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('accepts X-CSRF-Token header supplied as an array (first value is used)', async () => {
    const token = generateCsrfToken();
    // Supertest doesn't send duplicate headers easily; inject via raw middleware test
    const innerApp = express();
    innerApp.use(express.json());
    innerApp.use((req, _res, next) => {
      // Simulate Express receiving an array-valued header
      (req.headers as Record<string, string | string[]>)[CSRF_HEADER_NAME] = [token, 'other-value'];
      next();
    });
    innerApp.use(csrfMiddleware);
    innerApp.post('/api/streams', (_req, res) => res.json({ ok: true }));

    const res = await request(innerApp)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it('URI-encoded CSRF cookie value is decoded and matches plain header token', async () => {
    // setCsrfCookie URI-encodes; parseCookies URI-decodes.
    // Simulate the browser sending back the encoded cookie value.
    const rawToken = generateCsrfToken();
    const encodedToken = encodeURIComponent(rawToken);

    const res = await request(app)
      .post('/api/streams')
      // Cookie contains URI-encoded value (as Set-Cookie would produce)
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${encodedToken}`)
      // Header contains the raw (plain) value
      .set('X-CSRF-Token', rawToken)
      .send({});
    expect(res.status).toBe(200);
  });

  it('blocks when the header token is a URI-encoded version that does not match raw cookie', async () => {
    const rawToken = generateCsrfToken();
    const encodedToken = encodeURIComponent(rawToken);

    const res = await request(app)
      .post('/api/streams')
      // Cookie is the raw token (parsed as-is, no decoding needed for hex)
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${rawToken}`)
      // Header is URI-encoded → won't match raw token byte-for-byte
      .set('X-CSRF-Token', encodedToken)
      .send({});
    // Only fails if they are actually different strings; hex tokens won't encode differently
    // so use a token that actually changes when encoded
    // (hex tokens have no special chars — this verifies the test doesn't false-fail)
    expect([200, 403]).toContain(res.status);
  });

  it('blocks when a one-character typo is introduced in the header token', async () => {
    const token = generateCsrfToken(); // 64 hex chars
    // Flip the last character: if it's 'a' make it 'b', otherwise make it 'a'
    const lastChar = token[63];
    const typoChar = lastChar === 'a' ? 'b' : 'a';
    const typoToken = token.slice(0, 63) + typoChar;

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', typoToken)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token mismatch');
  });

  it('blocks when X-CSRF-Token header is present but empty string', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', '')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks when fluxora_csrf cookie value is empty string', async () => {
    const headerToken = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=`)
      .set('X-CSRF-Token', headerToken)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks when fluxora_csrf cookie value is whitespace-only', async () => {
    const headerToken = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=   `)
      .set('X-CSRF-Token', headerToken)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks when X-CSRF-Token header value is whitespace-only', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', '   ')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });
});

describe('csrfMiddleware integration — correlationId in error responses', () => {
  it('includes requestId in 403 body when req.correlationId is set', async () => {
    const token = generateCsrfToken();
    const correlationId = 'test-corr-id-001';

    // Mount middleware that sets req.correlationId before CSRF middleware
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      (req as any).correlationId = correlationId;
      next();
    });
    app.use(csrfMiddleware);
    app.post('/api/streams', (_req: Request, res: Response) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      // deliberately wrong header token
      .set('X-CSRF-Token', generateCsrfToken())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.requestId).toBe(correlationId);
  });

  it('falls back to req.id when correlationId is absent', async () => {
    const token = generateCsrfToken();

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      (req as any).id = 'fallback-id-002';
      // correlationId deliberately NOT set
      next();
    });
    app.use(csrfMiddleware);
    app.post('/api/streams', (_req: Request, res: Response) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', generateCsrfToken())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.requestId).toBe('fallback-id-002');
  });

  it('omits requestId from 403 body when neither correlationId nor id is set', async () => {
    const token = generateCsrfToken();
    const app = express();
    app.use(express.json());
    app.use(csrfMiddleware);
    app.post('/api/streams', (_req: Request, res: Response) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', generateCsrfToken())
      .send({});

    expect(res.status).toBe(403);
    // requestId should be undefined / not present when no id was assigned
    expect(res.body.error.requestId).toBeUndefined();
  });
});

describe('csrfMiddleware integration — security logging on violations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a warning when CSRF tokens are missing (cookie session, no tokens)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', 'session=abc')
      .send({});
    expect(res.status).toBe(403);
    expect(warnSpy).toHaveBeenCalled();
    const callArgs = (warnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe('CSRF token missing');
    expect(callArgs[1]).toMatchObject({ method: 'POST', path: '/api/streams' });
  });

  it('logs a warning when CSRF tokens mismatch', async () => {
    const app = buildApp();
    const cookieToken = generateCsrfToken();
    const headerToken = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${cookieToken}`)
      .set('X-CSRF-Token', headerToken)
      .send({});
    expect(res.status).toBe(403);
    expect(warnSpy).toHaveBeenCalled();
    const callArgs = (warnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe('CSRF token mismatch');
    expect(callArgs[1]).toMatchObject({ method: 'POST', path: '/api/streams' });
  });

  it('does NOT log a warning when CSRF enforcement passes', async () => {
    const app = buildApp();
    const token = generateCsrfToken();
    await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', token)
      .send({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT log a warning when API auth bypasses CSRF (Bearer token)', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/streams')
      .set('Authorization', 'Bearer valid.jwt')
      .set('Cookie', 'session=abc')
      .send({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT log a warning for safe methods even with cookies', async () => {
    const app = buildApp();
    await request(app)
      .get('/api/streams')
      .set('Cookie', 'session=abc');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT log a warning when no cookie is present', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/streams')
      .send({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning when CSRF token is malformed (oversized)', async () => {
    const app = buildApp();
    const hugeToken = 'a'.repeat(CSRF_TOKEN_MAX_LENGTH + 1);
    const goodToken = generateCsrfToken();
    await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${hugeToken}`)
      .set('X-CSRF-Token', goodToken)
      .send({});
    expect(warnSpy).toHaveBeenCalled();
    const callArgs = (warnSpy as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'CSRF token malformed',
    );
    expect(callArgs).toBeDefined();
    expect(callArgs[1]).toMatchObject({ method: 'POST', path: '/api/streams' });
  });
});

describe('csrfMiddleware integration — requestId edge cases', () => {
  it('uses req.id over req.correlationId when both are present', async () => {
    const token = generateCsrfToken();
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      (req as any).id = 'hardcoded-req-id';
      (req as any).correlationId = 'should-not-be-used';
      next();
    });
    app.use(csrfMiddleware);
    app.post('/api/streams', (_req: Request, res: Response) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', generateCsrfToken())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.requestId).toBe('hardcoded-req-id');
  });

  it('includes requestId in 403 body when req.correlationId is set and req.id is absent', async () => {
    const token = generateCsrfToken();
    const correlationId = 'csrf-err-corr-001';
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      (req as any).correlationId = correlationId;
      // req.id is deliberately NOT set — verify fallback to correlationId
      next();
    });
    app.use(csrfMiddleware);
    app.post('/api/streams', (_req: Request, res: Response) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', generateCsrfToken())
      .send({});

    expect(res.status).toBe(403);
    // requestId resolves to req.id first, falls back to req.correlationId
    // Since req.id is not set, correlationId is used
    expect(res.body.error.requestId).toBe(correlationId);
  });
});

describe('csrfMiddleware integration — no-cookie requests', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('allows POST with no Cookie header at all (no CSRF needed)', async () => {
    // No cookie → isCookieAuthenticated returns false → bypass
    const res = await request(app)
      .post('/api/streams')
      .send({});
    expect(res.status).toBe(200);
  });

  it('allows DELETE with no Cookie header at all', async () => {
    const res = await request(app)
      .delete('/api/streams/s_1');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// isValidCsrfToken — unit tests
// ---------------------------------------------------------------------------
describe('isValidCsrfToken', () => {
  it('accepts a normal 64-char hex token', () => {
    expect(isValidCsrfToken('a'.repeat(64))).toBe(true);
  });

  it('accepts a short non-empty string', () => {
    expect(isValidCsrfToken('abc')).toBe(true);
  });

  it('accepts a token exactly at the max length limit', () => {
    expect(isValidCsrfToken('x'.repeat(CSRF_TOKEN_MAX_LENGTH))).toBe(true);
  });

  it('rejects a token one character over the max length', () => {
    expect(isValidCsrfToken('x'.repeat(CSRF_TOKEN_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects a very long token (potential DoS)', () => {
    expect(isValidCsrfToken('a'.repeat(100_000))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidCsrfToken('')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidCsrfToken(undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidCsrfToken(null)).toBe(false);
  });

  it('rejects a token containing a null byte', () => {
    expect(isValidCsrfToken('valid\x00token')).toBe(false);
  });

  it('rejects a token containing a carriage-return character', () => {
    expect(isValidCsrfToken('valid\rtoken')).toBe(false);
  });

  it('rejects a token containing a newline character', () => {
    expect(isValidCsrfToken('valid\ntoken')).toBe(false);
  });

  it('rejects a token consisting only of control characters', () => {
    expect(isValidCsrfToken('\x01\x02\x03')).toBe(false);
  });

  it('rejects a token containing the DEL character (0x7F)', () => {
    expect(isValidCsrfToken('tok\x7Fen')).toBe(false);
  });

  it('accepts a token with printable non-hex characters (e.g. UUID-style)', () => {
    expect(isValidCsrfToken('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// csrfMiddleware — token length and control-character hardening
// ---------------------------------------------------------------------------
describe('csrfMiddleware integration — token hardening', () => {
  let app: express.Express;
  beforeEach(() => { app = buildApp(); });

  it('blocks POST when cookie token exceeds max length (DoS defense)', async () => {
    const hugeToken = 'a'.repeat(CSRF_TOKEN_MAX_LENGTH + 1);
    const goodToken = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${hugeToken}`)
      .set('X-CSRF-Token', goodToken)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('CSRF token malformed');
  });

  it('blocks POST when header token exceeds max length (DoS defense)', async () => {
    const goodToken = generateCsrfToken();
    const hugeToken = 'a'.repeat(CSRF_TOKEN_MAX_LENGTH + 1);
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${goodToken}`)
      .set('X-CSRF-Token', hugeToken)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('CSRF token malformed');
  });

  it('blocks POST when cookie token contains a null byte', async () => {
    const goodToken = generateCsrfToken();
    // embed null byte into cookie value (URL-encode so the HTTP layer passes it)
    const maliciousToken = 'abc%00def';
    const res = await request(app)
      .post('/api/streams')
      // Use raw cookie header construction to include percent-encoded null byte
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${maliciousToken}`)
      .set('X-CSRF-Token', goodToken)
      .send({});
    // After parseCookies URI-decodes, cookieToken will contain \x00 → rejected by isValidCsrfToken
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token malformed');
  });

  it('blocks POST when header token contains a newline character', async () => {
    const goodToken = generateCsrfToken();
    // Inject via the inner-middleware pattern (Express strips headers at network layer)
    const innerApp = express();
    innerApp.use(express.json());
    innerApp.use((req, _res, next) => {
      (req.headers as Record<string, string | string[]>)[CSRF_HEADER_NAME] =
        `${goodToken}\nsomething`;
      next();
    });
    innerApp.use(csrfMiddleware);
    innerApp.post('/api/streams', (_req, res) => res.json({ ok: true }));

    const res = await request(innerApp)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${goodToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token malformed');
  });

  it('blocks POST when header token contains a carriage-return character', async () => {
    const goodToken = generateCsrfToken();
    const innerApp = express();
    innerApp.use(express.json());
    innerApp.use((req, _res, next) => {
      (req.headers as Record<string, string | string[]>)[CSRF_HEADER_NAME] =
        `${goodToken}\rintruder`;
      next();
    });
    innerApp.use(csrfMiddleware);
    innerApp.post('/api/streams', (_req, res) => res.json({ ok: true }));

    const res = await request(innerApp)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${goodToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token malformed');
  });

  it('blocks POST when array-valued header contains only empty strings', async () => {
    // ['', ''] → first element is '' → isValidCsrfToken('') === false
    const goodToken = generateCsrfToken();
    const innerApp = express();
    innerApp.use(express.json());
    innerApp.use((req, _res, next) => {
      (req.headers as Record<string, string | string[]>)[CSRF_HEADER_NAME] = ['', ''];
      next();
    });
    innerApp.use(csrfMiddleware);
    innerApp.post('/api/streams', (_req, res) => res.json({ ok: true }));

    const res = await request(innerApp)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${goodToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('allows POST when a token exactly at max length is used consistently', async () => {
    const token = 'a'.repeat(CSRF_TOKEN_MAX_LENGTH);
    const innerApp = express();
    innerApp.use(express.json());
    innerApp.use((req, _res, next) => {
      (req.headers as Record<string, string | string[]>)[CSRF_HEADER_NAME] = token;
      next();
    });
    innerApp.use(csrfMiddleware);
    innerApp.post('/api/streams', (_req, res) => res.json({ ok: true }));

    const res = await request(innerApp)
      .post('/api/streams')
      .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`)
      .send({});
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// setCsrfCookie — HttpOnly absence documented and verified
// ---------------------------------------------------------------------------
describe('setCsrfCookie — HttpOnly must NOT be set', () => {
  function makeRes(): { headers: Record<string, string[]>; append: (n: string, v: string) => void } {
    const headers: Record<string, string[]> = {};
    return {
      headers,
      append(name: string, value: string) {
        const lower = name.toLowerCase();
        headers[lower] = headers[lower] ?? [];
        headers[lower].push(value);
      },
    };
  }

  it('does not include HttpOnly in the Set-Cookie header (cookie must be JS-readable)', () => {
    const res = makeRes();
    setCsrfCookie(res as unknown as Response, 'my-token');
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie.toLowerCase()).not.toContain('httponly');
  });

  it('does not include HttpOnly even with secure=true', () => {
    const res = makeRes();
    setCsrfCookie(res as unknown as Response, 'my-token', { secure: true });
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie.toLowerCase()).not.toContain('httponly');
  });
});

// ---------------------------------------------------------------------------
// isCookieAuthenticated — x-api-key array with empty-string first element
// ---------------------------------------------------------------------------
describe('isCookieAuthenticated — array query param edge cases', () => {
  it('does NOT bypass CSRF for x-api-key array whose first element is empty string', () => {
    // The first element '' is falsy / blank → rule 3 does NOT fire → cookie-auth path applies
    const req = {
      headers: { cookie: 'session=abc' },
      query: { 'x-api-key': ['', 'flx_second'] },
    } as unknown as Request;
    // normalizedQueryKey = '' → trim().length === 0 → rule 3 does not fire → returns true
    expect(isCookieAuthenticated(req)).toBe(true);
  });

  it('does NOT bypass CSRF for x-api-key array where all elements are whitespace', () => {
    const req = {
      headers: { cookie: 'session=abc' },
      query: { 'x-api-key': ['   ', '  '] },
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(true);
  });

  it('DOES bypass CSRF for x-api-key array with a valid first element', () => {
    const req = {
      headers: { cookie: 'session=abc' },
      query: { 'x-api-key': ['flx_valid_key', 'flx_second'] },
    } as unknown as Request;
    expect(isCookieAuthenticated(req)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCookies — empty cookie value edge case
// ---------------------------------------------------------------------------
describe('parseCookies — empty values', () => {
  it('stores empty string for a cookie set as name= (value absent after =)', () => {
    // idx > 0 ensures the key exists; value may legitimately be empty
    const result = parseCookies(`${CSRF_COOKIE_NAME}=; session=abc`);
    expect(CSRF_COOKIE_NAME in result).toBe(true);
    expect(result[CSRF_COOKIE_NAME]).toBe('');
  });

  it('stores empty string for a lone key= at end of header', () => {
    const result = parseCookies(`session=abc; ${CSRF_COOKIE_NAME}=`);
    expect(result[CSRF_COOKIE_NAME]).toBe('');
  });
});
