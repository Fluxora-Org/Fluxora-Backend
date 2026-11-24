import { describe, it, expect, vi, afterEach } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_MAX_LENGTH,
  csrfMiddleware,
  generateCsrfToken,
  isCookieAuthenticated,
  isValidCsrfToken,
  parseCookies,
  safeCompareCsrfTokens,
  setCsrfCookie,
} from './csrf.js';
import { ApiErrorCode } from './errorHandler.js';

function createTestApp(withRequestId?: string) {
  const app = express();
  if (withRequestId) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.id = withRequestId;
      next();
    });
  }
  app.use(csrfMiddleware);
  app.all('/resource', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

function makeMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    path: '/resource',
    ip: '127.0.0.1',
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function makeMockRes(): {
  res: Response;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
  appendMock: ReturnType<typeof vi.fn>;
} {
  const jsonMock = vi.fn();
  const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
  const appendMock = vi.fn();
  const res = {
    status: statusMock,
    json: jsonMock,
    append: appendMock,
  } as unknown as Response;
  return { res, statusMock, jsonMock, appendMock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CSRF middleware helpers and integration', () => {
  describe('parseCookies', () => {
    it('returns an empty object when the Cookie header is missing or empty', () => {
      expect(parseCookies(undefined)).toEqual({});
      expect(parseCookies('')).toEqual({});
    });

    it('parses multiple cookies and trims surrounding whitespace', () => {
      expect(parseCookies('session=abc123;  fluxora_csrf=token-xyz ; theme=dark')).toEqual({
        session: 'abc123',
        fluxora_csrf: 'token-xyz',
        theme: 'dark',
      });
    });

    it('decodes URI-encoded cookie values', () => {
      expect(parseCookies('fluxora_csrf=abc%2Bdef%3D%3D; note=hello%20world')).toEqual({
        fluxora_csrf: 'abc+def==',
        note: 'hello world',
      });
    });

    it('falls back to the raw value when decodeURIComponent throws on malformed % sequences', () => {
      expect(parseCookies('broken=%E0%A4%A; raw=100%invalid; ok=valid')).toEqual({
        broken: '%E0%A4%A',
        raw: '100%invalid',
        ok: 'valid',
      });
    });

    it('ignores pairs without "=" or with an empty key', () => {
      expect(parseCookies('flagonly; =emptykey;   =whitespacekey; valid=yes')).toEqual({
        valid: 'yes',
      });
    });

    it('overwrites duplicate cookie keys with the last value (last-wins)', () => {
      expect(parseCookies('fluxora_csrf=first; other=1; fluxora_csrf=second')).toEqual({
        fluxora_csrf: 'second',
        other: '1',
      });
    });

    it('preserves "=" characters inside cookie values', () => {
      expect(parseCookies('token=abc=def==; eq=a=b=c')).toEqual({
        token: 'abc=def==',
        eq: 'a=b=c',
      });
    });
  });

  describe('isCookieAuthenticated', () => {
    it('returns false when the Cookie header is missing or undefined', () => {
      expect(isCookieAuthenticated(makeMockReq({ headers: {} }))).toBe(false);
      expect(isCookieAuthenticated(makeMockReq({ headers: { cookie: undefined } }))).toBe(false);
    });

    it('returns false when the Cookie header is empty or whitespace-only', () => {
      expect(isCookieAuthenticated(makeMockReq({ headers: { cookie: '' } }))).toBe(false);
      expect(isCookieAuthenticated(makeMockReq({ headers: { cookie: '   \t  ' } }))).toBe(false);
    });

    it('returns false for Bearer or X-API-Key requests with no Cookie header', () => {
      expect(
        isCookieAuthenticated(makeMockReq({ headers: { authorization: 'Bearer jwt-token-here' } }))
      ).toBe(false);
      expect(isCookieAuthenticated(makeMockReq({ headers: { 'x-api-key': 'api-key-123' } }))).toBe(
        false
      );
      expect(
        isCookieAuthenticated(makeMockReq({ headers: {}, query: { 'x-api-key': 'api-key-123' } }))
      ).toBe(false);
    });

    it('returns true when a non-empty Cookie header is present alone', () => {
      expect(isCookieAuthenticated(makeMockReq({ headers: { cookie: 'session=abc' } }))).toBe(true);
    });

    it('returns true when a Cookie header is present alongside Authorization or X-API-Key', () => {
      expect(
        isCookieAuthenticated(
          makeMockReq({
            headers: {
              cookie: 'session=abc',
              authorization: 'Bearer jwt-token-here',
            },
          })
        )
      ).toBe(true);
      expect(
        isCookieAuthenticated(
          makeMockReq({
            headers: {
              cookie: 'session=abc',
              'x-api-key': 'api-key-123',
            },
            query: { 'x-api-key': 'api-key-123' },
          })
        )
      ).toBe(true);
    });
  });

  describe('isValidCsrfToken', () => {
    it('rejects non-string and empty values', () => {
      expect(isValidCsrfToken(undefined)).toBe(false);
      expect(isValidCsrfToken(null)).toBe(false);
      expect(isValidCsrfToken(12345)).toBe(false);
      expect(isValidCsrfToken({})).toBe(false);
      expect(isValidCsrfToken(['token'])).toBe(false);
      expect(isValidCsrfToken('')).toBe(false);
    });

    it('accepts a normal 64-char hex token and exact CSRF_TOKEN_MAX_LENGTH (512 chars)', () => {
      const generated = generateCsrfToken();
      expect(isValidCsrfToken(generated)).toBe(true);

      const maxLenToken = 'a'.repeat(CSRF_TOKEN_MAX_LENGTH);
      expect(maxLenToken).toHaveLength(512);
      expect(isValidCsrfToken(maxLenToken)).toBe(true);
    });

    it('rejects oversized tokens exceeding CSRF_TOKEN_MAX_LENGTH (513+ chars)', () => {
      expect(isValidCsrfToken('a'.repeat(CSRF_TOKEN_MAX_LENGTH + 1))).toBe(false);
      expect(isValidCsrfToken('a'.repeat(1024))).toBe(false);
    });

    it('rejects tokens containing null bytes or ASCII control characters', () => {
      expect(isValidCsrfToken('abc\x00def')).toBe(false);
      expect(isValidCsrfToken('abc\ndef')).toBe(false);
      expect(isValidCsrfToken('abc\rdef')).toBe(false);
      expect(isValidCsrfToken('abc\x1fdef')).toBe(false);
      expect(isValidCsrfToken('abc\x7fdef')).toBe(false);
    });
  });

  describe('safeCompareCsrfTokens', () => {
    it('returns false when either token is undefined or empty', () => {
      expect(safeCompareCsrfTokens(undefined, 'abc')).toBe(false);
      expect(safeCompareCsrfTokens('abc', undefined)).toBe(false);
      expect(safeCompareCsrfTokens(undefined, undefined)).toBe(false);
      expect(safeCompareCsrfTokens('', 'abc')).toBe(false);
      expect(safeCompareCsrfTokens('abc', '')).toBe(false);
    });

    it('returns true for identical tokens', () => {
      const token = generateCsrfToken();
      expect(safeCompareCsrfTokens(token, token)).toBe(true);
    });

    it('returns false for equal-length mismatched tokens', () => {
      expect(safeCompareCsrfTokens('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    });

    it('returns false for unequal-length tokens without throwing', () => {
      expect(safeCompareCsrfTokens('short', 'much-longer-csrf-token')).toBe(false);
      expect(safeCompareCsrfTokens('much-longer-csrf-token', 'short')).toBe(false);
    });
  });

  describe('generateCsrfToken and setCsrfCookie', () => {
    it('generates unique 64-character hex tokens', () => {
      const token1 = generateCsrfToken();
      const token2 = generateCsrfToken();

      expect(token1).toMatch(/^[0-9a-f]{64}$/);
      expect(token2).toMatch(/^[0-9a-f]{64}$/);
      expect(token1).not.toBe(token2);
    });

    it('sets Set-Cookie with default attributes and intentionally omits HttpOnly', () => {
      const { res, appendMock } = makeMockRes();
      const token = 'token+with/special=chars';

      setCsrfCookie(res, token);

      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(appendMock).toHaveBeenCalledWith(
        'Set-Cookie',
        `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=lax`
      );
      const cookieHeader = appendMock.mock.calls[0]![1] as string;
      expect(cookieHeader).not.toMatch(/HttpOnly/i);
      expect(cookieHeader).not.toMatch(/Secure/i);
    });

    it('applies Secure, custom SameSite, and custom Path options', () => {
      const { res, appendMock } = makeMockRes();

      setCsrfCookie(res, 'abc123', {
        sameSite: 'strict',
        secure: true,
        path: '/api/v1',
      });

      expect(appendMock).toHaveBeenCalledWith(
        'Set-Cookie',
        `${CSRF_COOKIE_NAME}=abc123; Path=/api/v1; SameSite=strict; Secure`
      );
    });
  });

  describe('csrfMiddleware (Express + supertest integration)', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'] as const)(
      'skips CSRF validation for safe method %s even with cookies and no CSRF header',
      async (method) => {
        const app = createTestApp();
        const agent = request(app);

        const res = await agent[method.toLowerCase() as 'get' | 'head' | 'options'](
          '/resource'
        ).set('Cookie', 'session=user-session');

        expect(res.status).toBe(200);
        if (method !== 'HEAD') {
          expect(res.body).toEqual({ ok: true });
        }
      }
    );

    it('skips CSRF validation for unauthenticated, Bearer-only, and X-API-Key-only mutating requests without cookies', async () => {
      const app = createTestApp();

      const unauthRes = await request(app).post('/resource');
      expect(unauthRes.status).toBe(200);

      const bearerRes = await request(app)
        .post('/resource')
        .set('Authorization', 'Bearer jwt-token');
      expect(bearerRes.status).toBe(200);

      const apiKeyRes = await request(app).delete('/resource').set('X-API-Key', 'api-key-value');
      expect(apiKeyRes.status).toBe(200);
    });

    it('rejects cookie-authenticated requests with 403 when cookie token or header token is missing', async () => {
      const app = createTestApp('req-missing-1');
      const token = generateCsrfToken();

      const missingCookieToken = await request(app)
        .post('/resource')
        .set('Cookie', 'session=active')
        .set(CSRF_HEADER_NAME, token);

      expect(missingCookieToken.status).toBe(403);
      expect(missingCookieToken.body).toEqual({
        success: false,
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message:
            'CSRF token missing: fluxora_csrf cookie and X-CSRF-Token header are required for cookie-authenticated requests',
          requestId: 'req-missing-1',
        },
      });

      const missingHeaderToken = await request(app)
        .put('/resource')
        .set('Cookie', `${CSRF_COOKIE_NAME}=${token}`);

      expect(missingHeaderToken.status).toBe(403);
      expect(missingHeaderToken.body.success).toBe(false);
      expect(missingHeaderToken.body.error.code).toBe(ApiErrorCode.FORBIDDEN);
      expect(missingHeaderToken.body.error.requestId).toBe('req-missing-1');
    });

    it('rejects whitespace-only cookie or header tokens with 403', async () => {
      const app = createTestApp();
      const token = generateCsrfToken();

      const blankCookieRes = await request(app)
        .patch('/resource')
        .set('Cookie', `session=1; ${CSRF_COOKIE_NAME}=   `)
        .set(CSRF_HEADER_NAME, token);
      expect(blankCookieRes.status).toBe(403);
      expect(blankCookieRes.body.error.code).toBe(ApiErrorCode.FORBIDDEN);

      const blankHeaderRes = await request(app)
        .delete('/resource')
        .set('Cookie', `${CSRF_COOKIE_NAME}=${token}`)
        .set(CSRF_HEADER_NAME, '   \t  ');
      expect(blankHeaderRes.status).toBe(403);
      expect(blankHeaderRes.body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    });

    it('rejects oversized (> CSRF_TOKEN_MAX_LENGTH) tokens with 403', async () => {
      const app = createTestApp();
      const oversized = 'x'.repeat(CSRF_TOKEN_MAX_LENGTH + 1);

      const res = await request(app)
        .post('/resource')
        .set('Cookie', `${CSRF_COOKIE_NAME}=${oversized}`)
        .set(CSRF_HEADER_NAME, oversized);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message:
            'CSRF token malformed: token exceeds maximum length or contains invalid characters',
        },
      });
    });

    it('rejects control-character tokens in cookies (via supertest) and headers with 403', async () => {
      const app = createTestApp();
      const validToken = generateCsrfToken();

      // URL-encoded control chars in the cookie are decoded by parseCookies()
      for (const encodedControl of ['bad%00token', 'bad%0Atoken', 'bad%7Ftoken']) {
        const res = await request(app)
          .post('/resource')
          .set('Cookie', `${CSRF_COOKIE_NAME}=${encodedControl}`)
          .set(CSRF_HEADER_NAME, validToken);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(ApiErrorCode.FORBIDDEN);
      }

      // Direct invocation covers raw control chars in req.headers['x-csrf-token']
      const req = makeMockReq({
        method: 'POST',
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${validToken}`,
          [CSRF_HEADER_NAME]: 'bad\x00header',
        },
      });
      const { res, statusMock, jsonMock } = makeMockRes();
      const next = vi.fn();

      csrfMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message:
            'CSRF token malformed: token exceeds maximum length or contains invalid characters',
        },
      });
    });

    it('rejects same-length and different-length mismatched tokens with 403', async () => {
      const app = createTestApp();
      const cookieToken = 'a'.repeat(64);

      const sameLengthMismatch = await request(app)
        .post('/resource')
        .set('Cookie', `${CSRF_COOKIE_NAME}=${cookieToken}`)
        .set(CSRF_HEADER_NAME, 'b'.repeat(64));

      expect(sameLengthMismatch.status).toBe(403);
      expect(sameLengthMismatch.body).toEqual({
        success: false,
        error: {
          code: ApiErrorCode.FORBIDDEN,
          message:
            'CSRF token mismatch: provided X-CSRF-Token header does not match fluxora_csrf cookie',
        },
      });

      const diffLengthMismatch = await request(app)
        .post('/resource')
        .set('Cookie', `${CSRF_COOKIE_NAME}=${cookieToken}`)
        .set(CSRF_HEADER_NAME, 'short');

      expect(diffLengthMismatch.status).toBe(403);
      expect(diffLengthMismatch.body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    });

    it('enforces CSRF even when Authorization Bearer or X-API-Key is sent alongside cookies', async () => {
      const app = createTestApp();
      const token = generateCsrfToken();

      const bypassAttempt = await request(app)
        .post('/resource')
        .set('Cookie', 'session=abc')
        .set('Authorization', 'Bearer jwt-token')
        .set('X-API-Key', 'api-key');

      expect(bypassAttempt.status).toBe(403);
      expect(bypassAttempt.body.error.code).toBe(ApiErrorCode.FORBIDDEN);

      const validWithBoth = await request(app)
        .post('/resource')
        .set('Cookie', `session=abc; ${CSRF_COOKIE_NAME}=${token}`)
        .set('Authorization', 'Bearer jwt-token')
        .set(CSRF_HEADER_NAME, token);

      expect(validWithBoth.status).toBe(200);
      expect(validWithBoth.body).toEqual({ ok: true });
    });

    it.each(['post', 'put', 'patch', 'delete'] as const)(
      'allows cookie-authenticated %s requests with matching fluxora_csrf cookie and X-CSRF-Token header',
      async (method) => {
        const app = createTestApp();
        const token = generateCsrfToken();

        const res = await request(app)
          [method]('/resource')
          .set('Cookie', `session=active; ${CSRF_COOKIE_NAME}=${token}`)
          .set('X-CSRF-Token', token);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      }
    );

    it('uses the first element when x-csrf-token header is supplied as an array', () => {
      const token = generateCsrfToken();
      const req = makeMockReq({
        method: 'POST',
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
          [CSRF_HEADER_NAME]: [token, 'ignored-second'] as unknown as string,
        },
      });
      const { res } = makeMockRes();
      const next = vi.fn();

      csrfMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
