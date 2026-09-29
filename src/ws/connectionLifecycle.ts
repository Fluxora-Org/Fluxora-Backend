/**
 * WebSocket connection lifecycle.
 *
 * Registers an accepted socket with the registry, wires the per-socket event
 * handlers, and — on close — releases everything the connection held: the
 * per-IP limiter slot, the subscription indexes, pending batch timers, the
 * outbound queue, and the per-client Prometheus gauge.
 *
 * @module ws/connectionLifecycle
 */

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { logger } from '../lib/logger.js';
import { CORRELATION_ID_HEADER, isValidCorrelationId } from '../middleware/correlationId.js';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import { getClientIp, untrackConnection } from './connectionLimiter.js';
import { createClientState, type ConnectionRegistry } from './connectionRegistry.js';
import type { SubscriptionRouter } from './subscriptionRouter.js';
import type { OutboundBackpressure } from './backpressure.js';
import type { BatchAccumulator } from './batching.js';
import {
  removeWsClientBackpressureGauge,
  wsInboundMessageSizeLimitViolationsTotal,
} from '../metrics/wsBackpressure.js';

/** Collaborators the lifecycle needs from the hub. */
export interface ConnectionLifecycleDeps {
  registry: ConnectionRegistry;
  router: SubscriptionRouter;
  batches: BatchAccumulator;
  backpressure: OutboundBackpressure;
  /** Inbound frame ceiling; larger frames are rejected before parsing. */
  maxInboundMessageBytes: number;
  /** Secret used to derive the connection's authenticated subject. */
  jwtSecret: string | undefined;
  /** Validates and dispatches one accepted text frame. */
  handleMessage: (ws: WebSocket, raw: string) => void;
  /** Queues a protocol error frame through the hub's backpressure path. */
  sendError: (ws: WebSocket, code: string, message: string) => void;
}

/** Read a validated correlation ID from the upgrade request headers. */
export function extractCorrelationId(headers: IncomingHttpHeaders): string | undefined {
  const incoming = headers[CORRELATION_ID_HEADER];
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (trimmed.length > 0 && isValidCorrelationId(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

/** Resolve the authenticated subject (JWT `sub`) behind an upgrade request. */
export function extractAuthenticatedSubject(
  req: IncomingMessage,
  jwtSecret: string | undefined
): string | undefined {
  const result = verifyWsToken(req, jwtSecret);
  if (!result.ok) return undefined;

  const subject = result.payload.sub?.trim();
  return subject ? subject : undefined;
}

/** Register an accepted socket and wire its per-socket event handlers. */
export function onConnect(ws: WebSocket, req: IncomingMessage, deps: ConnectionLifecycleDeps): void {
  const connectionId = randomUUID();
  const ip = getClientIp(req);
  const connectedAt = Date.now();
  const correlationId = extractCorrelationId(req.headers);
  const authenticatedSubject = extractAuthenticatedSubject(req, deps.jwtSecret);

  const state = createClientState({
    id: connectionId,
    connectedAt,
    ip,
    correlationId,
    authenticatedSubject,
  });
  deps.registry.register(ws, state);

  logger.info('WebSocket connected', correlationId, {
    event: 'ws_connect',
    connectionId,
    ip,
    timestamp: new Date(connectedAt).toISOString(),
  });

  deps.router.applyHandshakeSubscription(ws, req);

  ws.on('pong', () => {
    const client = deps.registry.get(ws);
    if (client) {
      client.missedPongs = 0;
    }
  });

  ws.on('message', (data, isBinary) => {
    const state = deps.registry.get(ws);

    if (isBinary) {
      deps.sendError(ws, 'BINARY_NOT_SUPPORTED', 'Binary frames are not accepted');
      return;
    }

    const raw = data.toString('utf8');
    const byteLength = Buffer.byteLength(raw, 'utf8');

    if (state) {
      state.metrics.messagesReceived += 1;
      state.metrics.bytesReceived += byteLength;
    }

    if (byteLength > deps.maxInboundMessageBytes) {
      wsInboundMessageSizeLimitViolationsTotal.inc();
      deps.sendError(
        ws,
        'PAYLOAD_TOO_LARGE',
        `Message exceeds ${deps.maxInboundMessageBytes} bytes`
      );
      return;
    }

    if (!deps.registry.checkRateLimit(ws)) {
      deps.sendError(ws, 'RATE_LIMIT_EXCEEDED', 'Too many messages; slow down');
      return;
    }

    deps.handleMessage(ws, raw);
  });

  ws.on('close', (code, reason) => onDisconnect(ws, code, reason, deps));
  ws.on('error', () => ws.close(1011, 'Internal Error'));
}

/**
 * Force-close every socket currently subscribed to a stream ID.
 *
 * The subscriber set is detached from the index before the sockets are closed,
 * so a broadcast racing the disconnect cannot target an already-closed socket.
 *
 * @returns The number of sockets targeted before the disconnect completes.
 */
export function disconnectStreamSubscribers(
  registry: ConnectionRegistry,
  streamId: string
): number {
  const targets = registry.takeStreamSubscribers(streamId);
  if (targets.length === 0) return 0;

  for (const ws of targets) {
    try {
      ws.close(4000, 'admin-forced-disconnect');
    } catch {
      try {
        ws.terminate();
      } catch {
        // no-op
      }
    }
  }

  return targets.length;
}

/**
 * Handles WebSocket disconnection — cleanup and counter decrement.
 *
 * SECURITY: Calls untrackConnection to decrement the per-IP connection counter.
 * This ensures the counter is decremented exactly once when a connection closes,
 * completing the TOCTOU-safe counter lifecycle started in the upgrade handler.
 *
 * COUNTER LIFECYCLE COMPLETION:
 *   - checkAndReserve(ip) incremented the counter ← upgrade handler
 *   - untrackConnection(ip) decrements the counter ← THIS FUNCTION
 *
 * Paired with checkAndReserve in the upgrade handler to maintain correct count
 * under concurrent conditions (no race conditions possible).
 *
 * CLEANUP ACTIONS:
 *   1. Untrack the connection (decrement per-IP counter)
 *   2. Remove all subscription filters
 *   3. Log disconnect event with metrics
 *   4. Remove client from tracking map
 *
 * @param ws The WebSocket that is closing.
 * @param code WebSocket close code (RFC 6455 standard codes).
 * @param reason Close reason (optional UTF-8 string).
 *
 * @security Ensures counter is decremented exactly once per established connection.
 * @security Prevents counter leaks or underflow.
 */
export function onDisconnect(
  ws: WebSocket,
  code: number | undefined,
  reason: Buffer | undefined,
  deps: ConnectionLifecycleDeps
): void {
  const state = deps.registry.get(ws);
  if (!state) return;

  untrackConnection(state.ip, state.authenticatedSubject);

  deps.registry.removeAllSubscriptions(ws);

  // Cancel any pending batch flush timers for this client to prevent sending
  // frames to a closed socket and to release accumulator memory immediately.
  deps.batches.clearConnection(state.id);

  // Remove the per-client gauge time series so it doesn't accumulate.
  removeWsClientBackpressureGauge(state.id);
  deps.backpressure.forget(ws);

  const durationMs = Date.now() - state.connectedAt;
  logger.info('WebSocket disconnected', state.correlationId, {
    event: 'ws_disconnect',
    connectionId: state.id,
    durationMs,
    code: code ?? 0,
    reason: reason?.toString('utf8') ?? '',
    metrics: state.metrics,
  });

  deps.registry.unregister(ws);
}
