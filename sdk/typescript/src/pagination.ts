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
 * ## Retry idempotency
 * When a page fetch fails, the internal cursor is **not** advanced — the next
 * call to `nextPage()` retries the same logical page. This makes pagination
 * fully idempotent under transient network failures.
 *
 * ## Concurrency guard
 * `nextPage()` rejects with `ValidationError` if a fetch is already in-flight
 * for this paginator, preventing interleaved cursor mutations.
 *
 * ## Page-limit safety
 * `autoPaginate()` stops after `maxPages` pages (default 10 000) to prevent
 * infinite iteration against a misbehaving server that never sets `has_more`
 * to `false`.
 *
 * @module @fluxora/sdk/pagination
 */

import type { Stream, ListStreamsParams, StreamListResponse } from './types.js';
import { ValidationError } from './errors.js';

/** Default page size returned when `limit` is omitted. */
export const DEFAULT_PAGE_LIMIT = 20;
/** Minimum allowed page size. */
export const MIN_PAGE_LIMIT = 1;
/** Maximum allowed page size (server-enforced). */
export const MAX_PAGE_LIMIT = 100;
/** Default safety cap on pages fetched by `autoPaginate()`. */
export const DEFAULT_MAX_PAGES = 10_000;

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
  private readonly maxPages: number;

  /** Opaque cursor from the last response; `null` = start of sequence. */
  private nextCursor: string | null = null;
  /** `false` once the server signals no more pages. */
  private hasMore = true;
  /** Tracks total pages fetched across all calls. */
  private pagesFetchedCount = 0;
  /** Guards against concurrent `nextPage()` calls. */
  private inFlight = false;

  /**
   * @param fetchPage - Calls the API and returns a `StreamListResponse`.
   * @param params    - Initial filter and pagination parameters.
   * @throws {Error} When `limit` is outside the valid range 1–100.
   */
  constructor(
    fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>,
    params: ListStreamsParams = {},
  ) {
    const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
    if (limit < MIN_PAGE_LIMIT || limit > MAX_PAGE_LIMIT) {
      throw new Error('limit must be an integer between 1 and 100 per paginationSchema');
    }
    this.fetchPage = fetchPage;
    this.limit = limit;
    this.maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
    this.status = params.status;
    this.sender = params.sender;
    this.recipient = params.recipient;
    this.includeTotal = params.include_total ?? false;
  }

  /** The most recent opaque cursor, or `null` before the first fetch. */
  get currentCursor(): string | null {
    return this.nextCursor;
  }

  /** Whether the server may have more pages. */
  get hasMorePages(): boolean {
    return this.hasMore;
  }

  /** Total number of pages fetched so far. */
  get pagesFetched(): number {
    return this.pagesFetchedCount;
  }

  /**
   * Fetch the next page of stream results.
   *
   * @returns Array of `Stream` objects for this page, or `null` when all
   *          pages have been consumed (`has_more` was `false`).
   * @throws {ValidationError} When a fetch is already in-flight.
   */
  async nextPage(): Promise<Stream[] | null> {
    if (this.inFlight) {
      throw new ValidationError('A pagination request is already in flight');
    }
    if (!this.hasMore) return null;

    this.inFlight = true;
    try {
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

      this.pagesFetchedCount++;
      return streams;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Async generator that yields individual `Stream` items across all pages.
   *
   * Pagination terminates automatically when the server has no more results.
   * A `break` inside `for await` stops iteration without fetching further pages.
   *
   * A safety cap of `maxPages` (default 10 000) prevents infinite iteration
   * against a misbehaving server.
   *
   * @yields `Stream` objects one at a time.
   */
  async *autoPaginate(): AsyncGenerator<Stream, void, unknown> {
    while (this.hasMore && this.pagesFetchedCount < this.maxPages) {
      const page = await this.nextPage();
      if (!page) break;
      for (const item of page) {
        yield item;
      }
    }
  }
}
