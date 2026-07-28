/**
 * Cursor-based paginator for GET /api/streams.
 *
 * Generated from `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
 * Do not edit by hand — run `pnpm generate:sdk:ts` instead.
 *
 * ## Design
 * `StreamPaginator` wraps the server's keyset-cursor pagination behind an
 * ergonomic API that never requires the caller to manage raw cursor tokens.
 *
 * - Call `nextPage()` to fetch one page at a time.
 * - Use `autoPaginate()` (async generator) to iterate all streams across all
 *   pages with a `for await...of` loop.
 * - Pagination terminates when the server returns `has_more: false`.
 *
 * ## Cursor semantics
 * Cursors are **opaque base64url tokens** issued by the server. Clients must
 * treat them as black boxes — do not construct or decode manually.
 * See `docs/openapi/README.md` for the full cursor protocol.
 *
 * @module @fluxora/sdk/pagination
 */

import type { Stream, ListStreamsParams, StreamListResponse } from './types.js';

/**
 * Cursor-based paginator for the GET /api/streams endpoint.
 *
 * @example
 * ```typescript
 * const paginator = client.listStreams({ limit: 20, status: 'active' });
 *
 * // Option A — iterate individual stream items
 * for await (const stream of paginator.autoPaginate()) {
 *   console.log(stream.id, stream.depositAmount);
 * }
 *
 * // Option B — fetch one page at a time
 * const page1 = await paginator.nextPage();
 * const page2 = await paginator.nextPage();
 * ```
 */
export class StreamPaginator {
  private readonly fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>;
  private readonly limit: number;
  private readonly status?: string;
  private readonly sender?: string;
  private readonly recipient?: string;
  private readonly includeTotal: boolean;

  /** Opaque cursor from the last response; `null` = start of sequence. */
  private nextCursor: string | null = null;
  /** `false` once the server signals no more pages. */
  private hasMore = true;

  /**
   * @param fetchPage - Calls the API and returns a `StreamListResponse`.
   * @param params    - Initial filter and pagination parameters.
   * @throws {Error} When `limit` is outside the valid range 1–100.
   */
  constructor(
    fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>,
    params: ListStreamsParams = {},
  ) {
    const limit = params.limit ?? 20;
    if (limit < 1 || limit > 100) {
      throw new Error('limit must be an integer between 1 and 100 per paginationSchema');
    }
    this.fetchPage = fetchPage;
    this.limit = limit;
    this.status = params.status;
    this.sender = params.sender;
    this.recipient = params.recipient;
    this.includeTotal = params.include_total ?? false;
  }

  /**
   * Fetch the next page of stream results.
   *
   * @returns Array of `Stream` objects for this page, or `null` when all
   *          pages have been consumed (`has_more` was `false`).
   */
  async nextPage(): Promise<Stream[] | null> {
    if (!this.hasMore) return null;

    const response = await this.fetchPage({
      limit: this.limit,
      cursor: this.nextCursor ?? undefined,
      status: this.status,
      sender: this.sender,
      recipient: this.recipient,
      include_total: this.includeTotal,
    });

    const pageData = response.data;
    const streams: Stream[] = pageData?.streams ?? [];
    const hasMore: boolean = pageData?.has_more ?? false;
    const nextCursor: string | null =
      pageData?.next_cursor ??
      (response.meta?.next_cursor as string | null | undefined) ??
      null;

    if (nextCursor && hasMore) {
      this.nextCursor = nextCursor;
    } else {
      this.hasMore = false;
    }

    return streams;
  }

  /**
   * Async generator that yields individual `Stream` items across all pages.
   *
   * Pagination terminates automatically when the server has no more results.
   * A `break` inside `for await` stops iteration without fetching further pages.
   *
   * @yields `Stream` objects one at a time.
   */
  async *autoPaginate(): AsyncGenerator<Stream, void, unknown> {
    while (this.hasMore) {
      const page = await this.nextPage();
      if (!page || page.length === 0) break;
      for (const item of page) {
        yield item;
      }
    }
  }
}
