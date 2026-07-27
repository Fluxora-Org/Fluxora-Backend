import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  methodOverrideMiddleware,
  validateOverrideMethod,
  logMethodOverride,
} from '../../src/middleware/methodOverride.js';
import { logger } from '../../src/lib/logger.js';

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    method: 'POST',
    headers: {},
    query: {},
    path: '/api/streams/stream-123',
    correlationId: 'test-correlation-id',
    ...overrides,
  } as any;
}

function createMockRes(): Partial<Response> & {
  _statusCode: number;
  _body: any;
  locals: Record<string, any>;
} {
  const res: any = {
    _statusCode: 200,
    _body: undefined,
    locals: {},
    status(code: number) {
      this._statusCode = code;
      return this;
    },
    json(body: any) {
      this._body = body;
      return this;
    },
  };
  return res;
}

describe('validateOverrideMethod helper', () => {
  it('validates supported methods (PATCH, PUT, DELETE)', () => {
    expect(validateOverrideMethod('PATCH')).toBe('PATCH');
    expect(validateOverrideMethod('PUT')).toBe('PUT');
    expect(validateOverrideMethod('DELETE')).toBe('DELETE');
  });

  it('normalizes lowercase values', () => {
    expect(validateOverrideMethod('patch')).toBe('PATCH');
    expect(validateOverrideMethod('put')).toBe('PUT');
    expect(validateOverrideMethod('delete')).toBe('DELETE');
  });

  it('handles array input from query/header', () => {
    expect(validateOverrideMethod(['PATCH', 'DELETE'])).toBe('PATCH');
  });

  it('rejects unsupported methods (GET, POST, OPTIONS, HEAD, TRACE, CONNECT)', () => {
    expect(validateOverrideMethod('GET')).toBeNull();
    expect(validateOverrideMethod('POST')).toBeNull();
    expect(validateOverrideMethod('OPTIONS')).toBeNull();
    expect(validateOverrideMethod('HEAD')).toBeNull();
    expect(validateOverrideMethod('TRACE')).toBeNull();
    expect(validateOverrideMethod('CONNECT')).toBeNull();
  });

  it('rejects arbitrary strings, malformed values, and non-string inputs', () => {
    expect(validateOverrideMethod('FOOBAR')).toBeNull();
    expect(validateOverrideMethod('')).toBeNull();
    expect(validateOverrideMethod('   ')).toBeNull();
    expect(validateOverrideMethod(123)).toBeNull();
    expect(validateOverrideMethod(null)).toBeNull();
    expect(validateOverrideMethod(undefined)).toBeNull();
    expect(validateOverrideMethod([])).toBeNull();
  });
});

describe('logMethodOverride helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs audit event with user identity from req.user', () => {
    const req = createMockReq({
      user: { address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' } as any,
    });

    logMethodOverride(req as Request, 'POST', 'PATCH');

    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({
        event: 'http_method_override',
        originalMethod: 'POST',
        effectiveMethod: 'PATCH',
        user: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        path: '/api/streams/stream-123',
      }),
    );
  });

  it('logs audit event with user sub, role, or fallback identity', () => {
    const reqSub = createMockReq({
      user: { sub: 'sub-123' } as any,
    });
    logMethodOverride(reqSub as Request, 'POST', 'PATCH');
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({ user: 'sub-123' }),
    );

    const reqRole = createMockReq({
      user: { role: 'operator' } as any,
    });
    logMethodOverride(reqRole as Request, 'POST', 'PATCH');
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({ user: 'operator' }),
    );

    const reqFallback = createMockReq({
      user: {} as any,
    });
    logMethodOverride(reqFallback as Request, 'POST', 'PATCH');
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({ user: 'authenticated_user' }),
    );
  });

  it('logs audit event with keyId when user object is absent', () => {
    const req = createMockReq({
      keyId: 'key_abc123',
    } as any);

    logMethodOverride(req as Request, 'POST', 'DELETE');

    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({
        effectiveMethod: 'DELETE',
        user: 'key:key_abc123',
      }),
    );
  });

  it('logs credential_header_present when neither req.user nor keyId is set', () => {
    const req = createMockReq({
      headers: { authorization: 'Bearer token' },
    });

    logMethodOverride(req as Request, 'POST', 'PUT');

    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({
        effectiveMethod: 'PUT',
        user: 'credential_header_present',
      }),
    );
  });
});

describe('methodOverrideMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('✓ GET ignored — does not override non-POST requests', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'GET',
      headers: { 'x-http-method-override': 'DELETE', authorization: 'Bearer token' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('GET');
  });

  it('✓ POST without override — proceeds without modification', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('POST');
  });

  it('✓ unauthenticated route unaffected — ignores public / unauthenticated paths', () => {
    const publicPaths = ['/health', '/api/auth/login', '/internal/webhooks', '/docs', '/metrics', '/'];
    for (const path of publicPaths) {
      let nextCalled = false;
      const req = createMockReq({
        method: 'POST',
        path,
        headers: { 'x-http-method-override': 'DELETE', authorization: 'Bearer token' },
      });
      const res = createMockRes();
      const next = () => { nextCalled = true; };

      methodOverrideMiddleware(req as Request, res as Response, next);

      expect(nextCalled).toBe(true);
      expect(req.method).toBe('POST');
    }
  });

  it('✓ unauthenticated route unaffected — ignores request without credentials/user', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: { 'x-http-method-override': 'DELETE' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('POST');
  });

  it('✓ PATCH override — rewrites POST to PATCH for authenticated route', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'PATCH',
        authorization: 'Bearer valid-token',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('PATCH');
    expect(logger.info).toHaveBeenCalled();
  });

  it('✓ PUT override — rewrites POST to PUT', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'PUT',
        'x-api-key': 'valid-api-key',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('PUT');
  });

  it('✓ DELETE override — rewrites POST to DELETE', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'DELETE',
        authorization: 'Bearer token',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('DELETE');
  });

  it('✓ lowercase override values — normalizes lowercase string to uppercase', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'patch',
        authorization: 'Bearer token',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('PATCH');
  });

  it('✓ query override — supports query string _method parameter', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      query: { _method: 'DELETE' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('DELETE');
  });

  it('✓ header precedence over query — header overrides query param when both exist', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'PUT',
        authorization: 'Bearer token',
      },
      query: { _method: 'DELETE' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('PUT');
  });

  it('✓ unsupported override returns 400 — rejects unsupported methods', () => {
    const invalidMethods = ['GET', 'POST', 'OPTIONS', 'HEAD', 'TRACE', 'CONNECT', 'INVALID'];
    for (const method of invalidMethods) {
      const req = createMockReq({
        method: 'POST',
        headers: {
          'x-http-method-override': method,
          authorization: 'Bearer token',
        },
      });
      const res = createMockRes();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      methodOverrideMiddleware(req as Request, res as Response, next);

      expect(nextCalled).toBe(false);
      expect(res._statusCode).toBe(400);
      expect(res._body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining(`Unsupported method override: ${method}`),
          requestId: 'test-correlation-id',
        }),
      });
    }
  });

  it('✓ malformed values rejected — handles empty or array values gracefully', () => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': '   ',
        authorization: 'Bearer token',
      },
    });
    const res = createMockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    // Whitespace string is treated as no override -> proceeds as POST
    expect(nextCalled).toBe(true);
    expect(req.method).toBe('POST');
  });

  it('✓ authenticated route overridden — works when req.user is set', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      user: { role: 'admin' } as any,
      headers: {
        'x-http-method-override': 'DELETE',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('DELETE');
  });

  it('✓ audit logging occurs — calls logger.info on valid override', () => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'PATCH',
        authorization: 'Bearer token',
      },
    });
    const res = createMockRes();
    const next = vi.fn();

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP method overridden',
      'test-correlation-id',
      expect.objectContaining({
        originalMethod: 'POST',
        effectiveMethod: 'PATCH',
      }),
    );
  });

  it('handles array of invalid methods and originalUrl fallback', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      path: undefined as any,
      originalUrl: '/api/streams/test',
      headers: {
        authorization: 'Bearer token',
      },
      query: {
        _method: ['INVALID_METHOD'] as any,
      },
    });
    const res = createMockRes();
    res.locals['requestId'] = 'fallback-request-id';
    delete (req as any).correlationId;

    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(false);
    expect(res._statusCode).toBe(400);
    expect(res._body.error.requestId).toBe('fallback-request-id');
    expect(res._body.error.message).toContain('INVALID_METHOD');
  });

  it('allows override when keyScopes is set on req', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      keyScopes: ['streams:write'] as any,
      headers: {
        'x-http-method-override': 'PATCH',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('PATCH');
  });

  it('✓ existing middleware chain unaffected — passes through normal POST requests', () => {
    const req = createMockReq({
      method: 'POST',
      headers: { content_type: 'application/json' },
    });
    const res = createMockRes();
    const next = vi.fn();

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.method).toBe('POST');
  });
});
