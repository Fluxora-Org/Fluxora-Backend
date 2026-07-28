/**
 * Unit tests for SDK cursor pagination helpers (sdk/typescript/src/pagination.ts).
 *
 * Covers:
 * - Validation of limit (bounds, type, NaN, Infinity)
 * - Cursor lifecycle (null, undefined, empty string, valid)
 * - Idempotent exhaustion (nextPage after hasMore=false)
 * - autoPaginate with 0, 1, or multiple pages
 * - Concurrent in-flight guard
 * - Page-limit safety (maxPages guard)
 * - Exported constants
 * - State getters (currentCursor, hasMorePages, pagesFetched)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  StreamPaginator,
  DEFAULT_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  DEFAULT_MAX_PAGES,
} from '../../sdk/typescript/src/pagination.js';
import { ValidationError } from '../../sdk/typescript/src/errors.js';
import type { Stream, StreamListResponse } from '../../sdk/typescript/src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPage(data: Partial<Stream>[], nextCursor?: string): StreamListResponse {
  return {
    success: true,
    data: data as Stream[],
    meta: nextCursor ? { next_cursor: nextCursor } : {},
  };
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('DEFAULT_PAGE_LIMIT is 20', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(20);
  });

  it('MIN_PAGE_LIMIT is 1', () => {
    expect(MIN_PAGE_LIMIT).toBe(1);
  });

  it('MAX_PAGE_LIMIT is 100', () => {
    expect(MAX_PAGE_LIMIT).toBe(100);
  });

  it('DEFAULT_MAX_PAGES is 10_000', () => {
    expect(DEFAULT_MAX_PAGES).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Constructor – limit validation
// ---------------------------------------------------------------------------

describe('constructor limit validation', () => {
  const dummy = vi.fn();

  it('accepts limit = 1 (lower bound)', () => {
    expect(() => new StreamPaginator(dummy, { limit: 1 })).not.toThrow();
  });

  it('accepts limit = 100 (upper bound)', () => {
    expect(() => new StreamPaginator(dummy, { limit: 100 })).not.toThrow();
  });

  it('accepts limit = 20 (default)', () => {
    expect(() => new StreamPaginator(dummy, { limit: 20 })).not.toThrow();
  });

  it('defaults limit to 20 when omitted', () => {
    const p = new StreamPaginator(dummy);
    expect((p as any).limit).toBe(20);
  });

  it('throws ValidationError for limit = 0', () => {
    expect(() => new StreamPaginator(dummy, { limit: 0 })).toThrow(ValidationError);
  });

  it('throws ValidationError for limit = -1', () => {
    expect(() => new StreamPaginator(dummy, { limit: -1 })).toThrow(ValidationError);
  });

  it('throws ValidationError for limit = 101', () => {
    expect(() => new StreamPaginator(dummy, { limit: 101 })).toThrow(ValidationError);
  });

  it('throws ValidationError for float limit = 20.5', () => {
    expect(() => new StreamPaginator(dummy, { limit: 20.5 })).toThrow(ValidationError);
  });

  it('throws ValidationError for NaN limit', () => {
    expect(() => new StreamPaginator(dummy, { limit: NaN })).toThrow(ValidationError);
  });

  it('throws ValidationError for Infinity limit', () => {
    expect(() => new StreamPaginator(dummy, { limit: Infinity })).toThrow(ValidationError);
  });

  it('throws ValidationError for negative Infinity limit', () => {
    expect(() => new StreamPaginator(dummy, { limit: -Infinity })).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// nextPage – happy path (single page, multi-page)
// ---------------------------------------------------------------------------

describe('nextPage happy path', () => {
  it('returns items from a single page with no cursor (last page)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }, { id: 's2' }]));
    const p = new StreamPaginator(fetcher, { limit: 20 });

    const page = await p.nextPage();
    expect(page).toHaveLength(2);
    expect(page![0].id).toBe('s1');
    expect(page![1].id).toBe('s2');
  });

  it('chains cursors across multiple pages', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'cursor-2'))
      .mockResolvedValueOnce(mockPage([{ id: 's2' }], 'cursor-3'))
      .mockResolvedValueOnce(mockPage([{ id: 's3' }]));

    const p = new StreamPaginator(fetcher, { limit: 1 });

    const p1 = await p.nextPage();
    expect(p1).toEqual([{ id: 's1' }]);
    expect(p.currentCursor).toBe('cursor-2');
    expect(p.hasMorePages).toBe(true);

    const p2 = await p.nextPage();
    expect(p2).toEqual([{ id: 's2' }]);
    expect(p.currentCursor).toBe('cursor-3');
    expect(p.hasMorePages).toBe(true);

    const p3 = await p.nextPage();
    expect(p3).toEqual([{ id: 's3' }]);
    expect(p.hasMorePages).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextPage – cursor edge cases
// ---------------------------------------------------------------------------

describe('nextPage cursor edge cases', () => {
  it('stops pagination when meta.next_cursor is undefined', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
    const p = new StreamPaginator(fetcher);

    await p.nextPage();
    expect(p.hasMorePages).toBe(false);
  });

  it('stops pagination when meta is absent (null)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: 's1' }] as Stream[],
    });
    const p = new StreamPaginator(fetcher);

    const page = await p.nextPage();
    expect(page).toHaveLength(1);
    expect(p.hasMorePages).toBe(false);
  });

  it('stops pagination when meta is undefined (no meta key)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: 's1' }] as Stream[],
      meta: undefined,
    });
    const p = new StreamPaginator(fetcher);

    const page = await p.nextPage();
    expect(page).toHaveLength(1);
    expect(p.hasMorePages).toBe(false);
  });

  it('stops pagination when next_cursor is an empty string', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockPage([{ id: 's1' }], ''),
    );
    const p = new StreamPaginator(fetcher);

    await p.nextPage();
    expect(p.hasMorePages).toBe(false);
    expect(p.currentCursor).toBeNull();
  });

  it('stops pagination when next_cursor is a non-string (number)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: 's1' }] as Stream[],
      meta: { next_cursor: 0 },
    });
    const p = new StreamPaginator(fetcher);

    await p.nextPage();
    expect(p.hasMorePages).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextPage – idempotent exhaustion
// ---------------------------------------------------------------------------

describe('nextPage idempotent exhaustion', () => {
  it('returns null when hasMore is already false', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
    const p = new StreamPaginator(fetcher);

    await p.nextPage();
    expect(p.hasMorePages).toBe(false);

    const result = await p.nextPage();
    expect(result).toBeNull();
  });

  it('does not call fetchPage after exhaustion', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
    const p = new StreamPaginator(fetcher);

    await p.nextPage();
    await p.nextPage();
    await p.nextPage();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns null immediately if constructed with empty data and no cursor', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([]));
    const p = new StreamPaginator(fetcher);

    const result = await p.nextPage();
    expect(result).toEqual([]);
    expect(p.hasMorePages).toBe(false);

    expect(await p.nextPage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextPage – data edge cases
// ---------------------------------------------------------------------------

describe('nextPage data edge cases', () => {
  it('handles response.data being null', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      success: true,
      data: null,
      meta: {},
    });
    const p = new StreamPaginator(fetcher);

    const page = await p.nextPage();
    expect(page).toEqual([]);
    expect(p.hasMorePages).toBe(false);
  });

  it('handles response.data being undefined', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      success: true,
      meta: {},
    });
    const p = new StreamPaginator(fetcher);

    const page = await p.nextPage();
    expect(page).toEqual([]);
    expect(p.hasMorePages).toBe(false);
  });

  it('returns empty array when data is an empty array', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([]));
    const p = new StreamPaginator(fetcher);

    const page = await p.nextPage();
    expect(page).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// autoPaginate
// ---------------------------------------------------------------------------

describe('autoPaginate', () => {
  it('yields nothing when API returns empty', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([]));
    const p = new StreamPaginator(fetcher);

    const items: Stream[] = [];
    for await (const item of p.autoPaginate()) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('yields items from a single page', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockPage([{ id: 's1' }, { id: 's2' }]),
    );
    const p = new StreamPaginator(fetcher);

    const items: Stream[] = [];
    for await (const item of p.autoPaginate()) {
      items.push(item);
    }
    expect(items).toHaveLength(2);
  });

  it('yields all items across multiple pages', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
      .mockResolvedValueOnce(mockPage([{ id: 's2' }], 'c3'))
      .mockResolvedValueOnce(mockPage([{ id: 's3' }]));

    const p = new StreamPaginator(fetcher, { limit: 1 });
    const items: Stream[] = [];
    for await (const item of p.autoPaginate()) {
      items.push(item);
    }
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toEqual(['s1', 's2', 's3']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Concurrent in-flight guard
// ---------------------------------------------------------------------------

describe('concurrent in-flight guard', () => {
  it('throws if nextPage is called while a request is in-flight', async () => {
    let resolveFetch!: (value: StreamListResponse) => void;
    const fetcher = vi.fn().mockReturnValue(
      new Promise<StreamListResponse>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const p = new StreamPaginator(fetcher, { limit: 20 });

    const firstCall = p.nextPage();
    await expect(p.nextPage()).rejects.toThrow('Concurrent nextPage call detected');
    resolveFetch!(mockPage([{ id: 's1' }]));
    await firstCall;
  });
});

// ---------------------------------------------------------------------------
// Page-limit safety (maxPages)
// ---------------------------------------------------------------------------

describe('page-limit safety (maxPages)', () => {
  it('throws after reaching maxPages when server keeps returning cursors', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockPage([{ id: 's1' }], 'still-more'),
    );
    const p = new StreamPaginator(fetcher, { limit: 1 }, 3);

    await p.nextPage();
    await p.nextPage();
    await p.nextPage();
    await expect(p.nextPage()).rejects.toThrow(
      'Pagination safety limit reached: fetched 3 pages without terminal cursor',
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// State getters
// ---------------------------------------------------------------------------

describe('state getters', () => {
  it('currentCursor starts as null', () => {
    const fetcher = vi.fn();
    const p = new StreamPaginator(fetcher);
    expect(p.currentCursor).toBeNull();
  });

  it('currentCursor reflects latest cursor after a page fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }], 'next-cursor'));
    const p = new StreamPaginator(fetcher);
    expect(p.currentCursor).toBeNull();

    await p.nextPage();
    expect(p.currentCursor).toBe('next-cursor');
  });

  it('hasMorePages starts as true', () => {
    const fetcher = vi.fn();
    const p = new StreamPaginator(fetcher);
    expect(p.hasMorePages).toBe(true);
  });

  it('hasMorePages becomes false on last page', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
    const p = new StreamPaginator(fetcher);
    expect(p.hasMorePages).toBe(true);

    await p.nextPage();
    expect(p.hasMorePages).toBe(false);
  });

  it('pagesFetched starts at 0', () => {
    const fetcher = vi.fn();
    const p = new StreamPaginator(fetcher);
    expect(p.pagesFetched).toBe(0);
  });

  it('pagesFetched increments on each successful page fetch', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
      .mockResolvedValueOnce(mockPage([{ id: 's2' }]));

    const p = new StreamPaginator(fetcher);
    expect(p.pagesFetched).toBe(0);

    await p.nextPage();
    expect(p.pagesFetched).toBe(1);

    await p.nextPage();
    expect(p.pagesFetched).toBe(2);
  });

  it('pagesFetched does not increment when hasMore is false (exhausted call)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
    const p = new StreamPaginator(fetcher);

    await p.nextPage();
    expect(p.pagesFetched).toBe(1);

    await p.nextPage();
    expect(p.pagesFetched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('error propagation', () => {
  it('propagates errors thrown by fetchPage', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network error'));
    const p = new StreamPaginator(fetcher);

    await expect(p.nextPage()).rejects.toThrow('Network error');
  });
});