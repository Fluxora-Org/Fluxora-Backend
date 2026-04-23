/**
 * Streams API routes.
 *
 * Issue #6  — Input validation layer: all amount fields validated as decimal strings.
 * Issue #34 — Supertest integration tests: routes are designed for full HTTP testability.
 *
 * All amount fields (depositAmount, ratePerSecond) are validated as decimal
 * strings before storage and returned as decimal strings in every response.
 * This prevents floating-point precision loss when amounts cross the
 * chain/API boundary.
 *
 * Trust boundaries
 * ----------------
 * - Public internet clients: may list and read streams without authentication.
 * - Authenticated partners: may create and cancel streams with valid JWT.
 * - Internal workers: same surface; no elevated privileges yet.
 *
 * Failure modes
 * -------------
 * - Invalid decimal string  → 400 VALIDATION_ERROR with per-field details
 * - Missing required field  → 400 VALIDATION_ERROR
 * - Missing authentication  → 401 UNAUTHORIZED
 * - Invalid token           → 401 UNAUTHORIZED
 * - Stream not found        → 404 NOT_FOUND
 * - Duplicate cancel        → 409 CONFLICT
 * - Listing dependency down → 503 SERVICE_UNAVAILABLE
 * - Idempotency store down  → 503 SERVICE_UNAVAILABLE
 *
 * Non-goals (intentionally deferred)
 * -----------------------------------
 * - Persistent storage (in-memory only; PostgreSQL integration is follow-up)
 * - Rate limiting
 *
 * @openapi
 * /api/streams:
 *   get:
 *     summary: List streams with cursor pagination
 *     tags: [streams]
 *     parameters:
 *       - name: cursor
 *         in: query
 *         required: false
 *         schema: { type: string }
 *       - name: limit
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *       - name: include_total
 *         in: query
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200: { description: Paginated list of streams }
 *       400: { description: Invalid pagination parameters }
 *       503: { description: Listing dependency unavailable }
 *   post:
 *     summary: Create a new stream
 *     tags: [streams]
 *     parameters:
 *       - name: Idempotency-Key
 *         in: header
 *         required: true
 *         schema: { type: string, minLength: 1, maxLength: 128 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/StreamCreateRequest' }
 *     responses:
 *       201: { description: Stream created }
 *       400: { description: Validation error }
 *       409: { description: Idempotency key conflict }
 *       503: { description: Idempotency dependency unavailable }
 * /api/streams/{id}:
 *   get:
 *     summary: Get a stream by ID
 *     tags: [streams]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Stream details }
 *       404: { description: Not found }
 *   delete:
 *     summary: Cancel a stream
 *     tags: [streams]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Stream cancelled }
 *       404: { description: Not found }
 *       409: { description: Already cancelled or completed }
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
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
import { SerializationLogger, info, debug, warn } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

export const streamsRouter = Router();

// ── Types ────────────────────────────────────────────────────────────────────

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
type StreamListingDependencyState = 'healthy' | 'unavailable';
type IdempotencyDependencyState  = 'healthy' | 'unavailable';

type NormalizedCreateStreamInput = {
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

// Amount fields that must be decimal strings per serialization policy
const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;

// ── In-memory store (export for test-level inspection / reset) ────────────────
export const streams: Stream[] = [];

// ── Dependency state (injectable for tests) ───────────────────────────────────
const streamListingDependency = { state: 'healthy' as StreamListingDependencyState };
const idempotencyDependency   = { state: 'healthy' as IdempotencyDependencyState };
const idempotencyStore        = new Map<string, StoredIdempotentResponse>();

export function setStreamListingDependencyState(state: StreamListingDependencyState): void {
  streamListingDependency.state = state;
}
export function setIdempotencyDependencyState(state: IdempotencyDependencyState): void {
  idempotencyDependency.state = state;
}
export function resetStreamIdempotencyStore(): void {
  idempotencyStore.clear();
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
  if (includeTotalParam === 'true')  return true;
  if (includeTotalParam === 'false') return false;
  throw validationError('include_total must be true or false');
}

function parseIdempotencyKey(headerValue: unknown): string {
  if (Array.isArray(headerValue) || typeof headerValue !== 'string') {
    throw validationError('Idempotency-Key header is required for unsafe POST operations');
  }
  const trimmed = headerValue.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw validationError('Idempotency-Key header must be between 1 and 128 characters');
  }
  if (!/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    throw validationError('Idempotency-Key header must use only letters, numbers, colon, underscore, or hyphen');
  }
  return trimmed;
}

// ── Body normaliser (uses Zod-compatible path; also calls decimal validator) ──

function normalizeCreateStreamInput(body: Record<string, unknown>): NormalizedCreateStreamInput {
  const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } = body;

  if (typeof sender !== 'string' || sender.trim() === '') {
    throw validationError('sender must be a non-empty string');
  }
  if (typeof recipient !== 'string' || recipient.trim() === '') {
    throw validationError('recipient must be a non-empty string');
  }

  // Validate decimal fields — also catches number types passed as amounts
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

  const depositResult = validateDecimalString(depositAmount, 'depositAmount');
  const validatedDeposit = depositResult.valid && depositResult.value ? depositResult.value : '0';
  if (depositAmount !== undefined && depositAmount !== null) {
    if (parseFloat(validatedDeposit) <= 0) throw validationError('depositAmount must be greater than zero');
  }

  const rateResult = validateDecimalString(ratePerSecond, 'ratePerSecond');
  const validatedRate = rateResult.valid && rateResult.value ? rateResult.value : '0';
  if (ratePerSecond !== undefined && ratePerSecond !== null) {
    if (parseFloat(validatedRate) < 0) throw validationError('ratePerSecond cannot be negative');
  }

  let validatedStartTime = Math.floor(Date.now() / 1000);
  if (startTime !== undefined) {
    if (typeof startTime !== 'number' || !Number.isInteger(startTime) || startTime < 0) {
      throw validationError('startTime must be a non-negative integer');
    }
    validatedStartTime = startTime;
  }

  let validatedEndTime = 0;
  if (endTime !== undefined) {
    if (typeof endTime !== 'number' || !Number.isInteger(endTime) || endTime < 0) {
      throw validationError('endTime must be a non-negative integer');
    }
    validatedEndTime = endTime;
  }

  return {
    sender: sender.trim(),
    recipient: recipient.trim(),
    depositAmount: validatedDeposit,
    ratePerSecond: validatedRate,
    startTime: validatedStartTime,
    endTime: validatedEndTime,
  };
}

function fingerprintCreateStreamInput(input: NormalizedCreateStreamInput): string {
  return JSON.stringify(input);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/streams
 * List streams with cursor-based pagination.
 */
streamsRouter.get(
  '/',
  asyncHandler(async (req: any, res: any) => {
    const requestId    = req.id as string | undefined;
    const limit        = parseLimit(req.query.limit);
    const cursor       = parseCursor(req.query.cursor);
    const includeTotal = parseIncludeTotal(req.query.include_total);

    if (streamListingDependency.state !== 'healthy') {
      warn('Stream listing dependency unavailable', { dependency: 'stream-list-view', requestId });
      throw serviceUnavailable('Stream list is temporarily unavailable. Retry when dependency health is restored.');
    }

    const sortedStreams = [...streams].sort((a, b) => a.id.localeCompare(b.id));
    const startIndex   = cursor ? sortedStreams.findIndex((s) => s.id > cursor.lastId) : 0;
    const normStart    = startIndex === -1 ? sortedStreams.length : startIndex;
    const pageStreams   = sortedStreams.slice(normStart, normStart + limit);
    const hasMore      = normStart + pageStreams.length < sortedStreams.length;
    const nextCursor   = hasMore && pageStreams.length > 0
      ? encodeCursor(pageStreams[pageStreams.length - 1]!.id)
      : undefined;

    info('Listing streams', { limit, returned: pageStreams.length, hasMore, requestId });

    const response: { streams: typeof pageStreams; has_more: boolean; total?: number; next_cursor?: string } = {
      streams: pageStreams,
      has_more: hasMore,
    };
    if (includeTotal)  response.total       = sortedStreams.length;
    if (nextCursor)    response.next_cursor = nextCursor;

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
    const { id } = req.params;
    debug('Fetching stream', { id });
    const stream = streams.find((s) => s.id === id);
    if (!stream) throw notFound('Stream', id);
    res.json({ stream });
  }),
);

/**
 * POST /api/streams
 * Create a new stream. Requires authentication.
 */
streamsRouter.post(
  '/',
  authenticate,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const requestId      = (req as any).id as string | undefined;
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    if (idempotencyDependency.state !== 'healthy') {
      warn('Idempotency dependency unavailable', { dependency: 'idempotency-store', requestId, idempotencyKey });
      throw serviceUnavailable('Idempotency processing is temporarily unavailable. Retry after dependency health is restored.');
    }

    info('Creating new stream', { requestId, idempotencyKey });

    let normalizedInput: NormalizedCreateStreamInput;
    try {
      normalizedInput = normalizeCreateStreamInput(req.body ?? {});
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

    const requestFingerprint = fingerprintCreateStreamInput(normalizedInput);
    const existingResponse   = idempotencyStore.get(idempotencyKey);

    if (existingResponse) {
      if (existingResponse.requestFingerprint !== requestFingerprint) {
        throw new ApiError(ApiErrorCode.CONFLICT, 'Idempotency-Key has already been used for a different request payload', 409, { idempotencyKey });
      }
      info('Replaying idempotent stream creation', { requestId, idempotencyKey, streamId: existingResponse.body.id });
      res.set('Idempotency-Key', idempotencyKey);
      res.set('Idempotency-Replayed', 'true');
      res.status(existingResponse.statusCode).json(existingResponse.body);
      return;
    }

    const id     = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const stream: Stream = {
      id,
      sender:        normalizedInput.sender,
      recipient:     normalizedInput.recipient,
      depositAmount: normalizedInput.depositAmount,
      ratePerSecond: normalizedInput.ratePerSecond,
      startTime:     normalizedInput.startTime,
      endTime:       normalizedInput.endTime,
      status:        'active',
    };

    streams.push(stream);
    idempotencyStore.set(idempotencyKey, { requestFingerprint, statusCode: 201, body: stream });

    SerializationLogger.amountSerialized(2, requestId);
    info('Stream created', { id, requestId, idempotencyKey });

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
    const { id }    = req.params;
    const requestId = (req as any).id as string | undefined;

    debug('Deleting stream', { id });

    const index = streams.findIndex((s) => s.id === id);
    if (index === -1) throw notFound('Stream', id);

    const stream = streams[index];
    if (stream === undefined) throw notFound('Stream', id);

    if (stream.status === 'cancelled') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Stream is already cancelled', 409, { streamId: id });
    }
    if (stream.status === 'completed') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Cannot cancel a completed stream', 409, { streamId: id });
    }

    streams[index] = { ...stream, status: 'cancelled' };
    info('Stream cancelled', { id });
    recordAuditEvent('STREAM_CANCELLED', 'stream', id as string, (req as any).correlationId);

    res.json({ message: 'Stream cancelled', id });
  }),
);
