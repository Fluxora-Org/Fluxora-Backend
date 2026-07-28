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
 * - `status` is validated against the known enum values so unknown strings are
 *   rejected at the schema boundary and never reach the database layer.
 * - All values are passed to the DB as parameterised query arguments — no
 *   string interpolation occurs.
 *
 * @module validation/paginationSchema
 */

import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT     = 100;
export const MIN_PAGE_LIMIT     = 1;

/**
 * The set of valid stream status values accepted by the pagination API.
 * Mirrors the `StreamStatus` type in `src/db/types.ts` and the DB CHECK
 * constraint so that unknown strings are rejected at the schema boundary
 * before they reach the repository or database layer.
 */
export const STREAM_STATUS_VALUES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type StreamStatusValue = (typeof STREAM_STATUS_VALUES)[number];

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
   * Only the known status values are accepted: active, paused, completed, cancelled.
   * Unknown values are rejected with a 400 VALIDATION_ERROR before any DB call.
   */
  status: z
    .enum(STREAM_STATUS_VALUES, {
      errorMap: () => ({
        message: `status must be one of: ${STREAM_STATUS_VALUES.join(', ')}`,
      }),
    })
    .optional(),

  /** Filter by sender Stellar address. */
  sender: z.string().optional(),

  /** Filter by recipient Stellar address. */
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
