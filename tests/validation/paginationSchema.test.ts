/**
 * Dedicated unit tests for src/validation/paginationSchema.ts.
 *
 * Issue #1441 — Bound pagination parameters and state the maximum page size.
 *
 * Covers the pagination contract at the schema boundary:
 * - `limit` bounds: default (20), minimum (1), maximum (100), rejection above
 *   the maximum, and rejection of non-integer / non-decimal forms so the
 *   numeric cap cannot be bypassed with exponent or signed notation.
 * - `cursor`: opaque non-empty string; empty values rejected, structural
 *   validation intentionally deferred to decodeCursor() in the route.
 * - `OffsetPaginationSchema`: limit/offset coercion, bounds and defaults.
 * - Exported constants stay in sync with the enforced bounds.
 *
 * @module tests/validation/paginationSchema
 */

import { describe, it, expect } from 'vitest';
import {
  PaginationSchema,
  OffsetPaginationSchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
  STREAM_STATUS_VALUES,
} from '../../src/validation/paginationSchema.js';

/** Extract the first validation message from a failed safeParse result. */
function firstIssue(result: {
  success: boolean;
  error?: { issues: Array<{ message: string }> };
}): string {
  expect(result.success).toBe(false);
  return result.error!.issues[0]!.message;
}

describe('pagination constants', () => {
  it('exposes the documented pagination bounds', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(20);
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(MIN_PAGE_LIMIT).toBe(1);
  });

  it('bounds are internally consistent', () => {
    expect(MIN_PAGE_LIMIT).toBeGreaterThanOrEqual(1);
    expect(MAX_PAGE_LIMIT).toBeGreaterThanOrEqual(MIN_PAGE_LIMIT);
  });

  it('stream status values match the DB CHECK constraint set', () => {
    expect([...STREAM_STATUS_VALUES]).toEqual(['active', 'paused', 'completed', 'cancelled']);
  });
});

describe('PaginationSchema — limit bounds', () => {
  it('defaults to DEFAULT_PAGE_LIMIT when limit is omitted', () => {
    const result = PaginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('accepts page sizes below, at and above the default', () => {
    for (const limit of ['1', '20', '50', '100']) {
      const result = PaginationSchema.safeParse({ limit });
      expect(result.success, `limit=${limit} should parse`).toBe(true);
      if (result.success) expect(result.data.limit).toBe(Number.parseInt(limit, 10));
    }
  });

  it('accepts the minimum boundary (1)', () => {
    const result = PaginationSchema.safeParse({ limit: '1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(1);
  });

  it('accepts the maximum boundary (100)', () => {
    const result = PaginationSchema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(100);
  });

  it('rejects a page size above the maximum (101)', () => {
    const result = PaginationSchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toBe(`limit must be at most ${MAX_PAGE_LIMIT}`);
  });

  it('rejects unbounded page sizes that would scan the entire table', () => {
    for (const limit of ['1000', '10000', '999999', '1000000']) {
      const result = PaginationSchema.safeParse({ limit });
      expect(result.success, `limit=${limit} should be rejected`).toBe(false);
    }
  });

  it('rejects a page size below the minimum (0)', () => {
    const result = PaginationSchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toBe(`limit must be at least ${MIN_PAGE_LIMIT}`);
  });

  it('rejects non-integer limit strings', () => {
    for (const limit of ['2.5', '1e2', 'abc', '', ' ', '+50', '50 ', '-1', '0x10']) {
      const result = PaginationSchema.safeParse({ limit });
      expect(result.success, `limit=${JSON.stringify(limit)} should be rejected`).toBe(false);
    }
  });

  it('rejects a non-string limit (coercion boundary is strings only)', () => {
    const result = PaginationSchema.safeParse({ limit: 100 });
    expect(result.success).toBe(false);
  });

  it('cannot bypass the cap with exponent or signed notation', () => {
    // '1e3' would be 1000 if Number.parseInt were applied before the shape
    // check; the /^\d+$/ regex must reject it outright.
    const exponent = PaginationSchema.safeParse({ limit: '1e3' });
    expect(exponent.success).toBe(false);
  });
});

describe('PaginationSchema — cursor validation', () => {
  it('accepts a request without a cursor', () => {
    const result = PaginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBeUndefined();
  });

  it('accepts a non-empty opaque cursor token', () => {
    const result = PaginationSchema.safeParse({ cursor: 'eyJ2IjoxLCJsYXN0SWQiOiJhYmMifQ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBe('eyJ2IjoxLCJsYXN0SWQiOiJhYmMifQ');
  });

  it('rejects an empty cursor', () => {
    const result = PaginationSchema.safeParse({ cursor: '' });
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toBe('cursor must be a non-empty string');
  });

  it('rejects a non-string cursor (numeric query shape)', () => {
    const result = PaginationSchema.safeParse({ cursor: 12345 });
    expect(result.success).toBe(false);
  });

  it('rejects an array-valued cursor (repeated query parameter)', () => {
    const result = PaginationSchema.safeParse({ cursor: ['eyJ2IjoxfQ'] });
    expect(result.success).toBe(false);
  });

  it('accepts a whitespace-only cursor at the schema boundary (route rejects it structurally)', () => {
    // Deliberate: the schema validates non-emptiness only; structural
    // validation (base64url decode + JSON parse) lives in decodeCursor().
    const result = PaginationSchema.safeParse({ cursor: ' ' });
    expect(result.success).toBe(true);
  });
});

describe('OffsetPaginationSchema — limit/offset bounds', () => {
  it('leaves limit and offset undefined when omitted (route defaults apply)', () => {
    const result = OffsetPaginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBeUndefined();
      expect(result.data.offset).toBeUndefined();
    }
  });

  it('coerces string query params to integers', () => {
    const result = OffsetPaginationSchema.safeParse({ limit: '50', offset: '100' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(100);
    }
  });

  it('accepts the limit maximum boundary (100)', () => {
    const result = OffsetPaginationSchema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(100);
  });

  it('rejects a limit above the maximum (101)', () => {
    const result = OffsetPaginationSchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toBe(`limit must be at most ${MAX_PAGE_LIMIT}`);
  });

  it('rejects a limit below the minimum (0)', () => {
    const result = OffsetPaginationSchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
    expect(firstIssue(result)).toBe(`limit must be at least ${MIN_PAGE_LIMIT}`);
  });

  it('accepts a zero offset', () => {
    const result = OffsetPaginationSchema.safeParse({ offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.offset).toBe(0);
  });

  it('rejects a negative offset', () => {
    const result = OffsetPaginationSchema.safeParse({ offset: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer limit and offset strings', () => {
    for (const query of [
      { limit: 'ten' },
      { limit: '1.5' },
      { offset: 'ten' },
      { offset: '1.5' },
    ]) {
      const result = OffsetPaginationSchema.safeParse(query);
      expect(result.success, `query=${JSON.stringify(query)} should be rejected`).toBe(false);
    }
  });
});
