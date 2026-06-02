import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createDeprecationMiddleware, deprecate } from '../../../src/middleware/deprecation.js';
import { logger } from '../../../src/logging/logger.js';

function mockRequest(path: string, method = 'GET'): Request {
  return {
    path,
    method,
    correlationId: 'test-correlation-id',
  } as Request;
}

function mockResponse(): Response & {
  headers: Map<string, string | string[] | number>;
  setHeader: ReturnType<typeof vi.fn>;
  getHeader: ReturnType<typeof vi.fn>;
} {
  const headers = new Map<string, string | string[] | number>();
  const res = {
    headers,
    setHeader: vi.fn((name: string, value: string | string[] | number) => {
      headers.set(name, value);
      return res;
    }),
    getHeader: vi.fn((name: string) => headers.get(name)),
  } as unknown as Response & {
    headers: Map<string, string | string[] | number>;
    setHeader: ReturnType<typeof vi.fn>;
    getHeader: ReturnType<typeof vi.fn>;
  };

  return res;
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('deprecation middleware', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches Deprecation, Sunset, and Link headers for a deprecated route', () => {
    const middleware = deprecate(
      '/api/legacy',
      '2026-06-30T00:00:00.000Z',
      'https://docs.fluxora.example/migrate',
    );
    const req = mockRequest('/api/legacy');
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('Tue, 30 Jun 2026 00:00:00 GMT');
    expect(res.headers.get('Link')).toBe('<https://docs.fluxora.example/migrate>; rel="deprecation"');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not attach headers to unrelated routes', () => {
    const middleware = deprecate('/api/legacy', '2026-06-30T00:00:00.000Z');
    const req = mockRequest('/api/streams');
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('serves past-sunset routes and logs a warning', () => {
    const middleware = deprecate('/api/legacy', '2025-12-31T00:00:00.000Z');
    const req = mockRequest('/api/legacy');
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('Wed, 31 Dec 2025 00:00:00 GMT');
    expect(logger.warn).toHaveBeenCalledWith(
      'deprecated route is past its sunset date',
      expect.objectContaining({
        method: 'GET',
        path: '/api/legacy',
        route: '/api/legacy',
        sunsetDate: '2025-12-31T00:00:00.000Z',
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('works when no Link URL is provided', () => {
    const middleware = deprecate('/api/legacy', '2026-06-30T00:00:00.000Z');
    const req = mockRequest('/api/legacy');
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('Tue, 30 Jun 2026 00:00:00 GMT');
    expect(res.headers.has('Link')).toBe(false);
  });

  it('handles multiple deprecated route matches on one request', () => {
    const middleware = createDeprecationMiddleware([
      {
        route: '/api',
        sunsetDate: '2026-12-31T00:00:00.000Z',
        link: 'https://docs.fluxora.example/api',
      },
      {
        route: '/api/legacy',
        sunsetDate: '2026-06-30T00:00:00.000Z',
        link: 'https://docs.fluxora.example/legacy',
      },
    ]);
    const req = mockRequest('/api/legacy/transfers');
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('Tue, 30 Jun 2026 00:00:00 GMT');
    expect(res.headers.get('Link')).toBe(
      '<https://docs.fluxora.example/api>; rel="deprecation", <https://docs.fluxora.example/legacy>; rel="deprecation"',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe header values during middleware creation', () => {
    expect(() => deprecate('/api/legacy', '2026-06-30T00:00:00.000Z\r\nX-Bad: yes')).toThrow(
      'Sunset date must not contain CR or LF characters',
    );
    expect(() => deprecate('/api/legacy', '2026-06-30T00:00:00.000Z', '/docs\r\nX-Bad: yes')).toThrow(
      'Link URL must not contain CR or LF characters',
    );
  });
});
