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
 * The idempotency store is in-memory (Map) for this iteration.  In production
 * it should be backed by Redis with a 24-hour TTL.
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
 *
 * @module routes/streams
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import {
  validateDecimalString,
  validateAmountFields,
} from '../serialization/decimal.js';
import {
  ApiError,
  ApiErrorCode,
  notFound,
  validationError,
  serviceUnavailable,
  asyncHandler,
} from '../middleware/errorHandler.js';
import { requireIdempotencyKey } from '../middleware/requestProtection.js';
import { SerializationLogger, info, debug, warn } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { authenticate, requireAuth } from '../middleware/auth.js';
import { successResponse, idempotentReplayResponse } from '../utils/response.js';
import { streamRepository } from '../db/repositories/streamRepository.js';
import { PoolExhaustedError } from '../db/pool.js';
import {
  CreateStreamSchema,
  parseBody,
  formatZodIssues,
} from '../validation/schemas.js';
import type { StreamStatus } from '../db/types.js';

export const streamsRouter = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

/** Public-facing stream shape (camelCase, decimal strings). */
export interface Stream {
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
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

type StoredIdempotentResponse = {
  requestFingerprint: string;
  statusCode: number;
  body: Stream;
};

const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;

// ── Dependency state (injectable for tests) ───────────────────────────────────

const streamListingDependency = { state: 'healthy' as DependencyState };
const idempotencyDependency   = { state: 'healthy' as DependencyState };

// In-memory idempotency store (Redis-backed in production; sufficient for now)
const idempotencyStore = new Map<string, StoredIdempotentResponse>();

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
export function resetStreamIdempotencyStore(): void {
  idempotencyStore.clear();
}

// ── DB → API mapper ───────────────────────────────────────────────────────────

/**
 * Map a StreamRecord (snake_case DB row) to the public Stream shape (camelCase).
 * Preserves decimal-string amounts exactly as stored.
 */
import type { StreamRecord } from '../db/types.js';

function toApiStream(record: StreamRecord): Stream {
  return {
    id:            record.id,
    sender:        record.sender_address,
    recipient:     record.recipient_address,
    depositAmount: record.amount,
    ratePerSecond: record.rate_per_second,
    startTime:     record.start_time,
    endTime:       record.end_time,
    status:        record.status,
  };
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
      formattedErrors[0]?.message ?? 'Validation failed',
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
  if (depositAmount !== undefined && parseFloat(validatedDeposit) <= 0) {
    throw validationError('depositAmount must be greater than zero');
  }

  const rateResult = validateDecimalString(ratePerSecond ?? '0', 'ratePerSecond');
  const validatedRate = rateResult.valid && rateResult.value ? rateResult.value : '0';
  if (ratePerSecond !== undefined && parseFloat(validatedRate) < 0) {
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
  return JSON.stringify(input);
}

/** Wrap DB errors so pool exhaustion surfaces as 503. */
function wrapDbError(err: unknown): never {
  if (err instanceof PoolExhaustedError) {
    throw serviceUnavailable('Database is temporarily unavailable. Please retry shortly.');
  }
  throw err;
}

// ── API status state machine ──────────────────────────────────────────────────

type ApiStreamStatus = 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled';

const API_TRANSITIONS: Record<ApiStreamStatus, ApiStreamStatus[]> = {
  scheduled:  ['active', 'cancelled'],
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
 * Reset test state.
 * In the DB-backed model this only clears the in-memory idempotency store.
 * Tests that need a clean DB should truncate the table directly.
 */
export function _resetStreams(): void {
  idempotencyStore.clear();
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/streams
 * List streams with cursor-based pagination.
 */
streamsRouter.get(
  '/',
  asyncHandler(async (req: any, res: any) => {
    const requestId = req.id as string | undefined;
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const includeTotal = parseIncludeTotal(req.query.include_total);

    // Indexed filters
    const statusFilter    = req.query.status    as string | undefined;
    const senderFilter    = req.query.sender    as string | undefined;
    const recipientFilter = req.query.recipient as string | undefined;

    if (streamListingDependency.state !== 'healthy') {
      warn('Stream listing dependency unavailable', { dependency: 'stream-list-view', requestId });
      throw serviceUnavailable('Stream list is temporarily unavailable. Retry when dependency health is restored.');
    }

    let result: { streams: Stream[]; hasMore: boolean; total?: number };
    try {
      const dbResult = await streamRepository.findWithCursor(
        {},
        limit,
        cursor?.lastId,
        includeTotal,
      );
      result = {
        streams: dbResult.streams.map(toApiStream),
        hasMore: dbResult.hasMore,
        total:   dbResult.total,
      };
    } catch (err) {
      wrapDbError(err);
    }

    const pageStreams = result!.streams;
    const hasMore     = result!.hasMore;
    const nextCursor  = hasMore && pageStreams.length > 0
      ? encodeCursor(pageStreams[pageStreams.length - 1]!.id)
      : undefined;

    info('Listing streams', { limit, returned: pageStreams.length, hasMore, requestId });

    const response: {
      streams: Stream[];
      has_more: boolean;
      total?: number;
      next_cursor?: string;
    } = { streams: pageStreams, has_more: hasMore };

    if (includeTotal && result!.total !== undefined) response.total       = result!.total;
    if (nextCursor)                                  response.next_cursor = nextCursor;

    res.json(response);
  }),
);

/**
 * GET /api/streams/:id
 * Get a single stream by ID.
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: any, res: any) => {
    const { id }    = req.params;
    const requestId = req.id as string | undefined;
    debug('Fetching stream', { id });

    let record;
    try {
      record = await streamRepository.getById(id);
    } catch (err) {
      wrapDbError(err);
    }

    if (!record) throw notFound('Stream', id);
    res.json(successResponse({ stream: toApiStream(record!) }, requestId));
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
  requireIdempotencyKey,
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = (req as any).id as string | undefined;
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

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
    const existingResponse   = idempotencyStore.get(idempotencyKey);

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
        streamId: existingResponse.body.id,
        action: 'replay',
      });
      res.set('Idempotency-Key', idempotencyKey);
      res.set('Idempotency-Replayed', 'true');
      res.status(existingResponse.statusCode).json(existingResponse.body);
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
    idempotencyStore.set(idempotencyKey, { requestFingerprint, statusCode: 201, body: stream });

    SerializationLogger.amountSerialized(2, requestId);
    info('Stream created', { id: stream.id, requestId, correlationId, action: 'created' });
    recordAuditEvent('STREAM_CREATED', 'stream', stream.id, correlationId, {
      depositAmount: normalizedInput.depositAmount,
      ratePerSecond: normalizedInput.ratePerSecond,
      sender:        normalizedInput.sender,
      recipient:     normalizedInput.recipient,
    });

    res.set('Idempotency-Key', idempotencyKey);
    res.set('Idempotency-Replayed', 'false');
    res.status(201).json(stream);
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
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = (req as any).id as string | undefined;
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
      await streamRepository.updateStream(id, { status: 'cancelled' }, requestId);
    } catch (err) {
      wrapDbError(err);
    }

    info('Stream cancelled', { id, requestId });
    recordAuditEvent('STREAM_CANCELLED', 'stream', id, (req as any).correlationId);

    res.json({ message: 'Stream cancelled', id });
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
    const { id } = req.params;
    const requestId = (req as any).id as string | undefined;
    const { status: newStatus } = req.body ?? {};

    const validStatuses: ApiStreamStatus[] = ['scheduled', 'active', 'paused', 'completed', 'cancelled'];
    if (typeof newStatus !== 'string' || !validStatuses.includes(newStatus as ApiStreamStatus)) {
      throw validationError('status must be one of: scheduled, active, paused, completed, cancelled');
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
      // 'scheduled' is an API-only concept; map to 'active' in DB
      const dbStatus = newStatus === 'scheduled' ? 'active' : newStatus as StreamStatus;
      updated = await streamRepository.updateStream(id, { status: dbStatus }, requestId);
    } catch (err) {
      wrapDbError(err);
    }

    info('Stream status updated', { id, from: record!.status, to: newStatus, requestId });
    recordAuditEvent('STREAM_STATUS_UPDATED', 'stream', id, (req as any).correlationId);

    res.json(successResponse(toApiStream(updated!), requestId));
  }),
);
