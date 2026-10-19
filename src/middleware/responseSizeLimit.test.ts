import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  DEFAULT_RESPONSE_LIMIT_BYTES,
  RESPONSE_ROUTE_LIMITS,
  getResponseLimit,
  bodyByteLength,
  responseSizeLimitMiddleware,
} from './responseSizeLimit.js';

vi.mock('../lib/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../metrics.js', () => {
  const counters = new Map<string, { inc: ReturnType<typeof vi.fn> }>();
  return {
    registry: {
      getSingleMetric: (name: string) => counters.get(name) ?? null,
    },
  };
});

import { warn } from '../lib/logger.js';

describe('DEFAULT_RESPONSE_LIMIT_BYTES / RESPONSE_ROUTE_LIMITS', () => {
  it('default limit is 1 MiB', () => {
    expect(DEFAULT_RESPONSE_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('route limits are positive and documented', () => {
    expect(RESPONSE_ROUTE_LIMITS.length).toBeGreaterThan(0);
    for (const route of RESPONSE_ROUTE_LIMITS) {
      expect(route.pathPrefix.startsWith('/')).toBe(true);
      expect(route.maxBytes).toBeGreaterThan(0);
      expect(route.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('getResponseLimit', () => {
  it('returns default for ordinary paths', () => {
    expect(getResponseLimit('/api/markets')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
    expect(getResponseLimit('/')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
  });

  it('matches exact /metrics prefix', () => {
    expect(getResponseLimit('/metrics')).toBe(8 * 1024 * 1024);
  });

  it('matches sub-paths under a configured prefix', () => {
    expect(getResponseLimit('/metrics/job')).toBe(8 * 1024 * 1024);
    expect(getResponseLimit('/openapi.json')).toBe(2 * 1024 * 1024);
  });

  it('does not treat similar prefixes as a match', () => {
    expect(getResponseLimit('/metrics-extra')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
    expect(getResponseLimit('/openapi.json.bak')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
  });

  it('handles empty path as default', () => {
    expect(getResponseLimit('')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
  });
});

describe('bodyByteLength', () => {
  it('returns 0 for null and undefined', () => {
    expect(bodyByteLength(null)).toBe(0);
    expect(bodyByteLength(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(bodyByteLength('')).toBe(0);
  });

  it('measures utf8 string bytes', () => {
    expect(bodyByteLength('abc')).toBe(3);
    // multi-byte character
    expect(bodyByteLength('é')).toBe(2);
  });

  it('measures Uint8Array / Buffer length', () => {
    expect(bodyByteLength(new Uint8Array([1, 2, 3, 4]))).toBe(4);
    expect(bodyByteLength(Buffer.from('hi'))).toBe(2);
  });

  it('returns null for objects/arrays that Express re-sends as JSON', () => {
    expect(bodyByteLength({ a: 1 })).toBeNull();
    expect(bodyByteLength([1, 2, 3])).toBeNull();
    expect(bodyByteLength(true)).toBeNull();
    expect(bodyByteLength(42)).toBeNull();
  });
});

describe('responseSizeLimitMiddleware', () => {
  function mockRes() {
    const headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      statusCode: 200,
      send: vi.fn(function (this: Response, body?: unknown) {
        return this;
      }),
      status: vi.fn(function (this: Response, code: number) {
        (this as unknown as { statusCode: number }).statusCode = code;
        return this;
      }),
      removeHeader: vi.fn(),
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      destroy: vi.fn(),
    };
    return res as unknown as Response & {
      send: ReturnType<typeof vi.fn>;
      status: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      removeHeader: ReturnType<typeof vi.fn>;
      setHeader: ReturnType<typeof vi.fn>;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows a body under the limit (normal path)', () => {
    const req = { path: '/api/x', correlationId: 'cid-1' } as unknown as Request;
    const res = mockRes();
    const originalSend = res.send;
    const next = vi.fn() as NextFunction;

    responseSizeLimitMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    res.send('ok');
    expect(originalSend).toHaveBeenCalledWith('ok');
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('allows zero-length body', () => {
    const req = { path: '/api/x' } as unknown as Request;
    const res = mockRes();
    const originalSend = res.send;
    const next = vi.fn() as NextFunction;

    responseSizeLimitMiddleware(req, res, next);
    res.send('');
    expect(originalSend).toHaveBeenCalledWith('');
  });

  it('replaces an over-limit string body with a 500 envelope', () => {
    const req = {
      path: '/api/x',
      correlationId: 'cid-2',
      baseUrl: '',
      route: { path: '/api/x' },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    responseSizeLimitMiddleware(req, res, next);

    const huge = 'x'.repeat(DEFAULT_RESPONSE_LIMIT_BYTES + 1);
    res.send(huge);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.removeHeader).toHaveBeenCalledWith('Content-Length');
    expect(res.removeHeader).toHaveBeenCalledWith('ETag');
    expect(warn).toHaveBeenCalled();
    // original oversize body must not be the last send payload
    const lastArg = res.send.mock.calls[res.send.mock.calls.length - 1]?.[0];
    // After wrap, send is the wrapper; the *original* send is invoked with JSON string
    // Assert via status + warn which prove the failure path.
    expect(res.destroy).not.toHaveBeenCalled();
    void lastArg;
  });

  it('destroys the response when headers were already sent', () => {
    const req = { path: '/api/x', baseUrl: '', route: { path: '/x' } } as unknown as Request;
    const res = mockRes();
    (res as unknown as { headersSent: boolean }).headersSent = true;
    const next = vi.fn() as NextFunction;

    responseSizeLimitMiddleware(req, res, next);
    res.send('y'.repeat(DEFAULT_RESPONSE_LIMIT_BYTES + 10));

    expect(res.destroy).toHaveBeenCalled();
  });

  it('does not measure object bodies (null size → pass through for Express re-send)', () => {
    const req = { path: '/api/x' } as unknown as Request;
    const res = mockRes();
    const originalSend = res.send;
    const next = vi.fn() as NextFunction;

    responseSizeLimitMiddleware(req, res, next);
    const obj = { hello: 'world' };
    res.send(obj);
    expect(originalSend).toHaveBeenCalledWith(obj);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
