/**
 * GET /api/streams/:id/events — Server-Sent Events for live stream updates,
 * with Last-Event-ID resumption.
 *
 * @module routes/streams/sse
 */
import type { Request, Response, Router } from 'express';
import { loadConfig } from '../../config/env.js';
import { asyncHandler, notFound } from '../../middleware/errorHandler.js';
import { authenticateApiKey, requireScope } from '../../middleware/auth.js';
import { streamRepository } from '../../db/repositories/streamRepository.js';
import { STALE_CURSOR_ERROR_CODE, StaleCursorError } from '../../indexer/store.js';
import { getClientIp } from '../../ws/connectionLimiter.js';
import type { StreamUpdateEvent } from '../../ws/hub.js';
import {
  SSE_CLOSE_EVENT,
  SSE_CLOSE_REASONS,
  subscribeToSseStream,
  registerSseShutdownCallback,
} from '../../streams/sseEmitter.js';
import { resolveSseConnectionLimits, tryAcquireSseConnection } from '../../streams/sseConnectionLimiter.js';
import { formatSseStreamUpdate, streamUpdateEnvelope } from '../../serialization/stream.js';
import { warn } from '../../utils/logger.js';
import { parseLastEventIdHeader, rethrowDbError } from './guards.js';
import {
  getReplayEventStore,
  rejectOverLimitConnection,
  rejectUnauthorizedRealtimeRequest,
  replayStreamEvents,
  trackConnection,
} from './realtime.js';

async function streamEventsHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  const requestId = req.correlationId;
  if (!id) throw notFound('Stream', '');

  if (rejectUnauthorizedRealtimeRequest(req, res)) return;

  // Reserve bounded SSE capacity before repository work or header flush.
  const clientIp = getClientIp(req);
  const sseLimits = resolveSseConnectionLimits();
  const apiKey = (req.headers['x-api-key'] as string | undefined) ?? undefined;
  const attempt = tryAcquireSseConnection(clientIp, sseLimits, apiKey);
  if (!attempt.ok) {
    rejectOverLimitConnection(res, attempt, sseLimits, 'SSE connection rejected by limiter', { id, requestId, ip: clientIp });
  }

  const connection = trackConnection(req, res, attempt.connection, { kind: 'SSE', id, requestId });

  const writeSse = (frame: string): boolean => {
    if (connection.closed || res.destroyed || res.writableEnded) return false;
    try {
      res.write(frame);
      return true;
    } catch (err) {
      warn('SSE write failed; closing connection', {
        id,
        requestId,
        ip: attempt.connection.ip,
        error: err instanceof Error ? err.message : String(err),
      });
      connection.cleanup('write_error');
      try {
        res.end();
      } catch {
        // best-effort shutdown only
      }
      return false;
    }
  };

  // Verify the stream exists only after capacity is reserved, so over-limit
  // attempts are rejected before they can fan out into repository work.
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

  // Validate Last-Event-ID before switching to SSE framing so invalid values
  // get a standard JSON 400.
  let lastEventId: string | undefined;
  try {
    lastEventId = parseLastEventIdHeader(req.headers['last-event-id']);
  } catch (err) {
    connection.cleanup('validation_error');
    throw err;
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  } catch (err) {
    connection.cleanup('flush_error');
    throw err;
  }

  // The retry hint tells browser EventSource clients how long to back off
  // before reconnecting.
  const sseConfig = loadConfig();
  if (!writeSse(`: ok\n\nretry: ${sseConfig.sseRetryMs}\n\n`)) return;

  // Heartbeats stop proxies and load balancers from reaping idle connections.
  const heartbeatInterval = setInterval(() => {
    writeSse(': heartbeat\n\n');
  }, sseConfig.sseHeartbeatIntervalMs);
  heartbeatInterval.unref?.();
  connection.onCleanup(() => clearInterval(heartbeatInterval));

  // Bound connection lifetime. The typed `event: close` frame lets clients
  // tell a deliberate rotation from a network drop and reconnect promptly.
  // @security payload contains only the reason string — no stream data or PII.
  const maxDurationTimer = setTimeout(() => {
    if (connection.closed) return;
    writeSse(`event: ${SSE_CLOSE_EVENT}\ndata: ${JSON.stringify({ reason: SSE_CLOSE_REASONS.MAX_DURATION })}\n\n`);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    connection.cleanup('max_duration');
  }, sseLimits.maxConnectionDurationMs);
  maxDurationTimer.unref?.();
  connection.onCleanup(() => clearTimeout(maxDurationTimer));

  // Replay stored events after Last-Event-ID before switching to live updates.
  const eventStore = lastEventId ? getReplayEventStore() : undefined;
  if (lastEventId && eventStore) {
    try {
      await replayStreamEvents(eventStore, lastEventId, id, () => connection.closed, (event) =>
        writeSse(formatSseStreamUpdate(streamUpdateEnvelope(id, event, req.correlationId))),
      );
    } catch (err) {
      if (err instanceof StaleCursorError) {
        writeSse(
          `event: error\ndata: ${JSON.stringify({
            code: STALE_CURSOR_ERROR_CODE,
            message: 'Replay cursor no longer exists; resync from fromLedger',
          })}\n\n`,
        );
        warn('SSE replay cursor is stale', { afterEventId: err.afterEventId, requestId });
        res.end();
        connection.cleanup('stale_cursor');
        return;
      }
      warn('Failed to replay SSE events from store', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  if (connection.closed) return;

  const unsubscribe = subscribeToSseStream(id, (event: StreamUpdateEvent) => {
    if (event.streamId === id) {
      writeSse(formatSseStreamUpdate(
        streamUpdateEnvelope(event.streamId, event, req.correlationId || event.correlationId),
      ));
    }
  });
  connection.onCleanup(unsubscribe);

  // On shutdown, drain with a retry:0 directive instead of an abrupt socket
  // close; force-destroy if the per-connection drain timeout is exceeded.
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
      connection.cleanup('shutdown_drain');
    },
    () => {
      try {
        if (!res.destroyed) res.destroy();
      } catch {
        // Best-effort — the socket may already be gone.
      }
    },
  );
  connection.onCleanup(deregisterShutdown);
}

export function registerSseRoutes(router: Router): void {
  router.get('/:id/events', authenticateApiKey, requireScope('streams:read'), asyncHandler(streamEventsHandler));
}
