// src/middleware/httpMetrics.test.ts
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveRoute } from './httpMetrics';

describe('resolveRoute', () => {
  it('collapses a single trailing slash on matched route', () => {
    const req = {
      baseUrl: '/users',
      route: { path: '/' } as any,
      originalUrl: ''
    } as unknown as Request;
    expect(resolveRoute(req)).toBe('/users');
  });

  it('does not collapse bare root path', () => {
    const req = {
      baseUrl: '',
      route: { path: '/' } as any,
      originalUrl: ''
    } as unknown as Request;
    expect(resolveRoute(req)).toBe('/');
  });

  it('strips query string for unmatched routes', () => {
    const req = {
      baseUrl: '',
      route: undefined,
      originalUrl: '/search?q=test&page=2'
    } as unknown as Request;
    expect(resolveRoute(req)).toBe('/search');
  });

  it('removes only one trailing slash when multiple are present', () => {
    const req = {
      baseUrl: '',
      // A matched route is required for the label to be derived at all: an
      // unmatched request is labelled UNMATCHED_ROUTE (see above).
      route: { path: '/multiple///' },
      originalUrl: '/multiple///',
    });
    // After collapse of a single trailing slash, remaining empties are kept
    // by normalizeRouteLabel join; high-cardinality policy does not alter
    // static vocabulary segments.
      route: undefined,
      originalUrl: '/multiple///'
    } as unknown as Request;
    expect(resolveRoute(req)).toBe('/multiple//');
  });

  it('leaves path unchanged when no trailing slash', () => {
    const req = {
      baseUrl: '',
      route: undefined,
      originalUrl: '/no-trailing'
    } as unknown as Request;
    expect(resolveRoute(req)).toBe('/no-trailing');
  });
});
