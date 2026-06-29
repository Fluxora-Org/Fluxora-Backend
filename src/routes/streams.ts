/**
 * Streams API routes — PostgreSQL-backed.
 *
 * All list/get/create/cancel operations delegate to streamRepository.
 * The in-memory store has been removed; state lives in the `streams` table.
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
 * Failure modes
 * -------------
 * - Missing Idempotency-Key  → 400 VALIDATION_ERROR
 * - Invalid Idempotency-Key  → 400 VALIDATION_ERROR
 * - Invalid decimal string   → 400 VALIDATION_ERROR
 * - Missing required field   → 400 VALIDATION_ERROR
 * - Missing authentication   → 401 UNAUTHORIZED
 * - Invalid token            → 401 UNAUTHORIZED
 * - Stream not found         → 404 NOT_FOUND
 * - Key reuse / diff payload → 409 CONFLICT
 * - Duplicate cancel         → 409 CONFLICT
 * - DB unavailable           → 503 SERVICE_UNAVAILABLE
 * - Idempotency store down   → 503 SERVICE_UNAVAILABLE
 * - Address not on-chain     → 422 UNPROCESSABLE_ENTITY
 *
 * @module routes/streams
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { loadConfig } from '../config/env.js';
import {
  compareDecimalStringToZero,
  validateDecimalString,
  validateAmountFields,
} from '../serialization/decimal.js';
import { ApiError } from '../errors.js';
import {
  ApiErrorCode,
  notFound,
  validationError,
  serviceUnavailable,
  asyncHandler,
  tooManyRequests,
} from '../middleware/errorHandler.js';
import { requireIdempotencyKey, parseIdempotencyKeyHeader } from '../middleware/requestProtection.js';
import { requireJsonAccept } from '../middleware/contentType.js';
import { SerializationLogger, info, debug, warn } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { authenticate, requireAuth, authenticateApiKey, requireScope } from '../middleware/auth.js';
import { successResponse, idempotentReplayResponse } from '../utils/response.js';
import { streamRepository } from '../db/repositories/streamRepository.js';
import { PoolExhaustedError } from '../db/pool.js';
import {
  CreateStreamSchema,
  parseBody,
  formatZodIssues,
} from '../validation/schemas.js';
import { PaginationSchema } from '../validation/paginationSchema.js';
import type { StreamStatus, StreamFilter, StreamRecord } from '../db/types.js';
import { isTerminalStatus } from '../streams/status.js';
import { streamsCreatedTotal, sseConnectionsRejectedTotal } from '../metrics/businessMetrics.js';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import { getStreamHub, type StreamUpdateEvent } from '../ws/hub.js';
import { STALE_CURSOR_ERROR_CODE, StaleCursorError } from '../indexer/store.js';
import { getClientIp } from '../ws/connectionLimiter.js';
import {
  eventMatchesStreamId,
  SSE_STREAM_UPDATE_EVENT,
  SSE_CLOSE_EVENT,
  SSE_CLOSE_REASONS,
  subscribeToSseStream,
  registerSseShutdownCallback,
} from '../streams/sseEmitter.js';
import {
  resolveSseConnectionLimits,
  tryAcquireSseConnection,
} from '../streams/sseConnectionLimiter.js';
import {
  RedisIdempotencyStore,
  NoOpIdempotencyStore,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from '../redis/idempotencyStore.js';
export const streamsRouter = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

/** Public-facing stream shape (camelCase, decimal strings). */
export interface Stream {
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  streamedAmount: string;
  remainingAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
  status: string;
}

type StreamsCursor = { v: 1; lastId: string };
type DependencyState = 'healthy' | 'unavailable';

type NormalizedCreateInput = {
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
};

const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;
const CACHEABLE_STREAM_HEADERS = 'public, max-age=300, stale-while-revalidate=60';
const NO_STORE_STREAM_HEADERS = 'private, no-store';

// ── Dependency state (injectable for tests) ───────────────────────────────────

const streamListingDependency = { state: 'healthy' as DependencyState };
const idempotencyDependency   = { state: 'healthy' as DependencyState };

// Idempotency store — starts as InMemoryIdempotencyStore; replaced at startup
// by wireIdempotencyStore() in app.ts with a RedisIdempotencyStore when Redis
// is available (REDIS_ENABLED=true).
let idempotencyStore: IdempotencyStore<ReturnType<typeof successResponse<Stream>>> =
  new InMemoryIdempotencyStore();

// TTL for idempotency entries — overridden in tests and set from config at startup
let idempotencyTtlSeconds = 86400;

/**
 * Legacy shim — audit.test.ts and streams.test.ts reference this array.
 * The DB-backed implementation no longer uses it for storage; it is kept
 * as an empty array so existing test imports do not break.
 * @deprecated Use streamRepository directly.
 */
export const streams: Stream[] = [];

export function setStreamListingDependencyState(state: DependencyState): void {
  streamListingDependency.state = state;
}
export function setIdempotencyDependencyState(state: DependencyState): void {
  idempotencyDependency.state = state;
}

/**
 * Reset the idempotency store to a fresh in-memory instance.
 * Used in tests to get a clean slate with full idempotency semantics
 * (no Redis required).
 */
export function resetStreamIdempotencyStore(): void {
  idempotencyStore = new InMemoryIdempotencyStore();
}

/**
 * Replace the idempotency store implementation.
 * Called at startup with a RedisIdempotencyStore, and in tests with a
 * FakeRedisClient-backed store or a NoOpIdempotencyStore.
 *
 * The parameter is typed as `IdempotencyStore<unknown>` so callers do not
 * need to import the route's private `Stream` / `successResponse` types.
 * The cast below is safe because the route handler always stores and reads
 * values of the correct shape.
 */
export function setIdempotencyStore(
  store: IdempotencyStore<unknown>,
  ttlSeconds?: number,
): void {
  idempotencyStore = store as IdempotencyStore<ReturnType<typeof successResponse<Stream>>>;
  if (ttlSeconds !== undefined) idempotencyTtlSeconds = ttlSeconds;
}

// ── DB → API mapper ───────────────────────────────────────────────────────────

function toApiStream(record: StreamRecord): Stream {
  return {
    id:            record.id,
    sender:        record.sender_address,
    recipient:     record.recipient_address,
    depositAmount: record.amount,
    streamedAmount: record.streamed_amount,
    remainingAmount: record.remaining_amount,
    ratePerSecond: record.rate_per_second,
    startTime:     record.start_time,
    endTime:       record.end_time,
    status:        record.status,
  };
}

type StreamResourceMetadata = {
  id: string;
  updated_at: string;
};

function streamEntityTag(metadata: StreamResourceMetadata): string {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${metadata.id}:${metadata.updated_at}`)
    .digest('base64url');
  return `W/"${fingerprint}"`;
}

function setStreamResourceHeaders(
  res: Response,
  metadata: StreamResourceMetadata,
): void {
  res.set('ETag', streamEntityTag(metadata));
  res.set('Last-Modified', new Date(metadata.updated_at).toUTCString());
}

/**
 * RFC 7232 §3.2 weak comparison for If-None-Match.
 *
 * The `*` wildcard matches any current representation.
 * Otherwise the field value is a comma-separated list of entity-tags and the
 * recipient uses the weak comparison function (strip `W/` prefix before
 * character-for-character comparison of the opaque-tag, including DQUOTES).
 *
 * @param ifNoneMatch - raw value of the If-None-Match request header
 * @param etag - the server-computed ETag for the current representation
 * @returns `true` when any entry in the list matches
 */
function matchesIfNoneMatch(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;

  const normalize = (tag: string): string => tag.replace(/^W\//i, '');
  const normalizedEtag = normalize(etag);

  return trimmed
    .split(',')
    .map((t) => normalize(t.trim()))
    .some((t) => t === normalizedEtag);
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

function encodeCursor(lastId: string): string {
  const payload: StreamsCursor = { v: 1, lastId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): StreamsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw validationError('cursor must be a valid opaque pagination token');
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    !('v' in parsed) || !('lastId' in parsed) ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { lastId?: unknown }).lastId !== 'string' ||
    (parsed as { lastId: string }).lastId.trim() === ''
  ) {
    throw validationError('cursor must be a valid opaque pagination token');
  }
  return parsed as StreamsCursor;
}

// ── Query-param parsers ───────────────────────────────────────────────────────

function parseLimit(limitParam: unknown): number {
  if (limitParam === undefined) return 50;
  if (Array.isArray(limitParam) || typeof limitParam !== 'string' || !/^\d+$/.test(limitParam)) {
    throw validationError('limit must be an integer between 1 and 100');
  }
  const n = Number.parseInt(limitParam, 10);
  if (n < 1 || n > 100) throw validationError('limit must be an integer between 1 and 100');
  return n;
}

function parseCursor(cursorParam: unknown): StreamsCursor | undefined {
  if (cursorParam === undefined) return undefined;
  if (Array.isArray(cursorParam) || typeof cursorParam !== 'string' || cursorParam.trim() === '') {
    throw validationError('cursor must be a valid opaque pagination token');
  }
  return decodeCursor(cursorParam);
}

function parseIncludeTotal(includeTotalParam: unknown): boolean {
  if (includeTotalParam === undefined) return false;
  if (Array.isArray(includeTotalParam) || typeof includeTotalParam !== 'string') {
    throw validationError('include_total must be true or false');
  }
  if (includeTotalParam === 'true') return true;
  if (includeTotalParam === 'false') return false;
  throw validationError('include_total must be true or false');
}

// ── Body normaliser ───────────────────────────────────────────────────────────

function normalizeCreateInput(body: Record<string, unknown>): NormalizedCreateInput {
  const parseResult = parseBody(CreateStreamSchema, body);

  if (!parseResult.success) {
    const formatted = formatZodIssues(parseResult.issues);
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      formatted[0]?.message ?? 'Validation failed',
      400,
      formatted.map((e) => e.message).join('; '),
    );
  }

  const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } = parseResult.data;

  const amountValidation = validateAmountFields(
    { depositAmount, ratePerSecond } as Record<string, unknown>,
    AMOUNT_FIELDS as unknown as string[],
  );
  if (!amountValidation.valid) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      'Invalid decimal string format for amount fields',
      400,
      { errors: amountValidation.errors.map((e) => ({ field: e.field, code: e.code, message: e.message })) },
    );
  }

  const depositResult = validateDecimalString(depositAmount ?? '0', 'depositAmount');
  const validatedDeposit = depositResult.valid && depositResult.value ? depositResult.value : '0';
  if (depositAmount !== undefined && compareDecimalStringToZero(validatedDeposit) <= 0) {
    throw validationError('depositAmount must be greater than zero');
  }

  const rateResult = validateDecimalString(ratePerSecond ?? '0', 'ratePerSecond');
  const validatedRate = rateResult.valid && rateResult.value ? rateResult.value : '0';
  if (ratePerSecond !== undefined && compareDecimalStringToZero(validatedRate) < 0) {
    throw validationError('ratePerSecond cannot be negative');
  }

  return {
    sender:        sender.trim(),
    recipient:     recipient.trim(),
    depositAmount: validatedDeposit,
    ratePerSecond: validatedRate,
    startTime:     startTime ?? Math.floor(Date.now() / 1000),
    endTime:       endTime   ?? 0,
  };
}

function fingerprintInput(input: NormalizedCreateInput): string {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Wrap DB errors so pool exhaustion surfaces as 503. */
function wrapDbError(err: unknown): never {
  if (err instanceof PoolExhaustedError) {
    throw serviceUnavailable('Database is temporarily unavailable. Please retry shortly.');
  }
  throw err;
}

// ── API status state machine ──────────────────────────────────────────────────

type ApiStreamStatus = 'active' | 'paused' | 'completed' | 'cancelled';

const API_TRANSITIONS: Record<ApiStreamStatus, ApiStreamStatus[]> = {
  active:     ['paused', 'completed', 'cancelled'],
  paused:     ['active', 'cancelled'],
  completed:  [],
  cancelled:  [],
};

function assertValidApiTransition(
  from: ApiStreamStatus,
  to: ApiStreamStatus,
): { ok: true } | { ok: false; message: string } {
  const allowed = API_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true };
  if (from === to) return { ok: false, message: `Stream is already ${from}` };
  if (from === 'completed') return { ok: false, message: 'Stream is already completed and cannot be transitioned' };
  if (from === 'cancelled') return { ok: false, message: 'Stream is already cancelled and cannot be transitioned' };
  return { ok: false, message: `Cannot transition stream from '${from}' to '${to}'` };
}

// ── Test helpers (no-op in production) ───────────────────────────────────────

/**
 * Middleware to enforce stream visibility based on JWT roles and addresses.
 * Must be used within the router group scope.
 * @param req Express request object, expected to contain `req.user` from `authenticate` middleware.
 * @param res Express response object.
 * @param next Express next middleware function.
 */
export function enforceStreamScope(req: Request, res: Response, next: NextFunction): void {
    // Check if the user is authenticated and if the role requires scoping.
    if (!req.user || req.user.role === 'operator') {
        // Operator role bypasses scoping checks.
        return next();
    }

    const callerAddress = req.user.address as string | undefined;
    if (!callerAddress) {
        // Should not happen if authenticate middleware is working, but safe fail.
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Caller address missing' } });
    }

    // Attach caller address to the request object for repository consumption.
    req.callerAddress = callerAddress;

    // Move to the next handler which will use req.callerAddress
    next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/streams
 * List streams with cursor-based pagination.
 *
 * Query params are validated via PaginationSchema (Zod). Invalid params
 * return 400 VALIDATION_ERROR before any DB call is made.
 */
streamsRouter.get(
  '/',
  requireJsonAccept,
  authenticateApiKey,
  requireScope('streams:read'),
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.id as string | undefined;

    // Validate all query params in one pass via Zod
    const parsed = PaginationSchema.safeParse(req.query);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw validationError(first?.message ?? 'Invalid query parameters');
    }
    const { limit, cursor: rawCursor, status: statusFilter, sender: senderFilter,
            recipient: recipientFilter, include_total } = parsed.data;

    const cursor       = rawCursor !== undefined ? parseCursor(rawCursor) : undefined;
    const includeTotal = include_total === 'true';

    if (streamListingDependency.state !== 'healthy') {
      warn('Stream listing dependency unavailable', { dependency: 'stream-list-view', requestId });
      throw serviceUnavailable('Stream list is temporarily unavailable. Retry when dependency health is restored.');
    }

    let result: { streams: Stream[]; hasMore: boolean; total?: number };
    try {
      const filter: StreamFilter = {};
      if (statusFilter !== undefined) filter.status = statusFilter as NonNullable<StreamFilter['status']>;
      if (senderFilter !== undefined) filter.sender_address = senderFilter;
      if (recipientFilter !== undefined) filter.recipient_address = recipientFilter;
      const dbResult = await streamRepository.findWithCursor(
        filter,
        limit,
        cursor?.lastId,
        includeTotal,
      );
      result = {
        streams: dbResult.streams.map(toApiStream),
        hasMore: dbResult.hasMore,
        ...(dbResult.total !== undefined ? { total: dbResult.total } : {}),
      };
    } catch (err) {
      wrapDbError(err);
    }

    const pageStreams = result!.streams;
    const hasMore     = result!.hasMore;
    const nextCursor  = hasMore && pageStreams.length > 0
      ? encodeCursor(pageStreams[pageStreams.length - 1]!.id)
      : null;

    info('Listing streams', { limit, returned: pageStreams.length, hasMore, requestId });

    const response: {
      streams: Stream[];
      has_more: boolean;
      next_cursor: string | null;
      total?: number;
    } = { streams: pageStreams, has_more: hasMore, next_cursor: nextCursor };

    if (includeTotal && result!.total !== undefined) response.total = result!.total;

    // Cache only when every stream on the page is in a terminal state.
    // An empty page is treated as all-terminal (nothing mutable present).
    const allTerminal = pageStreams.every((s) => isTerminalStatus(s.status as ApiStreamStatus));
    res.set(
      'Cache-Control',
      allTerminal ? CACHEABLE_STREAM_HEADERS : NO_STORE_STREAM_HEADERS,
    );

    res.json(successResponse(response, requestId));
  }),
);

/**
 * HEAD /api/streams/:id
 * Lightweight existence check with cache validators only.
 */
streamsRouter.head(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (!id) {
      res.status(404).end();
      return;
    }

    debug('Checking stream existence', { id });

    let record;
    try {
      record = await streamRepository.existsById(id);
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        res.status(503).end();
        return;
      }
      throw err;
    }

    if (!record) {
      res.status(404).end();
      return;
    }

    setStreamResourceHeaders(res, { id, updated_at: record.updated_at });
    res.status(200).end();
  }),
);

/**
 * GET /api/streams/:id
 * Get a single stream by ID.
 */
streamsRouter.get(
  '/:id',
  authenticateApiKey,
  requireScope('streams:read'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'];
    const requestId = req.id;
    if (!id) {
      throw notFound('Stream', '');
    }
    debug('Fetching stream', { id });

    let record;
    try {
      record = await streamRepository.getById(id);
    } catch (err) {
      wrapDbError(err);
    }

    if (!record) throw notFound('Stream', id);

    // Conditional GET (RFC 7232 §3.2)
    const etag = streamEntityTag(record!);
    const rawIfNoneMatch = req.headers['if-none-match'];
    if (rawIfNoneMatch !== undefined) {
      const header = Array.isArray(rawIfNoneMatch)
        ? rawIfNoneMatch.join(', ')
        : rawIfNoneMatch;
      if (matchesIfNoneMatch(header, etag)) {
        res.set('ETag', etag);
        res.set('Last-Modified', new Date(record!.updated_at).toUTCString());
        res.status(304).end();
        return;
      }
    }

    const stream = toApiStream(record!);
    setStreamResourceHeaders(res, record!);
    res.set(
      'Cache-Control',
      isTerminalStatus(stream.status as ApiStreamStatus)
        ? CACHEABLE_STREAM_HEADERS
        : NO_STORE_STREAM_HEADERS,
    );
    res.json(successResponse({ stream }, requestId));
  }),
);

/**
 * POST /api/streams
 * Create a new stream. Requires authentication + Idempotency-Key header.
 *
 * Idempotency-Key is validated by requireIdempotencyKey before this handler
 * runs; the validated key is available on res.locals.idempotencyKey.
 */
streamsRouter.post(
  '/',
  authenticate,
  requireAuth,
  authenticateApiKey,
  requireScope('streams:write'),
  requireIdempotencyKey,
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.id;
    const correlationId = req.correlationId;
    const idempotencyKey = parseIdempotencyKeyHeader(req.header('Idempotency-Key'));

    if (idempotencyDependency.state !== 'healthy') {
      warn('Idempotency dependency unavailable', {
        dependency: 'idempotency-store',
        requestId,
        // Never log the key value at warn/error level — it could be a secret
        idempotencyKeyLength: idempotencyKey.length,
      });
      throw serviceUnavailable('Idempotency processing is temporarily unavailable. Retry after dependency health is restored.');
    }

    info('Creating new stream', { requestId, correlationId });

    let normalizedInput: NormalizedCreateInput;
    try {
      normalizedInput = normalizeCreateInput(req.body ?? {});
    } catch (error) {
      const av = validateAmountFields(
        { depositAmount: req.body?.depositAmount, ratePerSecond: req.body?.ratePerSecond } as Record<string, unknown>,
        AMOUNT_FIELDS as unknown as string[],
      );
      if (!av.valid) {
        for (const err of av.errors) {
          SerializationLogger.validationFailed(err.field || 'unknown', err.rawValue, err.code, requestId);
        }
      }
      throw error;
    }

    const requestFingerprint = fingerprintInput(normalizedInput);
    const existingResponse   = await idempotencyStore.get(idempotencyKey);

    if (existingResponse) {
      if (existingResponse.requestFingerprint !== requestFingerprint) {
        // Log the decision without leaking the key value itself
        warn('Idempotency-Key reused with different payload', {
          requestId,
          correlationId,
          idempotencyKeyLength: idempotencyKey.length,
          action: 'conflict',
        });
        throw new ApiError(
          ApiErrorCode.CONFLICT,
          'Idempotency-Key has already been used for a different request payload',
          409,
          { hint: 'Use a new Idempotency-Key or retry with the original request body' },
        );
      }
      info('Replaying idempotent stream creation', {
        requestId,
        correlationId,
        streamId: existingResponse.body.data.id,
        action: 'replay',
      });
      res.set('Idempotency-Key', idempotencyKey);
      res.set('Idempotency-Replayed', 'true');
      res.status(existingResponse.statusCode).json(
        idempotentReplayResponse(existingResponse.body.data, requestId),
      );
      return;
    }

    // Derive a deterministic ID from the request content so replays are safe
    const idHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(normalizedInput))
      .digest('hex');
    const id = `stream-${idHash}-0`;

    let upsertResult;
    try {
      upsertResult = await streamRepository.upsertStream({
        id,
        sender_address:    normalizedInput.sender,
        recipient_address: normalizedInput.recipient,
        amount:            normalizedInput.depositAmount,
        streamed_amount:   '0',
        remaining_amount:  normalizedInput.depositAmount,
        rate_per_second:   normalizedInput.ratePerSecond,
        start_time:        normalizedInput.startTime,
        end_time:          normalizedInput.endTime,
        contract_id:       'api-created',
        transaction_hash:  idHash,
        event_index:       0,
      }, requestId);
    } catch (err) {
      wrapDbError(err);
    }

    const stream = toApiStream(upsertResult!.stream);
    const responseEnvelope = successResponse(stream, requestId);
    await idempotencyStore.set(
      idempotencyKey,
      { requestFingerprint, statusCode: 201, body: responseEnvelope },
      idempotencyTtlSeconds,
    );

    SerializationLogger.amountSerialized(2, requestId);
    info('Stream created', { id: stream.id, requestId, correlationId, action: 'created' });
    recordAuditEvent('STREAM_CREATED', 'stream', stream.id, correlationId ?? '', {
      depositAmount: normalizedInput.depositAmount,
      ratePerSecond: normalizedInput.ratePerSecond,
      sender:        normalizedInput.sender,
      recipient:     normalizedInput.recipient,
    });

    streamsCreatedTotal.inc({ status: stream.status });

    res.set('Idempotency-Key', idempotencyKey);
    res.set('Idempotency-Replayed', 'false');
    res.status(201).json(responseEnvelope);
  }),
);

/**
 * DELETE /api/streams/:id
 * Cancel a stream. Requires authentication.
 */
streamsRouter.delete(
  '/:id',
  authenticate,
  requireAuth,
  authenticateApiKey,
  requireScope('streams:write'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'];
    const requestId = req.id;
    if (!id) {
      throw notFound('Stream', '');
    }
    debug('Cancelling stream', { id });

    let record;
    try {
      record = await streamRepository.getById(id);
    } catch (err) {
      wrapDbError(err);
    }

    if (!record) throw notFound('Stream', id);

    const guard = assertValidApiTransition(record!.status as ApiStreamStatus, 'cancelled');
    if (!guard.ok) {
      throw new ApiError(ApiErrorCode.CONFLICT, guard.message, 409, {
        streamId: id,
        currentStatus: record!.status,
      });
    }

    try {
      await streamRepository.updateStream(id, { status: 'cancelled' }, requestId ?? '');
    } catch (err) {
      wrapDbError(err);
    }

    info('Stream cancelled', { id, requestId });
    recordAuditEvent('STREAM_CANCELLED', 'stream', id, req.correlationId ?? '');

    res.json(successResponse({ message: 'Stream cancelled', id }, requestId));
  }),
);

/**
 * PATCH /api/streams/:id/status
 * Transition a stream to a new status.
 *
 * Body: { "status": "paused" | "active" | "completed" | "cancelled" }
 *
 * Returns 409 CONFLICT when the transition is not permitted by the state machine.
 */
streamsRouter.patch(
  '/:id/status',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'];
    const requestId = req.id;
    const { status: newStatus } = req.body ?? {};

    if (!id) {
      throw notFound('Stream', '');
    }

    const validStatuses: ApiStreamStatus[] = ['active', 'paused', 'completed', 'cancelled'];
    if (typeof newStatus !== 'string' || !validStatuses.includes(newStatus as ApiStreamStatus)) {
      throw validationError('status must be one of: active, paused, completed, cancelled');
    }

    let record;
    try {
      record = await streamRepository.getById(id);
    } catch (err) {
      wrapDbError(err);
    }

    if (!record) throw notFound('Stream', id);

    const guard = assertValidApiTransition(record!.status as ApiStreamStatus, newStatus as ApiStreamStatus);
    if (!guard.ok) {
      throw new ApiError(ApiErrorCode.CONFLICT, guard.message, 409, {
        streamId: id,
        currentStatus: record!.status,
        requestedStatus: newStatus,
      });
    }

    let updated;
    try {
      const dbStatus = newStatus as StreamStatus;
      updated = await streamRepository.updateStream(id, { status: dbStatus }, requestId ?? '');
    } catch (err) {
      wrapDbError(err);
    }

    info('Stream status updated', { id, from: record!.status, to: newStatus, requestId });
    recordAuditEvent('STREAM_STATUS_UPDATED', 'stream', id, req.correlationId ?? '');

    res.json(successResponse(toApiStream(updated!), requestId));
  }),
);

/**
 * GET /api/streams/:id/events
 *
 * Server-Sent Events (SSE) endpoint to receive real-time stream updates.
 * Supporting standard JWT authentication and Last-Event-ID resumption.
 */
streamsRouter.get(
  '/:id/events',
  authenticateApiKey,
  requireScope('streams:read'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'];
    const requestId = req.id;

    if (!id) {
      throw notFound('Stream', '');
    }

    // 1. JWT Authentication and Authorization
    const wsAuthRequired = process.env.WS_AUTH_REQUIRED === 'true';
    const jwtSecret = process.env.JWT_SECRET;
    const authResult = verifyWsToken(req, jwtSecret);

    if (wsAuthRequired && !authResult.ok) {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: `Authentication required: ${authResult.code}`,
          requestId,
        },
      });
      return;
    } else if (!wsAuthRequired && !authResult.ok && authResult.code === 'INVALID_TOKEN') {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired authentication token',
          requestId,
        },
      });
      return;
    }

    // 2. Reserve bounded SSE capacity before repository work or header flush.
    const clientIp = getClientIp(req);
    const sseLimits = resolveSseConnectionLimits();
    const connectionAttempt = tryAcquireSseConnection(clientIp, sseLimits);

    if (!connectionAttempt.ok) {
      res.setHeader('Retry-After', String(connectionAttempt.retryAfterSeconds));
      warn('SSE connection rejected by limiter', {
        id,
        requestId,
        ip: clientIp,
        reason: connectionAttempt.reason,
        activeConnections: connectionAttempt.activeConnections,
        activeConnectionsForIp: connectionAttempt.activeConnectionsForIp,
        maxConnectionsPerIp: sseLimits.maxConnectionsPerIp,
        maxGlobalConnections: sseLimits.maxGlobalConnections,
      });
      throw tooManyRequests(connectionAttempt.message, {
        reason: connectionAttempt.reason,
        maxConnectionsPerIp: sseLimits.maxConnectionsPerIp,
        maxGlobalConnections: sseLimits.maxGlobalConnections,
        retryAfterSeconds: connectionAttempt.retryAfterSeconds,
      });
    }

    const sseConnection = connectionAttempt.connection;
    let cleanedUp = false;
    let unsubscribeLiveUpdates: (() => void) | undefined;
    let heartbeatInterval: NodeJS.Timeout | undefined;
    let maxDurationTimer: NodeJS.Timeout | undefined;

    function detachLifecycleHandlers(): void {
      res.off('close', onResponseClose);
      res.off('error', onResponseError);
      req.off('aborted', onRequestAborted);
    }

    /**
     * Idempotent cleanup for every SSE termination path. The active-connection
     * handle owns the Map/Gauge decrement, so close/error/timeout signals cannot
     * double-decrement or leave EventEmitter listeners behind. Lifecycle listeners
     * are also detached so pre-header failures do not retain route closures longer
     * than the response object itself.
     */
    function cleanup(reason: string): void {
      if (cleanedUp) return;
      cleanedUp = true;
      detachLifecycleHandlers();

      if (heartbeatInterval !== undefined) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
      if (maxDurationTimer !== undefined) {
        clearTimeout(maxDurationTimer);
        maxDurationTimer = undefined;
      }
      if (unsubscribeLiveUpdates !== undefined) {
        unsubscribeLiveUpdates();
        unsubscribeLiveUpdates = undefined;
      }

      sseConnection.release();
      debug('SSE connection cleaned up', {
        id,
        requestId,
        ip: sseConnection.ip,
        reason,
        durationMs: Date.now() - sseConnection.acceptedAt,
      });
    }

    function onResponseClose(): void {
      cleanup('client_close');
    }

    function onResponseError(err: Error): void {
      warn('SSE response error', {
        id,
        requestId,
        ip: sseConnection.ip,
        error: err.message,
      });
      cleanup('response_error');
    }

    function onRequestAborted(): void {
      cleanup('client_aborted');
    }

    const writeSse = (frame: string): boolean => {
      if (cleanedUp || res.destroyed || res.writableEnded) return false;
      try {
        res.write(frame);
        return true;
      } catch (err) {
        warn('SSE write failed; closing connection', {
          id,
          requestId,
          ip: sseConnection.ip,
          error: err instanceof Error ? err.message : String(err),
        });
        cleanup('write_error');
        try {
          res.end();
        } catch {
          // best-effort shutdown only
        }
        return false;
      }
    };

    res.once('close', onResponseClose);
    res.once('error', onResponseError);
    req.once('aborted', onRequestAborted);

    // 3. Verify stream existence after reserving capacity so over-limit attempts
    // are rejected before they can fan out into repository work.
    let record;
    try {
      record = await streamRepository.getById(id);
    } catch (err) {
      cleanup('db_error');
      wrapDbError(err);
    }

    if (cleanedUp) return;

    if (!record) {
      cleanup('not_found');
      throw notFound('Stream', id);
    }

    try {
      // 4. Establish Server-Sent Events stream.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    } catch (err) {
      cleanup('flush_error');
      throw err;
    }

    // Send connection ok comment + retry hint so browser EventSource knows the
    // reconnect interval (ms). This is the SSE-spec mechanism for communicating
    // the backoff to the client.
    const sseConfig = loadConfig();
    if (!writeSse(`: ok\n\nretry: ${sseConfig.sseRetryMs}\n\n`)) return;

    // Periodic heartbeat to prevent proxies and load balancers from closing the connection.
    heartbeatInterval = setInterval(() => {
      writeSse(': heartbeat\n\n');
    }, sseConfig.sseHeartbeatIntervalMs);
    heartbeatInterval.unref?.();

    // Bound long-lived SSE streams. Browser EventSource clients reconnect automatically.
    // Emits a typed `event: close` frame before ending the response so clients
    // can distinguish a deliberate server-side rotation (max_duration) from a
    // network drop and reconnect promptly rather than applying error back-off.
    // @security payload contains only the reason string — no stream data or PII.
    maxDurationTimer = setTimeout(() => {
      if (cleanedUp) return;
      writeSse(`event: ${SSE_CLOSE_EVENT}\ndata: ${JSON.stringify({ reason: SSE_CLOSE_REASONS.MAX_DURATION })}\n\n`);
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      cleanup('max_duration');
    }, sseLimits.maxConnectionDurationMs);
    maxDurationTimer.unref?.();

    // 5. Handle Last-Event-ID Resumption Replay.
    // Security: validate the header value to prevent unbounded replay or injection.
    // A valid event ID is 1–200 printable non-whitespace characters.
    const rawLastEventId = req.headers['last-event-id'];
    const lastEventId =
      typeof rawLastEventId === 'string' &&
      /^[\x21-\x7E]{1,200}$/.test(rawLastEventId.trim())
        ? rawLastEventId.trim()
        : undefined;

    if (lastEventId) {
      const hub = getStreamHub();
      const eventStore = hub?.getEventStore();
      if (eventStore) {
        try {
          let cursor: string | undefined = lastEventId;
          // Bound the replay to at most SSE_REPLAY_MAX_PAGES pages so a
          // client-supplied cursor cannot force a full-table scan.
          const SSE_REPLAY_MAX_PAGES = 10;
          let pagesRead = 0;
          do {
            if (cleanedUp) break;
            const result = await eventStore.getEvents({
              afterEventId: cursor,
              limit: 100,
            });

            for (const event of result.events) {
              if (cleanedUp) break;
              if (eventMatchesStreamId(event, id)) {
                const written = writeSse(
                  `id: ${event.eventId}\n` +
                  `event: ${SSE_STREAM_UPDATE_EVENT}\n` +
                  `data: ${JSON.stringify({
                    type: 'stream_update',
                    streamId: id,
                    eventId: event.eventId,
                    payload: event.payload,
                    correlationId: req.correlationId,
                  })}\n\n`,
                );
                if (!written) break;
              }
            }

            cursor = result.nextCursor;
            pagesRead++;
          } while (cursor !== undefined && !cleanedUp && pagesRead < SSE_REPLAY_MAX_PAGES);
        } catch (err) {
          if (err instanceof StaleCursorError) {
            writeSse(
              `event: error\ndata: ${JSON.stringify({
                code: STALE_CURSOR_ERROR_CODE,
                message: 'Replay cursor no longer exists; resync from fromLedger',
              })}\n\n`,
            );
            warn('SSE replay cursor is stale', {
              afterEventId: err.afterEventId,
              requestId,
            });
            res.end();
            cleanup('stale_cursor');
            return;
          }

          warn('Failed to replay SSE events from store', {
            error: err instanceof Error ? err.message : String(err),
            requestId,
          });
        }
      }
    }

    if (cleanedUp) return;

    // 6. Subscribe to Real-Time Updates.
    const listener = (event: StreamUpdateEvent) => {
      if (event.streamId === id) {
        writeSse(
          `id: ${event.eventId}\n` +
          `event: ${SSE_STREAM_UPDATE_EVENT}\n` +
          `data: ${JSON.stringify({
            type: 'stream_update',
            streamId: event.streamId,
            eventId: event.eventId,
            payload: event.payload,
            correlationId: req.correlationId || event.correlationId,
          })}\n\n`,
        );
      }
    };

    unsubscribeLiveUpdates = subscribeToSseStream(id, listener);

    // Register a shutdown drain callback so drainSseEventBus() can close this
    // response cleanly with a retry:0 directive instead of an abrupt socket close.
    // A forceClose callback is also registered so that when the per-connection
    // drain timeout is exceeded the underlying socket is destroyed immediately.
    const deregisterShutdown = registerSseShutdownCallback(
      async () => {
        try {
          if (!res.writableEnded && !res.destroyed) {
            res.write('retry: 0\n\n');
            res.end();
          }
        } catch {
          // Best-effort — the socket may already be gone.
        }
        cleanup('shutdown_drain');
      },
      () => {
        try {
          if (!res.destroyed) {
            res.destroy();
          }
        } catch {
          // Best-effort — the socket may already be gone.
        }
      },
    );
    const origUnsubscribe = unsubscribeLiveUpdates;
    unsubscribeLiveUpdates = () => {
      origUnsubscribe();
      deregisterShutdown();
    };
  }),
);

export function _resetStreams(): void {}
