import { Router } from 'express';
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
import { requireAuth } from '../middleware/auth.js';
import { SerializationLogger, info, debug } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';

/**
 * Streams API routes.
 *
 * All amount fields (depositAmount, ratePerSecond) are validated as decimal
 * strings before storage and returned as decimal strings in every response.
 * This prevents floating-point precision loss when amounts cross the
 * chain/API boundary.
 *
 * Trust boundaries
 * ----------------
 * - Public internet clients: may list, read, create, and cancel streams.
 *   Authentication/authorisation is a planned follow-up (see non-goals below).
 * - Internal workers: same surface; no elevated privileges yet.
 *
 * Failure modes
 * -------------
 * - Invalid decimal string  → 400 VALIDATION_ERROR with per-field details
 * - Missing required field  → 400 VALIDATION_ERROR
 * - Stream not found        → 404 NOT_FOUND
 * - Duplicate cancel        → 409 CONFLICT
 *
 * Non-goals (intentionally deferred)
 * -----------------------------------
 * - Persistent storage (in-memory only; PostgreSQL integration is follow-up)
 * - Authentication / JWT enforcement
 * - Rate limiting
 * - Duplicate-delivery protection
 *
 * @openapi
 * /api/streams:
 *   get:
 *     summary: List streams with cursor pagination
 *     description: |
 *       Returns active streaming payment streams with cursor-based pagination.
 *       All amount fields are serialized as decimal strings for precision.
 *       
 *       Pagination uses opaque forward-only cursors for efficient large result sets.
 *       Results are ordered by ascending stream ID. Clients must treat `next_cursor`
 *       as an opaque token and must not derive meaning from its contents.
 *       
 *       Service-level outcomes:
 *       - A successful page is a stable prefix of the current in-process stream view.
 *       - Replaying the same cursor is safe and does not create duplicate records within a page.
 *       - Cursor traversal guarantees forward progress by sort key; aggregate totals are optional
 *         metadata and are not part of the cursor consistency contract.
 *       - If the last-seen stream disappears between requests, the cursor still resumes after
 *         the encoded sort key instead of failing as stale.
 *       - If the listing dependency is unavailable, the service fails closed with 503.
 *       
 *       Trust boundaries for this endpoint:
 *       - Public internet clients may list streams but may not mutate server-side pagination state.
 *       - Authenticated partners consume the same read contract and must treat cursors as opaque.
 *       - Administrators diagnose incidents through request IDs and structured logs; they do not
 *         receive elevated response payloads.
 *       - Internal workers may refresh the backing view but are not exposed through this route.
 *     tags:
 *       - streams
 *     parameters:
 *       - name: cursor
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *         description: Opaque cursor returned by a prior page
 *       - name: limit
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Maximum number of streams to return (1-100, default 50)
 *       - name: include_total
 *         in: query
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: |
 *           When true, include `total` as the count of matching streams visible at the time of
 *           this response. This count is informational only and may change between cursor requests.
 *     responses:
 *       200:
 *         description: Paginated list of streams
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 streams:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Stream'
 *                 has_more:
 *                   type: boolean
 *                   description: Whether another page is currently available after this one
 *                 total:
 *                   type: integer
 *                   description: Optional count of matching streams at response time when `include_total=true`
 *                 next_cursor:
 *                   type: string
 *                   description: Opaque cursor for the next page (omitted if no more results)
 *                   example: "eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tMTcwOTEyMzQ1Njc4OS1hYmMxMiJ9"
 *       400:
 *         description: Invalid pagination parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       503:
 *         description: Stream listing dependency unavailable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 *   post:
 *     summary: Create a new stream
 *     description: |
 *       Creates a new streaming payment stream with the specified parameters.
 *       All amount fields must be provided as decimal strings.
 *       Unsafe POST semantics are protected by an `Idempotency-Key` header.
 *       
 *       Service-level outcomes:
 *       - The first successful request for a given idempotency key creates exactly one stream.
 *       - Retrying the same key with the same normalized payload replays the original 201 body.
 *       - Reusing a key for a different payload fails with 409 to avoid ambiguous side effects.
 *       - If the idempotency store is unavailable, the service fails closed with 503.
 *       
 *       **Trust Boundary Note**: Amount fields are validated to ensure no precision
 *       loss when crossing the chain/API boundary. Invalid inputs receive explicit
 *       error responses.
 *     tags:
 *       - streams
 *     parameters:
 *       - name: Idempotency-Key
 *         in: header
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 1
 *           maxLength: 128
 *         description: Client-supplied key used to deduplicate unsafe POST retries
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamCreateRequest'
 *     responses:
 *       201:
 *         description: Stream created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
 *       409:
 *         description: Idempotency key reused with a different request payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       503:
 *         description: Idempotency dependency unavailable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       400:
 *         description: Validation error
 * /api/streams/{id}:
 *   get:
 *     summary: Get a stream by ID
 *     tags: [streams]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Stream details
 *       404:
 *         description: Not found
 *   delete:
 *     summary: Cancel a stream
 *     tags: [streams]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Stream cancelled
 *       404:
 *         description: Not found
 *       409:
 *         description: Already cancelled or completed
 */

export const streamsRouter = Router();

// Amount fields that must be decimal strings per serialization policy
const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;

// In-memory stream store (placeholder for DB integration)
export const streams: Array<{
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
  status: string;
}

// In-memory stream store — placeholder until PostgreSQL integration lands
const streams: Stream[] = [];

type StreamsCursor = {
  v: 1;
  lastId: string;
};

type StreamListingDependencyState = 'healthy' | 'unavailable';
type IdempotencyDependencyState = 'healthy' | 'unavailable';

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
  body: {
    id: string;
    sender: string;
    recipient: string;
    depositAmount: string;
    ratePerSecond: string;
    startTime: number;
    endTime: number;
    status: string;
  };
};

const streamListingDependency = {
  state: 'healthy' as StreamListingDependencyState,
};

const idempotencyDependency = {
  state: 'healthy' as IdempotencyDependencyState,
};

const idempotencyStore = new Map<string, StoredIdempotentResponse>();

export function setStreamListingDependencyState(state: StreamListingDependencyState): void {
  streamListingDependency.state = state;
}

export function setIdempotencyDependencyState(state: IdempotencyDependencyState): void {
  idempotencyDependency.state = state;
}

export function resetStreamIdempotencyStore(): void {
  idempotencyStore.clear();
}

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
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) ||
    !('lastId' in parsed) ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { lastId?: unknown }).lastId !== 'string' ||
    (parsed as { lastId: string }).lastId.trim() === ''
  ) {
    throw validationError('cursor must be a valid opaque pagination token');
  }

  return parsed as StreamsCursor;
}

function parseLimit(limitParam: unknown): number {
  if (limitParam === undefined) {
    return 50;
  }

  if (Array.isArray(limitParam) || typeof limitParam !== 'string' || !/^\d+$/.test(limitParam)) {
    throw validationError('limit must be an integer between 1 and 100');
  }

  const parsedLimit = Number.parseInt(limitParam, 10);
  if (parsedLimit < 1 || parsedLimit > 100) {
    throw validationError('limit must be an integer between 1 and 100');
  }

  return parsedLimit;
}

function parseCursor(cursorParam: unknown): StreamsCursor | undefined {
  if (cursorParam === undefined) {
    return undefined;
  }

  if (Array.isArray(cursorParam) || typeof cursorParam !== 'string' || cursorParam.trim() === '') {
    throw validationError('cursor must be a valid opaque pagination token');
  }

  return decodeCursor(cursorParam);
}

function parseIncludeTotal(includeTotalParam: unknown): boolean {
  if (includeTotalParam === undefined) {
    return false;
  }

  if (Array.isArray(includeTotalParam) || typeof includeTotalParam !== 'string') {
    throw validationError('include_total must be true or false');
  }

  if (includeTotalParam === 'true') {
    return true;
  }

  if (includeTotalParam === 'false') {
    return false;
  }

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

function normalizeCreateStreamInput(body: Record<string, unknown>): NormalizedCreateStreamInput {
  const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } = body;

  if (typeof sender !== 'string' || sender.trim() === '') {
    throw validationError('sender must be a non-empty string');
  }

  if (typeof recipient !== 'string' || recipient.trim() === '') {
    throw validationError('recipient must be a non-empty string');
  }

  const amountValidation = validateAmountFields(
    { depositAmount, ratePerSecond } as Record<string, unknown>,
    AMOUNT_FIELDS as unknown as string[]
  );

  if (!amountValidation.valid) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      'Invalid decimal string format for amount fields',
      400,
      {
        errors: amountValidation.errors.map((e) => ({
          field: e.field,
          code: e.code,
          message: e.message,
        })),
      }
    );
  }

  const depositResult = validateDecimalString(depositAmount, 'depositAmount');
  const validatedDepositAmount = depositResult.valid && depositResult.value
    ? depositResult.value
    : '0';

  if (depositAmount !== undefined && depositAmount !== null) {
    const depositNum = parseFloat(validatedDepositAmount);
    if (depositNum <= 0) {
      throw validationError('depositAmount must be greater than zero');
    }
  }

  const rateResult = validateDecimalString(ratePerSecond, 'ratePerSecond');
  const validatedRatePerSecond = rateResult.valid && rateResult.value
    ? rateResult.value
    : '0';

  if (ratePerSecond !== undefined && ratePerSecond !== null) {
    const rateNum = parseFloat(validatedRatePerSecond);
    if (rateNum < 0) {
      throw validationError('ratePerSecond cannot be negative');
    }
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
    depositAmount: validatedDepositAmount,
    ratePerSecond: validatedRatePerSecond,
    startTime: validatedStartTime,
    endTime: validatedEndTime,
  };
}

function fingerprintCreateStreamInput(input: NormalizedCreateStreamInput): string {
  return JSON.stringify(input);
}

/**
 * GET /api/streams
 * List streams with cursor-based pagination
 */
streamsRouter.get(
  '/',
  asyncHandler(async (req: any, res: any) => {
    const requestId = (req as { id?: string }).id;
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const includeTotal = parseIncludeTotal(req.query.include_total);

    if (streamListingDependency.state !== 'healthy') {
      warn('Stream listing dependency unavailable', {
        dependency: 'stream-list-view',
        requestId,
      });
      throw serviceUnavailable('Stream list is temporarily unavailable. Retry when dependency health is restored.');
    }

    const sortedStreams = [...streams].sort((a, b) => a.id.localeCompare(b.id));
    const startIndex = cursor
      ? sortedStreams.findIndex((stream) => stream.id > cursor.lastId)
      : 0;

    const normalizedStartIndex = startIndex === -1 ? sortedStreams.length : startIndex;
    const pageStreams = sortedStreams.slice(normalizedStartIndex, normalizedStartIndex + limit);
    const hasMore = normalizedStartIndex + pageStreams.length < sortedStreams.length;
    const nextCursor = hasMore && pageStreams.length > 0
      ? encodeCursor(pageStreams[pageStreams.length - 1].id)
      : undefined;

    info('Listing streams with pagination', {
      cursorProvided: Boolean(cursor),
      includeTotal,
      limit,
      returned: pageStreams.length,
      hasMore,
      totalIncluded: includeTotal,
      total: includeTotal ? sortedStreams.length : undefined,
      requestId,
    });
    debug('Streams page computed', {
      startIndex: normalizedStartIndex,
      lastId: cursor?.lastId ?? null,
      nextCursorPresent: Boolean(nextCursor),
      requestId,
    });

    const response: {
      streams: typeof pageStreams;
      has_more: boolean;
      total?: number;
      next_cursor?: string;
    } = {
      streams: pageStreams,
      has_more: hasMore,
    };

    if (includeTotal) {
      response.total = sortedStreams.length;
    }

    if (nextCursor) {
      response.next_cursor = nextCursor;
    }

    res.json(response);
  })
);

/**
 * GET /api/streams/:id
 * Get a single stream by ID.
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: any, res: any) => {
    const { id } = req.params;
    const requestId = (req as { id?: string }).id;

    debug('Fetching stream', { id });

    const stream = streams.find((s) => s.id === id);
    if (!stream) throw notFound('Stream', id);

    res.json(successResponse({ stream }));
  })
);

/**
 * POST /api/streams
 * Create a new stream
 */
streamsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } = req.body ?? {};
    const requestId = (req as { id?: string }).id;
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    if (idempotencyDependency.state !== 'healthy') {
      warn('Idempotency dependency unavailable', {
        dependency: 'idempotency-store',
        requestId,
        idempotencyKey,
      });
      throw serviceUnavailable('Idempotency processing is temporarily unavailable. Retry after dependency health is restored.');
    }

    info('Creating new stream', { requestId, idempotencyKey });

    let normalizedInput: NormalizedCreateStreamInput;
    try {
      normalizedInput = normalizeCreateStreamInput(req.body ?? {});
    } catch (error) {
      const amountValidation = validateAmountFields(
        {
          depositAmount: req.body?.depositAmount,
          ratePerSecond: req.body?.ratePerSecond,
        } as Record<string, unknown>,
        AMOUNT_FIELDS as unknown as string[]
      );

      if (!amountValidation.valid) {
        for (const err of amountValidation.errors) {
          SerializationLogger.validationFailed(
            err.field || 'unknown',
            err.rawValue,
            err.code,
            requestId
          );
        }
      }

      throw error;
    }

    const requestFingerprint = fingerprintCreateStreamInput(normalizedInput);
    const existingResponse = idempotencyStore.get(idempotencyKey);

    if (existingResponse) {
      if (existingResponse.requestFingerprint !== requestFingerprint) {
        throw new ApiError(
          ApiErrorCode.CONFLICT,
          'Idempotency-Key has already been used for a different request payload',
          409,
          { idempotencyKey }
        );
      }

      info('Replaying idempotent stream creation response', {
        requestId,
        idempotencyKey,
        streamId: existingResponse.body.id,
      });

      res.set('Idempotency-Key', idempotencyKey);
      res.set('Idempotency-Replayed', 'true');
      res.status(existingResponse.statusCode).json(existingResponse.body);
      return;
    }

    const id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const stream = {
      id,
      sender: normalizedInput.sender,
      recipient: normalizedInput.recipient,
      depositAmount: normalizedInput.depositAmount,
      ratePerSecond: normalizedInput.ratePerSecond,
      startTime: normalizedInput.startTime,
      endTime: normalizedInput.endTime,
      status: 'active',
    };

    streams.push(stream);
    idempotencyStore.set(idempotencyKey, {
      requestFingerprint,
      statusCode: 201,
      body: stream,
    });

    SerializationLogger.amountSerialized(2, requestId);
    info('Stream created', { id, requestId, idempotencyKey });

    res.set('Idempotency-Key', idempotencyKey);
    res.set('Idempotency-Replayed', 'false');
    res.status(201).json(stream);
  }),
);

/**
 * DELETE /api/streams/:id
 * Cancel a stream
 */
streamsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = (req as { id?: string }).id;

    debug('Deleting stream', { id });

    const index = streams.findIndex((s) => s.id === id);
    if (index === -1) throw notFound('Stream', id);

    const stream = streams[index];
    // noUncheckedIndexedAccess: stream is guaranteed non-null because findIndex returned >= 0
    if (stream === undefined) throw notFound('Stream', id);

    if (stream.status === 'cancelled') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Stream is already cancelled', 409, {
        streamId: id,
      });
    }
    if (stream.status === 'completed') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Cannot cancel a completed stream', 409, {
        streamId: id,
      });
    }

    streams[index] = { ...stream, status: 'cancelled' };

    info('Stream cancelled', { id });

    recordAuditEvent('STREAM_CANCELLED', 'stream', id, req.correlationId);

    res.json({ message: 'Stream cancelled', id });
  })
);
