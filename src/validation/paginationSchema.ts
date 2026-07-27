/**
 * Zod schema for cursor-based pagination query parameters on GET /api/streams.
 *
 * Cursor format
 * -------------
 * Cursors are opaque base64url tokens produced by the server. Clients must
 * treat them as black boxes and never construct them manually. The schema
 * validates only that the value is a non-empty string; structural validation
 * (version tag, lastId presence) is performed by decodeCursor() in the route.
 *
 * Security notes
 * --------------
 * - `limit` is capped at 100 to prevent unbounded table scans.
 * - `cursor` is validated as a non-empty string before being base64url-decoded
 *   and JSON-parsed in the route, preventing injection via crafted tokens.
 * - All values are passed to the DB as parameterised query arguments — no
 *   string interpolation occurs.
 *
 * @module validation/paginationSchema
 */

import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT     = 100;
export const MIN_PAGE_LIMIT     = 1;

export const PaginationSchema = z.object({
  /**
   * Opaque cursor returned by the previous page's `next_cursor` field.
   * Omit on the first request.
   */
  cursor: z
    .string()
    .min(1, 'cursor must be a non-empty string')
    .optional(),

  /**
   * Maximum number of results to return (1–100, default 20).
   * The string is coerced to an integer because query params arrive as strings.
   */
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(
      z
        .number()
        .int('limit must be an integer')
        .min(MIN_PAGE_LIMIT, `limit must be at least ${MIN_PAGE_LIMIT}`)
        .max(MAX_PAGE_LIMIT, `limit must be at most ${MAX_PAGE_LIMIT}`),
    )
    .optional()
    .transform((v) => v ?? DEFAULT_PAGE_LIMIT),

  /**
   * Filter by stream status.
   * Pass-through string — no enum validation is applied so the DB drives the
   * filtering.  Invalid status values produce an empty result set (not an
   * error).  Valid statuses: active, paused, completed, cancelled.
   */
  status: z.string().optional(),

  /**
   * Filter by sender Stellar address.
   * Pass-through string — validated by the DB query layer via parameterised
   * arguments.  No Zod-level format check (G… public key pattern) to keep
   * the query-param validation fast; malformed addresses simply match zero
   * rows.
   */
  sender: z.string().optional(),

  /**
   * Filter by recipient Stellar address.
   * Same pass-through behaviour as `sender`.
   */
  recipient: z.string().optional(),

  /** When 'true', include total count of matching rows in the response. */
  include_total: z.enum(['true', 'false']).optional(),
});

/**
 * Zod schema for offset-based pagination query parameters used by
 * webhook management and other list endpoints.
 *
 * Both `limit` and `offset` are coerced from strings (query params) to
 * integers and validated as non-negative integers within sane bounds.
 * `limit` is capped at {@link MAX_PAGE_LIMIT} to prevent unbounded
 * in-memory slice / serialize operations.
 *
 * Each field is optional to allow route-specific defaults.
 *
 * @module validation/paginationSchema
 */
export const OffsetPaginationSchema = z.object({
  /**
   * Maximum number of results to return. Capped at MAX_PAGE_LIMIT (100).
   * The string is coerced to an integer because query params arrive as strings.
   */
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(
      z
        .number()
        .int('limit must be an integer')
        .min(MIN_PAGE_LIMIT, `limit must be at least ${MIN_PAGE_LIMIT}`)
        .max(MAX_PAGE_LIMIT, `limit must be at most ${MAX_PAGE_LIMIT}`),
    )
    .optional(),

  /**
   * Number of results to skip. Must be non-negative.
   * The string is coerced to an integer because query params arrive as strings.
   */
  offset: z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(
      z
        .number()
        .int('offset must be an integer')
        .min(0, 'offset must be non-negative'),
    )
    .optional(),
});

export type PaginationQuery = z.infer<typeof PaginationSchema>;
