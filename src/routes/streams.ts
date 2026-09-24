/**
 * Streams API routes — PostgreSQL-backed.
 *
 * This module only assembles the router. The work is split by concern:
 *
 *   routes/streams/read.ts      list, NDJSON export, HEAD, GET, JSON-LD
 *   routes/streams/write.ts     create (idempotent), cancel, status transition
 *   routes/streams/sse.ts       Server-Sent Events
 *   routes/streams/longPoll.ts  long-poll fallback
 *   routes/streams/realtime.ts  auth/limits/teardown/replay shared by SSE + long-poll
 *   routes/streams/guards.ts    request validation, authorization, error mapping
 *   routes/streams/state.ts     dependency health + idempotency store wiring
 *
 *   db/repositories/streamApiQueries.ts  query construction (filters, create rows)
 *   serialization/stream.ts              response shaping (Stream, list pages, update envelopes)
 *   utils/opaqueCursor.ts                cursor codec, shared with other paginated routes
 *   utils/conditionalGet.ts              ETag / If-None-Match, shared with other resource routes
 *
 * Decimal-string invariant
 * ------------------------
 * All amount fields (depositAmount, ratePerSecond) are validated as decimal
 * strings before storage and returned as decimal strings in every response.
 * This prevents floating-point precision loss when amounts cross the
 * chain/API boundary.
 *
 * Trust boundaries
 * ----------------
 * - Public internet clients: may list and read streams without authentication.
 * - Authenticated partners: may create and cancel streams with valid JWT.
 *
 * Idempotency
 * -----------
 * POST /api/streams requires an Idempotency-Key header (1–128 chars,
 * [A-Za-z0-9:_-]).  The key is validated by requireIdempotencyKey middleware
 * before the handler runs.  A SHA-256 fingerprint of the normalised request
 * body is stored alongside the cached response so that:
 *   - Same key + same body  → 201 replay (Idempotency-Replayed: true)
 *   - Same key + diff body  → 409 CONFLICT
 *   - Missing / bad key     → 400 VALIDATION_ERROR
 *
 * The idempotency store defaults to in-memory at module load and is replaced
 * at startup with a RedisIdempotencyStore when Redis is available
 * (REDIS_ENABLED=true, the default).  TTL is driven by IDEMPOTENCY_TTL_SECONDS
 * (default 86 400 s / 24 h).  See src/app.ts wireIdempotencyStore().
 *
 * Pagination contract (GET /api/streams)
 * --------------------------------------
 * - **Default page size**: 20 (MIN=1, MAX=100).
 * - **Ordering**: deterministic `ORDER BY id ASC` within the DB.
 * - **Cursor format**: opaque base64url-encoded JSON `{ v: 1, lastId: <id> }`.
 *   Clients must treat cursors as black boxes; only the server produces them.
 * - **Determinism**: the same cursor always returns the same page for the
 *   same underlying dataset.  Insertions/deletions between requests shift the
 *   page boundaries (the cursor is an exclusive lower bound on `id`, not a
 *   snapshot offset).
 * - **Filters** (`status`, `sender`, `recipient`): pass-through strings — no
 *   Zod enum validation is applied.  Invalid filter values produce an empty
 *   result set, not a validation error.
 * - **`include_total`**: when `true`, a separate `COUNT(*)` query runs.
 *   The total is a best-effort snapshot (not cursor-consistent) and should
 *   not be used for offset calculations.
 * - **Cache-Control**: when every stream on the page is in a terminal state
 *   (completed or cancelled) the response is marked `public, max-age=300,
 *   stale-while-revalidate=60`.  Otherwise `private, no-store`.
 *
 * Failure modes
 * -------------
 * - Missing Idempotency-Key   → 400 VALIDATION_ERROR
 * - Invalid Idempotency-Key   → 400 VALIDATION_ERROR
 * - Invalid decimal string    → 400 VALIDATION_ERROR
 * - Missing required field    → 400 VALIDATION_ERROR
 * - Missing authentication    → 401 UNAUTHORIZED
 * - Invalid token             → 401 UNAUTHORIZED
 * - Missing/invalid scope     → 403 FORBIDDEN
 * - Stream not found          → 404 NOT_FOUND
 * - Key reuse / diff payload  → 409 CONFLICT
 * - Duplicate cancel          → 409 CONFLICT
 * - DB unavailable            → 503 SERVICE_UNAVAILABLE
 * - Idempotency store down    → 503 SERVICE_UNAVAILABLE
 * - Address not on-chain      → 422 UNPROCESSABLE_ENTITY
 *
 * @module routes/streams
 */
import { Router } from 'express';
import type { Stream } from '../serialization/stream.js';
import { registerReadRoutes } from './streams/read.js';
import { registerWriteRoutes } from './streams/write.js';
import { registerSseRoutes } from './streams/sse.js';
import { registerLongPollRoutes } from './streams/longPoll.js';

export type { Stream } from '../serialization/stream.js';
export {
  enforceStreamScope,
  fingerprintInput,
  getFeatureFlagRequesterId,
  parseLastEventIdHeader,
} from './streams/guards.js';
export {
  resetStreamIdempotencyStore,
  setIdempotencyDependencyState,
  setIdempotencyStore,
  setStreamListingDependencyState,
} from './streams/state.js';

export const streamsRouter = Router();

registerReadRoutes(streamsRouter);
registerWriteRoutes(streamsRouter);
registerSseRoutes(streamsRouter);
registerLongPollRoutes(streamsRouter);

/**
 * Legacy shim — audit.test.ts and streams.test.ts reference this array.
 * The DB-backed implementation no longer uses it for storage; it is kept
 * as an empty array so existing test imports do not break.
 * @deprecated Use streamRepository directly.
 */
export const streams: Stream[] = [];

/** Legacy no-op kept for existing test imports. */
export function _resetStreams(): void { }
