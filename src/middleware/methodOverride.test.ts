import { describe, expect, it, vi } from 'vitest';
import { methodOverrideMiddleware, validateOverrideMethod } from './methodOverride.js';

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    path: '/api/streams/stream-1',
    headers: {
      'x-http-method-override': 'DELETE',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    ...overrides,
  } as any;
}

function response() {
  const res: any = {
    locals: {},
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('method override authorization boundary', () => {
  it('rewrites the method before downstream authorization runs', () => {
    const req = request();
    const next = vi.fn(() => {
      expect(req.method).toBe('DELETE');
    });

    methodOverrideMiddleware(req, response(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('does not let an unauthenticated request select a privileged method', () => {
    const req = request({
      headers: { 'x-http-method-override': 'DELETE', 'content-type': 'application/json' },
    });
    const next = vi.fn();

    methodOverrideMiddleware(req, response(), next);

    expect(req.method).toBe('POST');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects an override outside the documented allowlist', () => {
    const req = request({ headers: { ...request().headers, 'x-http-method-override': 'CONNECT' } });
    const res = response();

    methodOverrideMiddleware(req, res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(req.method).toBe('POST');
  });

  it('never applies overrides on public endpoints', () => {
    const req = request({ path: '/api/auth/session' });
    const next = vi.fn();

    methodOverrideMiddleware(req, response(), next);

    expect(req.method).toBe('POST');
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts only PATCH, PUT, and DELETE', () => {
    expect(validateOverrideMethod('patch')).toBe('PATCH');
    expect(validateOverrideMethod('PUT')).toBe('PUT');
    expect(validateOverrideMethod('delete')).toBe('DELETE');
    expect(validateOverrideMethod('GET')).toBeNull();
    expect(validateOverrideMethod('TRACE')).toBeNull();
  });
});
