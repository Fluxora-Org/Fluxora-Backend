/**
 * Stabilization tests for SDK pagination helpers (#1088).
 *
 * Locks down edge cases that were previously implicit: filter params carry-through,
 * retry-idempotent state after failure, autoPaginate early break, and param immutability.
 *
 * All tests use only the public API (constructor, nextPage, autoPaginate) to
 * verify behavior — the class exposes no public getters for internal state.
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamPaginator } from '../../sdk/typescript/src/pagination.js';
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

      // First page succeeds — returns items, passes cursor for next page
      const p1 = await p.nextPage();
      expect(p1).toEqual([{ id: 's1' }]);

      // Second page fails — error propagates, caller can retry
      await expect(p.nextPage()).rejects.toThrow('Transient network error');

      // Retry succeeds — the paginator retries the same cursor
      const p2 = await p.nextPage();
      expect(p2).toEqual([{ id: 's2' }]);

      // After successful retry, no more pages
      const p3 = await p.nextPage();
      expect(p3).toBeNull();

      // Three fetchPage calls total = initial + failed retry + successful retry
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  describe('autoPaginate early break', () => {
    it('stops iterating when loop breaks early (no extra fetch)', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(mockPage([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'c2'))
        .mockResolvedValueOnce(mockPage([{ id: 's4' }], 'c3'));
      const p = new StreamPaginator(fetcher, { limit: 3 });

      const items: Stream[] = [];
      for await (const item of p.autoPaginate()) {
        items.push(item);
        if (items.length >= 2) break;
      }
      expect(items).toHaveLength(2);
      // break prevents fetching next page even though hasMore is true
      expect(fetcher).toHaveBeenCalledTimes(1);
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
