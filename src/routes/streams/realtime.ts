/**
 * Plumbing shared by the long-lived stream update endpoints (SSE and
 * long-poll): token auth, connection-limit rejection, idempotent connection
 * teardown and bounded event replay.
 *
 * @module routes/streams/realtime
 */
import type { Request, Response } from 'express';
import { loadConfig } from '../../config/env.js';
import { tooManyRequests } from '../../middleware/errorHandler.js';
import { verifyWsToken } from '../../middleware/tokenAuth.js';
import type { StreamEventRecord } from '../../db/types.js';
import type { ContractEventStore } from '../../indexer/store.js';
import { eventMatchesStreamId } from '../../streams/sseEmitter.js';
import { getStreamHub } from '../../ws/hub.js';
import { errorResponse } from '../../utils/response.js';
import { debug, warn } from '../../utils/logger.js';

/** Replay is bounded so a client-supplied cursor cannot force a full-table scan. */
const REPLAY_MAX_PAGES = 10;
const REPLAY_PAGE_SIZE = 100;

/**
 * Enforce the realtime token policy. When WS_AUTH_REQUIRED is set every
 * request needs a valid token; otherwise the token is optional but a
 * malformed or expired one is still rejected.
 *
 * Config is loaded per request so WS_AUTH_REQUIRED changes take effect
 * without a restart.
 *
 * @returns `true` when a 401 was sent and the caller must stop.
 */
export function rejectUnauthorizedRealtimeRequest(req: Request, res: Response): boolean {
  const { wsAuthRequired, jwtSecret } = loadConfig();
  const authResult = verifyWsToken(req, jwtSecret);
  if (authResult.ok) return false;

  let message: string;
  if (wsAuthRequired) {
    message = `Authentication required: ${authResult.code}`;
  } else if (authResult.code === 'INVALID_TOKEN') {
    message = 'Invalid or expired authentication token';
  } else {
    return false;
  }

  res.status(401).json(errorResponse('UNAUTHORIZED', message, undefined, req.correlationId));
  return true;
}

interface ConnectionLimits {
  maxConnectionsPerIp: number;
  maxGlobalConnections: number;
}

interface RejectedConnection {
  reason: string;
  message: string;
  retryAfterSeconds: number;
  activeConnections: number;
  activeConnectionsForIp: number;
}

/** Log a limiter rejection and throw 429 with a Retry-After header. */
export function rejectOverLimitConnection(
  res: Response,
  attempt: RejectedConnection,
  limits: ConnectionLimits,
  logMessage: string,
  context: { id: string; requestId: string | undefined; ip: string },
): never {
  res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
  warn(logMessage, {
    ...context,
    reason: attempt.reason,
    activeConnections: attempt.activeConnections,
    activeConnectionsForIp: attempt.activeConnectionsForIp,
    maxConnectionsPerIp: limits.maxConnectionsPerIp,
    maxGlobalConnections: limits.maxGlobalConnections,
  });
  throw tooManyRequests(attempt.message, {
    reason: attempt.reason,
    maxConnectionsPerIp: limits.maxConnectionsPerIp,
    maxGlobalConnections: limits.maxGlobalConnections,
    retryAfterSeconds: attempt.retryAfterSeconds,
  });
}

export interface ConnectionLifecycle {
  /** True once cleanup has run; handlers must stop writing. */
  readonly closed: boolean;
  /** Idempotent teardown: runs disposers, releases the slot, detaches listeners. */
  cleanup(reason: string): void;
  /** Register teardown work. Runs immediately if the connection is already closed. */
  onCleanup(dispose: () => void): void;
}

/**
 * Track a limiter-admitted connection so every termination path (client
 * close, abort, response error, timeout, handler error) releases the slot
 * exactly once and leaves no EventEmitter listeners behind.
 */
export function trackConnection(
  req: Request,
  res: Response,
  connection: { ip: string; acceptedAt: number; release(): void },
  labels: { kind: 'SSE' | 'Long-poll'; id: string; requestId: string | undefined },
): ConnectionLifecycle {
  const { kind, id, requestId } = labels;
  let closed = false;
  const disposers: Array<() => void> = [];

  const onResponseClose = (): void => cleanup('client_close');
  const onRequestAborted = (): void => cleanup('client_aborted');
  const onResponseError = (err: Error): void => {
    warn(`${kind} response error`, { id, requestId, ip: connection.ip, error: err.message });
    cleanup('response_error');
  };

  function cleanup(reason: string): void {
    if (closed) return;
    closed = true;
    res.off('close', onResponseClose);
    res.off('error', onResponseError);
    req.off('aborted', onRequestAborted);

    for (const dispose of disposers.splice(0)) dispose();

    connection.release();
    debug(`${kind} connection cleaned up`, {
      id,
      requestId,
      ip: connection.ip,
      reason,
      durationMs: Date.now() - connection.acceptedAt,
    });
  }

  res.once('close', onResponseClose);
  res.once('error', onResponseError);
  req.once('aborted', onRequestAborted);

  return {
    get closed() {
      return closed;
    },
    cleanup,
    onCleanup(dispose) {
      if (closed) dispose();
      else disposers.push(dispose);
    },
  };
}

export function getReplayEventStore(): ContractEventStore | undefined {
  return getStreamHub()?.getEventStore();
}

/**
 * Walk stored events after `afterEventId`, calling `visit` for each one that
 * belongs to `streamId`. Stops when `visit` returns false, when `isClosed()`
 * reports the connection is gone, or after REPLAY_MAX_PAGES pages.
 */
export async function replayStreamEvents(
  eventStore: ContractEventStore,
  afterEventId: string,
  streamId: string,
  isClosed: () => boolean,
  visit: (event: StreamEventRecord) => boolean,
): Promise<void> {
  let cursor: string | undefined = afterEventId;
  let pagesRead = 0;
  do {
    if (isClosed()) return;
    const result = await eventStore.getEvents({ afterEventId: cursor, limit: REPLAY_PAGE_SIZE });

    for (const event of result.events) {
      if (isClosed()) return;
      if (eventMatchesStreamId(event, streamId) && !visit(event)) return;
    }

    cursor = result.nextCursor;
    pagesRead++;
  } while (cursor !== undefined && pagesRead < REPLAY_MAX_PAGES);
}
