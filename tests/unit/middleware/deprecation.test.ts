import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createDeprecationMiddleware, deprecate, retiredRoute } from '../../../src/middleware/deprecation.js';
import { logger } from '../../../src/lib/logger.js';
import { deprecatedRouteHitsTotal } from '../../../src/metrics.js';

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
  statusCode: number;
  jsonBody: unknown;
} {
  const headers = new Map<string, string | string[] | number>();
  const res = {
    headers,
    statusCode: 200,
    jsonBody: undefined as unknown,
    setHeader: vi.fn((name: string, value: string | string[] | number) => {
      headers.set(name, value);
      return res;
    }),
    getHeader: vi.fn((name: string) => headers.get(name)),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.jsonBody = body;
      return res;
    }),
  } as unknown as Response & {
    headers: Map<string, string | string[] | number>;
    setHeader: ReturnType<typeof vi.fn>;
    getHeader: ReturnType<typeof vi.fn>;
    statusCode: number;
    jsonBody: unknown;
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

describe('retiredRoute', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 410 Gone for a retired endpoint', () => {
    const handler = retiredRoute('2026-09-30T00:00:00.000Z');
    const req = mockRequest('/api/rate-limits/config');
    const res = mockResponse();

    handler(req, res, mockNext());

    expect(res.statusCode).toBe(410);
    expect(res.headers.get('Sunset')).toBe('Wed, 30 Sep 2026 00:00:00 GMT');
  });

  it('includes the machine-readable ENDPOINT_RETIRED error code in the body', () => {
    const handler = retiredRoute('2026-09-30T00:00:00.000Z');
    const req = mockRequest('/api/rate-limits/config');
    const res = mockResponse();

    handler(req, res, mockNext());

    expect((res.jsonBody as { error: string }).error).toBe('ENDPOINT_RETIRED');
  });

  it('sets a Link header when a migration URL is provided', () => {
    const handler = retiredRoute(
      '2026-09-30T00:00:00.000Z',
      '/docs/api/deprecation-policy.md#current-deprecations',
    );
    const req = mockRequest('/api/rate-limits/config');
    const res = mockResponse();

    handler(req, res, mockNext());

    expect(res.headers.get('Link')).toBe(
      '</docs/api/deprecation-policy.md#current-deprecations>; rel="deprecation"',
    );
    expect((res.jsonBody as { link: string }).link).toBe(
      '/docs/api/deprecation-policy.md#current-deprecations',
    );
  });

  it('omits the Link header when no migration URL is given', () => {
    const handler = retiredRoute('2026-09-30T00:00:00.000Z');
    const req = mockRequest('/api/rate-limits/config');
    const res = mockResponse();

    handler(req, res, mockNext());

    expect(res.headers.has('Link')).toBe(false);
  });

  it('logs a structured warning for every hit', () => {
    const handler = retiredRoute('2026-09-30T00:00:00.000Z');
    const req = mockRequest('/api/rate-limits/config');
    const res = mockResponse();

    handler(req, res, mockNext());

    expect(logger.warn).toHaveBeenCalledWith(
      'request to retired endpoint',
      expect.objectContaining({
        event: 'route.retired.hit',
        method: 'GET',
        path: '/api/rate-limits/config',
      }),
    );
  });

  it('rejects unsafe CR/LF in sunsetDate at creation time', () => {
    expect(() => retiredRoute('2026-09-30T00:00:00.000Z\r\nX-Bad: yes')).toThrow(
      'Sunset date must not contain CR or LF characters',
    );
  });

  it('rejects unsafe CR/LF in the link URL at creation time', () => {
    expect(() =>
      retiredRoute('2026-09-30T00:00:00.000Z', '/docs\r\nX-Injected: yes'),
    ).toThrow('Link URL must not contain CR or LF characters');
  });
});

describe('deprecated route hit metric', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('increments deprecatedRouteHitsTotal for each matched deprecated route', async () => {
    const route = '/api/metric-test-route';
    const middleware = deprecate(route, '2026-12-31T00:00:00.000Z');
    const req = mockRequest(route);
    const res = mockResponse();
    const next = mockNext();

    const metricBefore = await deprecatedRouteHitsTotal.get();
    const valueBefore =
      metricBefore.values.find((v) => v.labels['route'] === route)?.value ?? 0;

    middleware(req, res, next);

    const metricAfter = await deprecatedRouteHitsTotal.get();
    const valueAfter =
      metricAfter.values.find((v) => v.labels['route'] === route)?.value ?? 0;

    expect(valueAfter - valueBefore).toBe(1);
  });

  it('does not increment the counter for non-matching routes', async () => {
    const route = '/api/metric-test-no-match';
    const middleware = deprecate('/api/some-other-route', '2026-12-31T00:00:00.000Z');
    const req = mockRequest(route);
    const res = mockResponse();

    const metricBefore = await deprecatedRouteHitsTotal.get();
    const valueBefore =
      metricBefore.values.find((v) => v.labels['route'] === route)?.value ?? 0;

    middleware(req, res, mockNext());

    const metricAfter = await deprecatedRouteHitsTotal.get();
    const valueAfter =
      metricAfter.values.find((v) => v.labels['route'] === route)?.value ?? 0;

    expect(valueAfter - valueBefore).toBe(0);
  });
});
