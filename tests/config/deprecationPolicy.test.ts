/**
 * Sunset-date policy for the deprecation registry (`src/config/deprecations.ts`).
 *
 * These tests are the CI gate the issue asks for: an entry without a sunset
 * date fails, and a sunset date that has already passed fails until the
 * endpoint is removed or the date is deliberately extended. They also assert
 * that the configured date reaches clients through the Sunset header.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  assertDeprecationSunsetDates,
  findDeprecationViolations,
  DeprecationPolicyError,
  type DeprecationViolation,
} from '../../src/config/deprecationPolicy.js';
import { routeDeprecations } from '../../src/config/deprecations.js';
import { createDeprecationMiddleware } from '../../src/middleware/deprecation.js';
import { logger } from '../../src/logging/logger.js';

const NOW = new Date('2026-09-01T00:00:00.000Z');

function codes(violations: DeprecationViolation[]): string[] {
  return violations.map((violation) => violation.code);
}

function mockRequest(path: string): Request {
  return {
    path,
    method: 'GET',
    correlationId: 'test-correlation-id',
  } as unknown as Request;
}

function mockResponse(): Response & {
  headers: Map<string, string | string[] | number>;
} {
  const headers = new Map<string, string | string[] | number>();
  const res = {
    headers,
    setHeader: (name: string, value: string | string[] | number) => {
      headers.set(name, value);
      return res;
    },
    getHeader: (name: string) => headers.get(name),
  } as unknown as Response & {
    headers: Map<string, string | string[] | number>;
  };
  return res;
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the committed deprecation registry', () => {
  it('validates at the current instant (fails CI once a sunset date passes)', () => {
    expect(() => assertDeprecationSunsetDates(routeDeprecations)).not.toThrow();
  });

  it('gives every entry a non-empty, parseable sunset date', () => {
    expect(routeDeprecations.length).toBeGreaterThan(0);
    for (const entry of routeDeprecations) {
      expect(typeof entry.sunsetDate).toBe('string');
      expect(entry.sunsetDate.trim().length).toBeGreaterThan(0);
      expect(Number.isNaN(new Date(entry.sunsetDate).getTime())).toBe(false);
    }
  });

  it('has no future-dated policy violations as of the reference instant', () => {
    expect(findDeprecationViolations(routeDeprecations, NOW)).toEqual([]);
  });

  it('surfaces each configured sunset date through the Sunset header', () => {
    const middleware = createDeprecationMiddleware(routeDeprecations);
    const next: NextFunction = vi.fn();

    for (const entry of routeDeprecations) {
      const res = mockResponse();
      middleware(mockRequest(entry.route), res, next);

      expect(res.headers.get('Deprecation')).toBe('true');
      expect(res.headers.get('Sunset')).toBe(new Date(entry.sunsetDate).toUTCString());
    }

    expect(next).toHaveBeenCalledTimes(routeDeprecations.length);
  });
});

describe('findDeprecationViolations', () => {
  it('accepts an entry with a future sunset date', () => {
    const violations = findDeprecationViolations(
      [{ route: '/api/legacy', sunsetDate: '2026-12-31T00:00:00.000Z' }],
      NOW,
    );
    expect(violations).toEqual([]);
  });

  it('flags an entry that has no sunset date at all', () => {
    const entry = { route: '/api/legacy' } as { route: string; sunsetDate: string };
    const violations = findDeprecationViolations([entry], NOW);

    expect(codes(violations)).toEqual(['MISSING_SUNSET']);
    expect(violations[0]?.route).toBe('/api/legacy');
  });

  it('flags a blank sunset date as missing', () => {
    const violations = findDeprecationViolations(
      [{ route: '/api/legacy', sunsetDate: '   ' }],
      NOW,
    );
    expect(codes(violations)).toEqual(['MISSING_SUNSET']);
  });

  it('flags an unparseable sunset date', () => {
    const violations = findDeprecationViolations(
      [{ route: '/api/legacy', sunsetDate: 'not-a-date' }],
      NOW,
    );

    expect(codes(violations)).toEqual(['INVALID_SUNSET']);
    expect(violations[0]?.sunsetDate).toBe('not-a-date');
  });

  it('flags a sunset date that has already passed', () => {
    const violations = findDeprecationViolations(
      [{ route: '/api/legacy', sunsetDate: '2025-12-31T00:00:00.000Z' }],
      NOW,
    );

    expect(codes(violations)).toEqual(['PAST_SUNSET']);
    expect(violations[0]?.message).toContain('2025-12-31T00:00:00.000Z');
  });

  it('treats the sunset instant itself as reached', () => {
    const violations = findDeprecationViolations(
      [{ route: '/api/legacy', sunsetDate: NOW.toISOString() }],
      NOW,
    );
    expect(codes(violations)).toEqual(['PAST_SUNSET']);
  });

  it('reports every violation in registry order', () => {
    const violations = findDeprecationViolations(
      [
        { route: '/api/a', sunsetDate: '2025-01-01T00:00:00.000Z' },
        { route: '/api/b' } as { route: string; sunsetDate: string },
        { route: '/api/c', sunsetDate: 'whenever' },
        { route: '/api/d', sunsetDate: '2027-01-01T00:00:00.000Z' },
      ],
      NOW,
    );

    expect(violations.map((violation) => violation.route)).toEqual([
      '/api/a',
      '/api/b',
      '/api/c',
    ]);
    expect(codes(violations)).toEqual([
      'PAST_SUNSET',
      'MISSING_SUNSET',
      'INVALID_SUNSET',
    ]);
  });

  it('does not mutate the caller array', () => {
    const entries = [{ route: '/api/legacy', sunsetDate: '2025-01-01T00:00:00.000Z' }];
    findDeprecationViolations(entries, NOW);
    expect(entries).toEqual([
      { route: '/api/legacy', sunsetDate: '2025-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('assertDeprecationSunsetDates', () => {
  it('throws a DeprecationPolicyError carrying every violation', () => {
    let caught: unknown;
    try {
      assertDeprecationSunsetDates(
        [
          { route: '/api/a' } as { route: string; sunsetDate: string },
          { route: '/api/b', sunsetDate: '2020-01-01T00:00:00.000Z' },
        ],
        NOW,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeprecationPolicyError);
    const error = caught as DeprecationPolicyError;
    expect(error.violations).toHaveLength(2);
    expect(error.message).toContain('/api/a');
  });

  it('accepts an empty registry', () => {
    expect(() => assertDeprecationSunsetDates([], NOW)).not.toThrow();
  });
});
