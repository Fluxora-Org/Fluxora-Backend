/**
 * GET /api/streams/:id/poll?since=&timeout=
 *
 * Long-polling fallback for clients behind proxies that block WebSockets/SSE.
 * Holds the request open (bounded by a timeout) until an event for the stream
 * arrives or the timeout elapses, then answers with the same update envelope
 * the SSE endpoint uses, or `data: null` on timeout.
 *
 * @module routes/streams/longPoll
 */
import type { Request, Response, Router } from 'express';
import { asyncHandler, notFound, validationError } from '../../middleware/errorHandler.js';
import { authenticateApiKey, requireScope } from '../../middleware/auth.js';
import { streamRepository } from '../../db/repositories/streamRepository.js';
import { STALE_CURSOR_ERROR_CODE, StaleCursorError } from '../../indexer/store.js';
import { getClientIp } from '../../ws/connectionLimiter.js';
import {
  subscribeToSseStream,
  registerSseShutdownCallback,
  type LiveSseStreamUpdateEvent,
} from '../../streams/sseEmitter.js';
import { resolveLongPollConnectionLimits, tryAcquireLongPollConnection } from '../../streams/longPoll.js';
import { streamUpdateEnvelope } from '../../serialization/stream.js';
import { successResponse } from '../../utils/response.js';
import { warn } from '../../lib/logger.js';
import { parseLastEventIdHeader, parseLongPollTimeoutMs, rethrowDbError } from './guards.js';
import {
  getReplayEventStore,
  rejectOverLimitConnection,
  rejectUnauthorizedRealtimeRequest,
  replayStreamEvents,
  trackConnection,
} from './realtime.js';

const MAX_LONG_POLL_HOLD_MS = 30_000;

function isStaleCursorError(err: unknown): boolean {
  // Name check covers errors from a store loaded through a different module instance.
  return err instanceof StaleCursorError || (err as { name?: unknown } | null)?.name === 'StaleCursorError';
}

async function pollStreamHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  const requestId = req.correlationId;
  if (!id) throw notFound('Stream', '');

  if (rejectUnauthorizedRealtimeRequest(req, res)) return;

  const clientIp = getClientIp(req);
  const longPollLimits = resolveLongPollConnectionLimits();
  const apiKey = (req.headers['x-api-key'] as string | undefined) ?? undefined;
  const attempt = tryAcquireLongPollConnection(clientIp, longPollLimits, apiKey);
  if (!attempt.ok) {
    rejectOverLimitConnection(res, attempt, longPollLimits, 'Long-poll connection rejected by limiter', { id, requestId, ip: clientIp });
  }

  const connection = trackConnection(req, res, attempt.connection, { kind: 'Long-poll', id, requestId });

  let record;
  try {
    record = await streamRepository.getById(id);
  } catch (err) {
    connection.cleanup('db_error');
    rethrowDbError(err);
  }
  if (connection.closed) return;
  if (!record) {
    connection.cleanup('not_found');
    throw notFound('Stream', id);
  }

  let sinceEventId: string | undefined;
  let timeoutMs: number;
  try {
    sinceEventId = parseLastEventIdHeader(req.query['since']);
    timeoutMs = parseLongPollTimeoutMs(req.query['timeout']);
  } catch (err) {
    connection.cleanup('validation_error');
    throw err;
  }
  timeoutMs = Math.min(timeoutMs, MAX_LONG_POLL_HOLD_MS, longPollLimits.maxConnectionDurationMs);

  // Answer immediately if a stored event after `since` is already waiting.
  const eventStore = sinceEventId ? getReplayEventStore() : undefined;
  if (sinceEventId && eventStore) {
    try {
      await replayStreamEvents(eventStore, sinceEventId, id, () => connection.closed, (event) => {
        connection.cleanup('replay_event_found');
        res.json(successResponse(streamUpdateEnvelope(id, event, req.correlationId), requestId));
        return false;
      });
    } catch (err) {
      if (isStaleCursorError(err)) {
        connection.cleanup('stale_cursor');
        throw validationError(
          'Replay cursor no longer exists; resync from fromLedger',
          { code: STALE_CURSOR_ERROR_CODE },
        );
      }
      warn('Failed to replay event for long-poll', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  if (connection.closed) return;

  const unsubscribe = subscribeToSseStream(id, (event: LiveSseStreamUpdateEvent) => {
    if (event.streamId !== id || connection.closed || res.destroyed || res.writableEnded) return;
    const envelope = streamUpdateEnvelope(event.streamId, event, req.correlationId || event.correlationId);
    connection.cleanup('event_delivered');
    res.json(successResponse(envelope, requestId));
  });
  connection.onCleanup(unsubscribe);

  const deregisterShutdown = registerSseShutdownCallback(
    async () => {
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.json(successResponse(null, requestId));
        }
      } catch {
        // Best-effort
      }
      connection.cleanup('shutdown_drain');
    },
    () => {
      try {
        if (!res.destroyed) res.destroy();
      } catch {
        // Best-effort
      }
    },
  );
  connection.onCleanup(deregisterShutdown);

  const pollTimer = setTimeout(() => {
    if (connection.closed || res.destroyed || res.writableEnded) return;
    connection.cleanup('timeout_elapsed');
    res.json(successResponse(null, requestId));
  }, timeoutMs);
  pollTimer.unref?.();
  connection.onCleanup(() => clearTimeout(pollTimer));
}

export function registerLongPollRoutes(router: Router): void {
  router.get('/:id/poll', authenticateApiKey, requireScope('streams:read'), asyncHandler(pollStreamHandler));
}
