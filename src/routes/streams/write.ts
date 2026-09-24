/**
 * Write handlers: create (idempotent), cancel and status transitions.
 *
 * @module routes/streams/write
 */
import type { Request, Response, Router } from 'express';
import { ApiError } from '../../errors.js';
import {
  ApiErrorCode,
  asyncHandler,
  notFound,
  serviceUnavailable,
  validationError,
} from '../../middleware/errorHandler.js';
import { requireIdempotencyKey, parseIdempotencyKeyHeader } from '../../middleware/requestProtection.js';
import { authenticate, requireAuth, authenticateApiKey, requireScope } from '../../middleware/auth.js';
import { recordAuditEvent } from '../../lib/auditLog.js';
import { streamRepository } from '../../db/repositories/streamRepository.js';
import { createStreamFromApi } from '../../db/repositories/streamApiQueries.js';
import { issueWriteFencePin, WRITE_FENCE_HEADER } from '../../db/writeFencePin.js';
import { ENVELOPE_VERSION } from '../../redis/idempotencyStore.js';
import { streamsCreatedTotal, isValidStreamStatus } from '../../metrics/businessMetrics.js';
import { toApiStream } from '../../serialization/stream.js';
import type { ApiStreamStatus } from '../../streams/status.js';
import { successResponse, idempotentReplayResponse } from '../../utils/response.js';
import { SerializationLogger, debug, info, warn } from '../../utils/logger.js';
import {
  API_STREAM_STATUS_VALUES,
  assertApiTransition,
  enforceStreamScope,
  fingerprintInput,
  parseCreateStreamBody,
  withDbErrors,
  withStatusConflicts,
} from './guards.js';
import {
  getIdempotencyStore,
  getIdempotencyTtlSeconds,
  isIdempotencyHealthy,
} from './state.js';

/**
 * POST /api/streams
 * Create a new stream. Requires authentication + Idempotency-Key header.
 *
 * A SHA-256 fingerprint of the normalised body is cached with the response:
 * same key + same body replays the original 201, same key + different body
 * is a 409.
 */
async function createStreamHandler(req: Request, res: Response): Promise<void> {
  const requestId = req.correlationId;
  const correlationId = req.correlationId;
  const idempotencyKey = parseIdempotencyKeyHeader(req.header('Idempotency-Key'));

  if (!isIdempotencyHealthy()) {
    warn('Idempotency dependency unavailable', {
      dependency: 'idempotency-store',
      requestId,
      // Never log the key value at warn/error level — it could be a secret.
      idempotencyKeyLength: idempotencyKey.length,
    });
    throw serviceUnavailable('Idempotency processing is temporarily unavailable. Retry after dependency health is restored.');
  }

  info('Creating new stream', { requestId, correlationId });

  const input = parseCreateStreamBody(req.body, requestId);
  const requestFingerprint = fingerprintInput(input);
  const idempotencyStore = getIdempotencyStore();
  const existingResponse = await idempotencyStore.get(idempotencyKey);

  if (existingResponse) {
    if (existingResponse.requestFingerprint !== requestFingerprint) {
      warn('Idempotency-Key reused with different payload', {
        requestId,
        correlationId,
        idempotencyKeyLength: idempotencyKey.length,
        action: 'conflict',
      });
      throw new ApiError(
        409,
        ApiErrorCode.CONFLICT,
        'Idempotency-Key has already been used for a different request payload',
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

  const created = await withDbErrors(() => createStreamFromApi(input, requestId));

  const stream = toApiStream(created.stream);
  const responseEnvelope = successResponse(stream, requestId);
  await idempotencyStore.set(
    idempotencyKey,
    { version: ENVELOPE_VERSION, requestFingerprint, statusCode: 201, body: responseEnvelope },
    getIdempotencyTtlSeconds(),
  );

  SerializationLogger.amountSerialized(2, requestId);
  info('Stream created', { id: stream.id, requestId, correlationId, action: 'created' });
  recordAuditEvent('STREAM_CREATED', 'stream', stream.id, correlationId ?? '', {
    depositAmount: input.depositAmount,
    ratePerSecond: input.ratePerSecond,
    sender: input.sender,
    recipient: input.recipient,
  });

  if (isValidStreamStatus(stream.status)) {
    streamsCreatedTotal.inc({ status: stream.status });
  }

  // Read-your-writes fence pin: the client echoes it on its next GET
  // /api/streams so that read is routed to the primary while the replica may
  // still be lagging. Pin issuance must never fail stream creation.
  try {
    res.set(WRITE_FENCE_HEADER, issueWriteFencePin());
  } catch (pinErr) {
    warn('Failed to issue write-fence pin', {
      error: pinErr instanceof Error ? pinErr.message : String(pinErr),
      requestId,
    });
  }

  res.set('Idempotency-Key', idempotencyKey);
  res.set('Idempotency-Replayed', 'false');
  res.status(201).json(responseEnvelope);
}

/**
 * DELETE /api/streams/:id
 * Cancel a stream. Requires authentication.
 */
async function cancelStreamHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  const requestId = req.correlationId;
  if (!id) throw notFound('Stream', '');
  debug('Cancelling stream', { id });

  const record = await withDbErrors(() => streamRepository.getById(id));
  if (!record) throw notFound('Stream', id);

  // Tenant ownership check: an authenticated, scoped caller can only cancel
  // their own streams. req.callerAddress is set by enforceStreamScope when
  // the JWT payload contains an address (non-operator role).
  if (req.callerAddress && record.sender_address !== req.callerAddress) {
    // Return 404 to avoid leaking the existence of another tenant's resource.
    throw notFound('Stream', id);
  }

  assertApiTransition(id, record.status, 'cancelled', { includeRequestedStatus: false });
  await withStatusConflicts(id, record.status, 'cancelled', () =>
    streamRepository.updateStream(id, { status: 'cancelled' }, requestId ?? ''),
  );

  info('Stream cancelled', { id, requestId });
  recordAuditEvent('STREAM_CANCELLED', 'stream', id, req.correlationId ?? '');

  res.json(successResponse({ message: 'Stream cancelled', id }, requestId));
}

/**
 * PATCH /api/streams/:id/status
 * Transition a stream to a new status.
 *
 * Body: { "status": "paused" | "active" | "completed" | "cancelled" }
 *
 * Returns 409 CONFLICT when the transition is not permitted by the state machine.
 */
async function updateStreamStatusHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  const requestId = req.correlationId;
  const { status: newStatus } = req.body ?? {};

  if (!id) throw notFound('Stream', '');

  if (typeof newStatus !== 'string' || !API_STREAM_STATUS_VALUES.includes(newStatus as ApiStreamStatus)) {
    throw validationError('status must be one of: active, paused, completed, cancelled');
  }
  const requestedStatus = newStatus as ApiStreamStatus;

  const record = await withDbErrors(() => streamRepository.getById(id));
  if (!record) throw notFound('Stream', id);

  assertApiTransition(id, record.status, requestedStatus, { includeRequestedStatus: true });
  const updated = await withStatusConflicts(id, record.status, requestedStatus, () =>
    streamRepository.updateStream(id, { status: requestedStatus }, requestId ?? ''),
  );

  info('Stream status updated', { id, from: record.status, to: requestedStatus, requestId });
  recordAuditEvent('STREAM_STATUS_UPDATED', 'stream', id, req.correlationId ?? '');

  res.json(successResponse(toApiStream(updated), requestId));
}

export function registerWriteRoutes(router: Router): void {
  router.post(
    '/',
    authenticate,
    requireAuth,
    authenticateApiKey,
    requireScope('streams:write'),
    requireIdempotencyKey,
    asyncHandler(createStreamHandler),
  );
  router.delete(
    '/:id',
    authenticate,
    requireAuth,
    authenticateApiKey,
    requireScope('streams:write'),
    enforceStreamScope,
    asyncHandler(cancelStreamHandler),
  );
  router.patch('/:id/status', asyncHandler(updateStreamStatusHandler));
}
