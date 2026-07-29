/**
 * Stabilization tests for SDK pagination helpers (#1088).
 *
 * Locks down edge cases that were previously implicit: filter params carry-through,
 * retry-idempotent state after failure, autoPaginate early break, param immutability,
 * state getters, concurrency guard, maxPages safety cap, and empty-response resilience.
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
import type { Stream, StreamListResponse, ListStreamsParams } from '../../sdk/typescript/src/types.js';

function mockPage(streams: Partial<Stream>[], nextCursor?: string): StreamListResponse {
  return {
    success: true,
    data: {
      streams: streams as Stream[],
      has_more: !!nextCursor,
      next_cursor: nextCursor ?? null,
    },
    meta: {},
  };
}

describe('SDK Pagination Stabilization (#1088)', () => {
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

  describe('state getters', () => {
    it('currentCursor is null before any fetch', () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }], 'c2'));
      const p = new StreamPaginator(fetcher, { limit: 1 });
      expect(p.currentCursor).toBeNull();
    });

    it('currentCursor is set after a successful fetch', async () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }], 'c2'));
      const p = new StreamPaginator(fetcher, { limit: 1 });
      await p.nextPage();
      expect(p.currentCursor).toBe('c2');
    });

    it('hasMorePages is true before exhaustion', () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }], 'c2'));
      const p = new StreamPaginator(fetcher, { limit: 1 });
      expect(p.hasMorePages).toBe(true);
    });

    it('hasMorePages is false after the last page', async () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
      const p = new StreamPaginator(fetcher, { limit: 1 });
      await p.nextPage();
      expect(p.hasMorePages).toBe(false);
    });

    it('pagesFetched is 0 before any fetch', () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
      const p = new StreamPaginator(fetcher, { limit: 1 });
      expect(p.pagesFetched).toBe(0);
    });

    it('pagesFetched increments after each successful fetch', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));
      const p = new StreamPaginator(fetcher, { limit: 1 });
      await p.nextPage();
      expect(p.pagesFetched).toBe(1);
      await p.nextPage();
      expect(p.pagesFetched).toBe(2);
    });
  });

  describe('filter params carry-through', () => {
    it('forwards status filter on every page fetch', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));
      const p = new StreamPaginator(fetcher, { limit: 1, status: 'active' });
      await p.nextPage();
      await p.nextPage();
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const call of fetcher.mock.calls) {
        expect((call[0] as ListStreamsParams).status).toBe('active');
      }
    });

    it('forwards sender filter on every page fetch', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));
      const p = new StreamPaginator(fetcher, { limit: 1, sender: 'GABCDE' });
      await p.nextPage();
      await p.nextPage();
      for (const call of fetcher.mock.calls) {
        expect((call[0] as ListStreamsParams).sender).toBe('GABCDE');
      }
    });

    it('forwards recipient filter on every page fetch', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));
      const p = new StreamPaginator(fetcher, { limit: 1, recipient: 'GZYXWV' });
      await p.nextPage();
      await p.nextPage();
      for (const call of fetcher.mock.calls) {
        expect((call[0] as ListStreamsParams).recipient).toBe('GZYXWV');
      }
    });

    it('forwards include_total on every page fetch', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));
      const p = new StreamPaginator(fetcher, { limit: 1, include_total: true });
      await p.nextPage();
      await p.nextPage();
      for (const call of fetcher.mock.calls) {
        expect((call[0] as ListStreamsParams).include_total).toBe(true);
      }
    });

    it('forwards all combined filters simultaneously', async () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
      const p = new StreamPaginator(fetcher, {
        limit: 5,
        status: 'active',
        sender: 'GABCDE',
        recipient: 'GZYXWV',
        include_total: true,
      });
      await p.nextPage();
      const params = fetcher.mock.calls[0]![0] as ListStreamsParams;
      expect(params.limit).toBe(5);
      expect(params.status).toBe('active');
      expect(params.sender).toBe('GABCDE');
      expect(params.recipient).toBe('GZYXWV');
      expect(params.include_total).toBe(true);
    });
  });

  describe('retry and error recovery', () => {
    it('allows retrying after a fetch failure without advancing state', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'c2'))
        .mockRejectedValueOnce(new Error('Transient network error'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));

      const p = new StreamPaginator(fetcher, { limit: 1 });

      const p1 = await p.nextPage();
      expect(p1).toEqual([{ id: 's1' }]);

      await expect(p.nextPage()).rejects.toThrow('Transient network error');

      const p2 = await p.nextPage();
      expect(p2).toEqual([{ id: 's2' }]);

      const p3 = await p.nextPage();
      expect(p3).toBeNull();

      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  describe('concurrency guard', () => {
    it('rejects a second concurrent nextPage() call', async () => {
      let resolveFirst: (v: StreamListResponse) => void;
      const fetcher = vi.fn().mockImplementation(() => {
        return new Promise<StreamListResponse>((resolve) => {
          resolveFirst = resolve;
        });
      });

      const p = new StreamPaginator(fetcher, { limit: 1 });
      const first = p.nextPage();

      await expect(p.nextPage()).rejects.toThrow(ValidationError);

      resolveFirst!(mockPage([{ id: 's1' }]));
      await first;
    });
  });

  describe('maxPages safety cap', () => {
    it('stops autoPaginate after maxPages even when hasMore is true', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(mockPage([{ id: 's1' }], 'c2'));
      const p = new StreamPaginator(fetcher, { limit: 1, maxPages: 2 });

      const items: Stream[] = [];
      for await (const item of p.autoPaginate()) {
        items.push(item);
      }

      expect(items).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(p.hasMorePages).toBe(true);
    });

    it('respects the default maxPages limit of 10_000', async () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }], 'c2'));
      const p = new StreamPaginator(fetcher, { limit: 1 });

      for await (const _item of p.autoPaginate()) {
        if (p.pagesFetched >= 3) break;
      }

      expect(p.pagesFetched).toBe(3);
    });
  });

  describe('empty response handling', () => {
    it('returns empty array when data is null', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        success: true,
        data: null,
        meta: {},
      } as StreamListResponse);
      const p = new StreamPaginator(fetcher, { limit: 1 });
      const page = await p.nextPage();
      expect(page).toEqual([]);
      expect(p.hasMorePages).toBe(false);
    });

    it('returns empty array when streams is undefined', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        success: true,
        data: { streams: undefined, has_more: false, next_cursor: null },
        meta: {},
      } as StreamListResponse);
      const p = new StreamPaginator(fetcher, { limit: 1 });
      const page = await p.nextPage();
      expect(page).toEqual([]);
    });
  });

  describe('param immutability', () => {
    it('does not mutate the original params object', async () => {
      const fetcher = vi.fn().mockResolvedValue(mockPage([{ id: 's1' }]));
      const params: ListStreamsParams = { limit: 20 };
      Object.freeze(params);
      const p = new StreamPaginator(fetcher, params);
      await p.nextPage();
      expect(params).toEqual({ limit: 20 });
    });
  });

  describe('cursor param consistency', () => {
    it('passes undefined cursor on first call, then opaque cursor on subsequent calls', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }], 'opaque-token'))
        .mockResolvedValueOnce(mockPage([{ id: 's2' }]));
      const p = new StreamPaginator(fetcher, { limit: 1 });

      await p.nextPage();
      expect((fetcher.mock.calls[0]![0] as ListStreamsParams).cursor).toBeUndefined();

      await p.nextPage();
      expect((fetcher.mock.calls[1]![0] as ListStreamsParams).cursor).toBe('opaque-token');
    });
  });
});