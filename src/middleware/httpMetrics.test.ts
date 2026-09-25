// src/middleware/httpMetrics.test.ts
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveRoute, UNMATCHED_ROUTE } from './httpMetrics';

function fakeReq(partial: {
  baseUrl?: string;
  route?: { path: string } | undefined;
  originalUrl?: string;
}): Request {
  return {
    baseUrl: partial.baseUrl ?? '',
    route: partial.route as Request['route'],
    originalUrl: partial.originalUrl ?? '',
  } as unknown as Request;
}

describe('resolveRoute', () => {
  it('uses the matched route template, not the raw path', () => {
    const req = fakeReq({
      baseUrl: '/api',
      route: { path: '/users/:id' },
      originalUrl: '/api/users/12345?x=1',
    });
    expect(resolveRoute(req)).toBe('/api/users/:id');
    expect(resolveRoute(req)).not.toContain('12345');
  });

  it('collapses a single trailing slash on matched route', () => {
    const req = fakeReq({
      baseUrl: '/users',
      route: { path: '/' },
      originalUrl: '/users/',
    });
    expect(resolveRoute(req)).toBe('/users');
  });

  it('does not collapse bare root path', () => {
    const req = fakeReq({
      baseUrl: '',
      route: { path: '/' },
      originalUrl: '/',
    });
    expect(resolveRoute(req)).toBe('/');
  });

  it('labels unmatched requests with a single shared value', () => {
    const req = fakeReq({
      route: undefined,
      originalUrl: '/search?q=test&page=2',
    });
    expect(resolveRoute(req)).toBe(UNMATCHED_ROUTE);
  });

  it('never embeds path parameters from the raw URL when unmatched', () => {
    const req = fakeReq({
      route: undefined,
      originalUrl: '/users/abc-uuid-999/orders/42',
    });
    const label = resolveRoute(req);
    expect(label).toBe(UNMATCHED_ROUTE);
    expect(label).not.toMatch(/abc-uuid|\/42/);

    // Slash-heavy unmatched URLs share the same fixed label; empty segments
    // are never joined into new series, keeping cardinality bounded.
    const slashHeavy = fakeReq({
      route: undefined,
      originalUrl: '/multiple///',
    });
    expect(resolveRoute(slashHeavy)).toBe(UNMATCHED_ROUTE);
  });

  it('bounds series count across many distinct unmatched URLs', () => {
    const series = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const req = fakeReq({
        route: undefined,
        originalUrl: `/users/${i}/items/${i * 7}?q=${i}`,
      });
      series.add(resolveRoute(req));
    }
    expect(series.size).toBe(1);
    expect([...series][0]).toBe(UNMATCHED_ROUTE);
  });

  it('bounds series count across many distinct matched path params', () => {
    const series = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const req = fakeReq({
        baseUrl: '/api',
        route: { path: '/users/:userId/items/:itemId' },
        originalUrl: `/api/users/${i}/items/${i * 3}`,
      });
      series.add(resolveRoute(req));
    }
    expect(series.size).toBe(1);
    expect([...series][0]).toBe('/api/users/:userId/items/:itemId');
  });

  // NOTE: two older tests asserted that unmatched routes fall back to
  // normalizeRouteLabel('/api/streams/:id', '/api/accounts/:address'). That
  // fallback contract was retired when unmatched requests were collapsed to
  // the single UNMATCHED_ROUTE label (see the tests above); asserting both
  // contracts simultaneously is impossible, so those cases were removed.

  it('preserves Express route templates with :param placeholders', () => {
    const req = {
      baseUrl: '/api',
      route: { path: '/streams/:id' } as Request['route'],
      originalUrl: '/api/streams/550e8400-e29b-41d4-a716-446655440000'
    } as unknown as Request;
    expect(resolveRoute(req)).toBe('/api/streams/:id');
  });
});
