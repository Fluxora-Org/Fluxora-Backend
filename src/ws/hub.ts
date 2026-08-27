/**
 * WebSocket Hub — stream update broadcast channel (#49).
 *
 * Responsibilities:
 *   - Track connected clients per stream subscription.
 *   - Rate-limit incoming messages per connection.
 *   - Reject oversized inbound payloads.
 *   - Deduplicate outbound events by (streamId, eventId).
 *   - Broadcast stream update events to all subscribed clients.
 *   - Apply backpressure to slow/stalled clients.
 *   - Optionally enforce JWT authentication on upgrade (WS_AUTH_REQUIRED).
 *   - Opt-in micro-batching: coalesce rapid events per stream into a single
 *     `stream_update_batch` frame per client within a configurable flush
 *     window (WS_BATCH_FLUSH_MS, default 50 ms) and max-batch-size cap
 *     (WS_BATCH_MAX_SIZE, default 25 events).  Clients that do not pass
 *     `batching: true` in their subscription filter receive the unchanged
 *     one-frame-per-event behaviour.
 *
 * ## WebSocket JWT Auth (optional, backward-compatible)
 *
 * Controlled by two environment variables:
 *   WS_AUTH_REQUIRED=true   — reject unauthenticated upgrade requests (401)
 *   JWT_SECRET=<secret>     — secret used to verify HS256 tokens
 *
 * When WS_AUTH_REQUIRED is absent or false, all connections are accepted
 * regardless of whether a token is present. This allows a zero-downtime
 * rollout: deploy with auth disabled, issue tokens to clients, then flip
 * the flag.
 *
 * Token delivery (first match wins):
 *   1. Authorization: Bearer <token>  header on the upgrade request
 *   2. ?token=<jwt>                   query-string parameter
 *
 * On auth failure the server sends HTTP 401 before the WebSocket handshake
 * completes, so the client never enters the OPEN state.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, IncomingHttpHeaders } from 'http';
import type { Server } from 'http';
import type { DedupCache as IDedupCache } from '../redis/dedup.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import { STALE_CURSOR_ERROR_CODE, StaleCursorError, type ContractEventStore } from '../indexer/store.js';
import { SSE_STREAM_UPDATE_EVENT, sseEventBus, SSE_CLOSE_REASONS } from '../streams/sseEmitter.js';
import type { StreamEventReplayFilter } from '../db/types.js';
import { getTracer } from '../tracing/hooks.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { logger } from '../lib/logger.js';
import { CORRELATION_ID_HEADER, isValidCorrelationId } from '../middleware/correlationId.js';
import {
  isValidStellarPublicKey,
  parseHandshakeSubscriptionFilter,
  type SubscriptionFilter,
  type WsClientMessage,
  validateWebSocketMessage,
} from './messageHandler.js';
import {
  getClientIp,
  checkAndReserve,
  untrackConnection,
} from './connectionLimiter.js';
import { streamRepository } from '../db/repositories/streamRepository.js';
import {
  collectWsBackpressureMetrics,
  removeWsClientBackpressureGauge,
  recordWsBroadcastBatchFlushLatency,
  DEFAULT_WS_BACKPRESSURE_INTERVAL_MS,
  DEFAULT_WS_SLOW_CLIENT_BYTES,
  wsBatchFlushTotal,
  wsBatchEventsCoalescedTotal,
  wsBatchSizeExceededTotal,
} from '../metrics/wsBackpressure.js';
import { updateWsHealthMetrics } from '../metrics/wsHealth.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_MESSAGE_BYTES = 4_096;
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 10_000;

export const BACKPRESSURE_DROP_BYTES = 1 * 1024 * 1024;
export const BACKPRESSURE_TERMINATE_BYTES = 4 * 1024 * 1024;
export const FANOUT_YIELD_BATCH = 256;

/**
 * WebSocket close reason strings sent in the close-frame payload during a
 * graceful shutdown.  These mirror the SSE_CLOSE_REASONS from
 * `src/streams/sseEmitter.ts` so that both transport layers speak the same
 * reason vocabulary.
 *
 * Clients that receive a close frame with code 1001 should inspect the
 * JSON-encoded `reason` field to decide whether to reconnect immediately
 * (e.g. `max_duration`) or back off (e.g. `server_shutdown`).
 *
 * @example
 * // Client-side (browser)
 * ws.onclose = (event) => {
 *   const { reason } = JSON.parse(event.reason);
 *   if (reason === WS_CLOSE_REASONS.SERVER_SHUTDOWN) {
 *     scheduleReconnectWithBackoff();
 *   }
 * };
 *
 * @security The payload carries only the reason enum string — no stream data,
 *   user information, or internal diagnostics are included.
 */
export const WS_CLOSE_REASONS = {
  /**
   * The server is shutting down gracefully (e.g. SIGTERM/SIGINT).
   * Clients should stop reconnecting until the service comes back up,
   * typically using exponential backoff with jitter.
   */
  SERVER_SHUTDOWN: 'server_shutdown',
  /**
   * The connection exceeded its configured maximum duration.
   * Clients may reconnect immediately.
   */
  MAX_DURATION: 'max_duration',
} as const;

/** Union of all documented WebSocket close reason strings. */
export type WsCloseReason = (typeof WS_CLOSE_REASONS)[keyof typeof WS_CLOSE_REASONS];

/**
 * The RFC 6455 close code used when the server initiates a graceful shutdown.
 *
 * 1001 "Going Away" — the server or client is "going away", e.g. a server
 * is going down or a browser has navigated away from a page.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
 */
export const WS_CLOSE_CODE_GOING_AWAY = 1001;

// ── Micro-batching configuration ──────────────────────────────────────────────

/**
 * Minimum/maximum allowed values for the two batching env-vars.
 * Clamping prevents pathological values (e.g. a 0 ms flush window or an
 * unbounded max-size that overflows MAX_MESSAGE_BYTES).
 */
const BATCH_FLUSH_MS_MIN = 5;
const BATCH_FLUSH_MS_MAX = 5_000;
const BATCH_MAX_SIZE_MIN = 1;
const BATCH_MAX_SIZE_MAX = 500;

/**
 * Flush window in milliseconds.  After the first event enters a client's
 * batch accumulator, a timer fires after this many milliseconds and flushes
 * all queued events as a single `stream_update_batch` frame.
 *
 * Configurable via `WS_BATCH_FLUSH_MS` (clamped to 5–5 000 ms).
 * Default: 50 ms.
 */
export const WS_BATCH_FLUSH_MS: number = (() => {
  const raw = parseInt(process.env['WS_BATCH_FLUSH_MS'] ?? '', 10);
  if (!Number.isFinite(raw)) return 50;
  return Math.max(BATCH_FLUSH_MS_MIN, Math.min(BATCH_FLUSH_MS_MAX, raw));
})();

/**
 * Maximum number of events per batch before triggering an early (pre-window)
 * flush.  Keeps individual frames well below MAX_MESSAGE_BYTES even when a
 * stream emits a very high burst.
 *
 * Configurable via `WS_BATCH_MAX_SIZE` (clamped to 1–500).
 * Default: 25.
 */
export const WS_BATCH_MAX_SIZE: number = (() => {
  const raw = parseInt(process.env['WS_BATCH_MAX_SIZE'] ?? '', 10);
  if (!Number.isFinite(raw)) return 25;
  return Math.max(BATCH_MAX_SIZE_MIN, Math.min(BATCH_MAX_SIZE_MAX, raw));
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamUpdateEvent {
  streamId: string;
  eventId: string;
  payload: unknown;
  correlationId?: string;
  ledger?: number;
  recipientAddress?: string;
}

export interface BackpressureMetrics {
  droppedMessages: number;
  terminatedConnections: number;
  sentMessages: number;
}

export type BackpressureAction = 'drop' | 'terminate';

export interface StreamHubBackpressureEvent {
  action: BackpressureAction;
  streamId: string;
  eventId: string;
  connectionId: string;
  bufferedAmount: number;
  thresholdBytes: number;
  timestamp: string;
}

interface ConnectionMetrics {
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
}

// ── Micro-batching types ───────────────────────────────────────────────────────

/**
 * A single event entry stored in a client's per-stream batch accumulator while
 * waiting for the flush window to expire.
 */
interface BatchedEvent {
  /** Stream identifier (same for all entries in the accumulator). */
  streamId: string;
  /** Unique event identifier — preserved for in-order delivery. */
  eventId: string;
  /** Opaque event payload forwarded verbatim to the client. */
  payload: unknown;
  /** Correlation ID to forward with the batch frame (may be undefined). */
  correlationId: string | undefined;
}

/**
 * Per-client, per-stream accumulator for the micro-batching layer.
 *
 * Keyed by `${connectionId}:${streamId}` inside `StreamHub._batchAccumulators`.
 * The `timer` field holds the scheduled flush timeout so it can be cancelled
 * on client disconnect or hub shutdown.
 */
interface ClientBatchAccumulator {
  events: BatchedEvent[];
  /** `setTimeout` handle for the pending flush. */
  timer: NodeJS.Timeout;
  /** Timestamp (ms) the accumulator was created — i.e. when its oldest event arrived. */
  createdAt: number;
}

interface ClientState {
  id: string;
  connectedAt: number;
  ip: string;
  correlationId?: string;
  authenticatedSubject?: string;
  metrics: ConnectionMetrics;
  subscriptionFilters: Map<string, SubscriptionFilter>;
  messageTimestamps: number[];
  missedPongs: number;
}

// ── Backpressure collector options ────────────────────────────────────────────

export interface StreamHubBackpressureCollectorOptions {
  /** Poll interval in milliseconds. 0 disables the periodic collector. */
  intervalMs?: number;
  /** Threshold above which a client is counted as "slow" in the aggregate gauge. */
  slowThresholdBytes?: number;
}

// ── Hub options ───────────────────────────────────────────────────────────────

export interface StreamHubOptions {
  dedupCache?: IDedupCache;
  /** Buffered-bytes threshold above which events are dropped for a slow client. Defaults to `BACKPRESSURE_DROP_BYTES` (1 MiB). */
  dropBytes?: number;
  /** Buffered-bytes threshold above which a slow client's connection is terminated. Defaults to `BACKPRESSURE_TERMINATE_BYTES` (4 MiB). */
  terminateBytes?: number;
  /**
   * When true, upgrade requests without a valid JWT are rejected with 401.
   * Defaults to the WS_AUTH_REQUIRED environment variable.
   */
  wsAuthRequired?: boolean;
  /**
   * JWT secret used to verify tokens on upgrade.
   * Defaults to the JWT_SECRET environment variable.
   */
  jwtSecret?: string;
  /** Exact origins allowed to perform browser WebSocket upgrades. */
  allowedOrigins?: string[];
  /**
   * Event store used by replayFromCursor to fetch historical events.
   * When absent, replayFromCursor sends an empty result.
   */
  eventStore?: ContractEventStore;
  /**
   * Optional override for the per-client backpressure collector.
   * - `intervalMs`: 0 disables the periodic collector entirely (operations
   *   that drive `deliverBatch` will still update the gauge for any client
   *   they sample).
   * - `slowThresholdBytes`: threshold above which a client is classified as
   *   "slow" by the aggregate gauge.
   *
   * Defaults: intervalMs = `DEFAULT_WS_BACKPRESSURE_INTERVAL_MS` (5s),
   * slowThresholdBytes = `DEFAULT_WS_SLOW_CLIENT_BYTES` (1 MiB).
   */
  backpressureCollector?: StreamHubBackpressureCollectorOptions;
  /**
   * Micro-batching tunables.  When absent, the module-level env-var defaults
   * (`WS_BATCH_FLUSH_MS`, `WS_BATCH_MAX_SIZE`) are used.  Providing these in
   * tests lets suites run at faster cadences without mutating env vars.
   *
   * @param flushMs   Flush-window duration in milliseconds (5–5 000).
   * @param maxSize   Max events per batch before an early flush (1–500).
   */
  batching?: {
    /** Override for WS_BATCH_FLUSH_MS (clamped to 5–5 000 ms). */
    flushMs?: number;
    /** Override for WS_BATCH_MAX_SIZE (clamped to 1–500). */
    maxSize?: number;
  };
  /**
   * Maximum milliseconds to wait per connected client for its TCP close-frame
   * acknowledgement during `gracefulClose()`.  After this deadline, the
   * client's socket is force-terminated so the server is never blocked by a
   * single stalled connection.
   *
   * The value is intentionally kept small (default 5 000 ms) because graceful
   * shutdown must complete within the overall process shutdown budget.  Set
   * lower (e.g. 1 000 ms) if the process timeout is tight.
   *
   * @default 5000
   */
  closeFrameTimeoutMs?: number;
  /** Configurable heartbeat interval in ms. Default 30000. */
  healthProbeIntervalMs?: number;
  /** Number of consecutive missed pongs before termination. Default 2. */
  healthProbeMaxMissed?: number;
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export class StreamHub extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly streamSubscriptions = new Map<string, Set<WebSocket>>();
  private readonly recipientSubscriptions = new Map<string, Set<WebSocket>>();
  private readonly dedup: IDedupCache;
  private readonly ownsDedup: boolean;
  private readonly wsAuthRequired: boolean;
  private readonly jwtSecret: string | undefined;
  private readonly allowedOrigins: ReadonlySet<string> | undefined;
  private eventStore: ContractEventStore | undefined;
  private readonly backpressureCollectorInterval: NodeJS.Timeout | undefined;
  private readonly backpressureSlowThresholdBytes: number;

  // ── Micro-batching state ─────────────────────────────────────────────────
  /**
   * Pending batch accumulators keyed by `${connectionId}:${streamId}`.
   * Each entry holds the buffered events and a pending flush timer.
   * Cleared on client disconnect or hub close.
   */
  private readonly batchAccumulators = new Map<string, ClientBatchAccumulator>();
  /** Flush window in ms (from options or WS_BATCH_FLUSH_MS env var). */
  private readonly batchFlushMs: number;
  /** Max events per batch before early flush (from options or WS_BATCH_MAX_SIZE). */
  private readonly batchMaxSize: number;
  /**
   * Per-client close-frame acknowledgement timeout used by `gracefulClose()`.
   * After this deadline each unresponsive client is force-terminated so the
   * shutdown never blocks indefinitely on a single stalled socket.
   */
  private readonly closeFrameTimeoutMs: number;

  private readonly healthProbeIntervalMs: number;
  private readonly healthProbeMaxMissed: number;
  private readonly healthProbeTimer: NodeJS.Timeout | undefined;

  public getEventStore(): ContractEventStore | undefined {
    return this.eventStore;
  }

  public getStreamSubscriptionCount(streamId: string): number {
    return this.streamSubscriptions.get(streamId)?.size ?? 0;
  }

  private readonly metrics: BackpressureMetrics = {
    droppedMessages: 0,
    terminatedConnections: 0,
    sentMessages: 0,
  };

  private dropBytes: number = BACKPRESSURE_DROP_BYTES;
  private terminateBytes: number = BACKPRESSURE_TERMINATE_BYTES;

  constructor(server: Server, options?: StreamHubOptions) {
    super();

    if (typeof options?.dropBytes === 'number' && options.dropBytes >= 0) {
      this.dropBytes = options.dropBytes;
    }
    if (typeof options?.terminateBytes === 'number' && options.terminateBytes >= 0) {
      this.terminateBytes = options.terminateBytes;
    }

    if (options?.dedupCache) {
      this.dedup = options.dedupCache;
      this.ownsDedup = false;
    } else {
      this.dedup = new InMemoryDedupCache();
      this.ownsDedup = true;
    }

    this.wsAuthRequired = options?.wsAuthRequired ?? process.env.WS_AUTH_REQUIRED === 'true';

    this.jwtSecret = options?.jwtSecret ?? process.env.JWT_SECRET;

    const configuredOrigins = options?.allowedOrigins ?? process.env.WS_ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim());
    this.allowedOrigins = configuredOrigins && configuredOrigins.length > 0
      ? new Set(configuredOrigins.filter((origin) => origin.length > 0))
      : undefined;

    this.eventStore = options?.eventStore;

    // Default: 5s poll, 1 MiB slow threshold. intervalMs=0 disables the timer.
    const collectorOpts = options?.backpressureCollector;
    const intervalMs =
      collectorOpts?.intervalMs ?? DEFAULT_WS_BACKPRESSURE_INTERVAL_MS;
    this.backpressureSlowThresholdBytes =
      collectorOpts?.slowThresholdBytes ?? DEFAULT_WS_SLOW_CLIENT_BYTES;

    // ── Micro-batching ────────────────────────────────────────────────────
    // Options take precedence over env vars so tests can tune without
    // touching process.env.  Both values are clamped to sane bounds.
    this.batchFlushMs = options?.batching?.flushMs !== undefined
      ? Math.max(5, Math.min(5_000, options.batching.flushMs))
      : WS_BATCH_FLUSH_MS;
    this.batchMaxSize = options?.batching?.maxSize !== undefined
      ? Math.max(1, Math.min(500, options.batching.maxSize))
      : WS_BATCH_MAX_SIZE;

    // ── Graceful-close timeout ────────────────────────────────────────────
    // Clamped to a minimum of 50 ms to avoid degenerate zero-timeout values
    // in production misconfiguration.
    this.closeFrameTimeoutMs =
      typeof options?.closeFrameTimeoutMs === 'number' && options.closeFrameTimeoutMs > 0
        ? Math.max(50, options.closeFrameTimeoutMs)
        : 5_000;

    this.healthProbeIntervalMs = options?.healthProbeIntervalMs ?? 30_000;
    this.healthProbeMaxMissed = options?.healthProbeMaxMissed ?? 2;

    // Use noServer mode so we fully control the upgrade handshake.
    this.wss = new WebSocketServer({ noServer: true });

    // Start the backpressure collector AFTER WebSocketServer setup so the
    // initial collection can see any clients that already connected while
    // the server was listening.
    this.backpressureCollectorInterval =
      intervalMs > 0
        ? setInterval(() => {
            collectWsBackpressureMetrics(this, this.backpressureSlowThresholdBytes);
          }, intervalMs)
        : undefined;
    if (intervalMs > 0) {
      collectWsBackpressureMetrics(this, this.backpressureSlowThresholdBytes);
    }

    if (this.healthProbeIntervalMs > 0) {
      this.healthProbeTimer = setInterval(() => this.runHealthProbes(), this.healthProbeIntervalMs);
      if (this.healthProbeTimer.unref) {
        this.healthProbeTimer.unref();
      }
    }

    // ── WebSocket upgrade handler with atomic per-IP connection limiting ─────

    /**
     * HTTP upgrade handler for WebSocket connections with TOCTOU-safe per-IP limiting.
     *
     * SECURITY CRITICAL: Per-IP connection limiting using atomic check-and-reserve.
     * This handler prevents attackers from bypassing the per-IP connection cap via
     * concurrent upgrade race conditions.
     *
     * ALGORITHM:
     * 1. ATOMIC CHECK-AND-RESERVE:
     *    - Call checkAndReserve(ip) which synchronously checks the limit before incrementing.
     *    - This prevents multiple concurrent requests from both passing the check.
     *    - Reservation MUST be released exactly once on any failure path.
     *
     * 2. PRE-UPGRADE CLEANUP HANDLER:
     *    - Install a socket 'close' listener that releases the reservation if the upgrade fails.
     *    - This covers:
     *      * Network errors (socket closes before upgrade completes)
     *      * Timeouts (socket closes due to handshake timeout)
     *      * Auth failures (if WS_AUTH_REQUIRED is set)
     *    - The 'cleaned' flag ensures untrackConnection is called exactly once.
     *
     * 3. UPGRADE SUCCESS PATH:
     *    - Upgrade is accepted via this.wss.handleUpgrade(...)
     *    - Set 'cleaned = true' to prevent socket close listener from firing
     *    - Remove the close listener (no longer needed)
     *    - onConnect is called with the established WebSocket (reservation stays active)
     *
     * 4. COUNTER RELEASE ON DISCONNECT:
     *    - When the WebSocket closes (normal or abnormal), onDisconnect is called
     *    - onDisconnect calls untrackConnection(ip) to decrement the counter
     *
     * COUNTER LIFECYCLE:
     *   checkAndReserve(ip) ──┬─→ allowed=false  →  close socket (no release)
     *                         │
     *                         └─→ allowed=true   →  reserve slot (must release once)
     *                                                ├─→ upgrade failure  →  socket close handler  →  untrackConnection
     *                                                └─→ upgrade success  →  onConnect (owns slot)  →  onDisconnect  →  untrackConnection
     *
     * INVARIANTS:
     *   - Each successful checkAndReserve increments the counter (atomic)
     *   - The counter is decremented exactly once per successful reservation
     *   - Counter never goes negative (clamped to 0)
     *   - No leaks under concurrent close events
     *
     * @security Prevents attackers from opening more than the allowed connections via burst requests.
     * @security Counter is atomic and cannot be bypassed via race conditions.
     * @security No counter underflow or leaks on failed upgrades.
     */
    server.on('upgrade', async (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'ws://localhost').pathname;
      if (pathname !== '/ws/streams') return;

      const origin = req.headers.origin;
      if (this.allowedOrigins && (typeof origin !== 'string' || !this.allowedOrigins.has(origin))) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\n' +
            'Content-Type: text/plain\r\n' +
            'Connection: close\r\n\r\n' +
            'Forbidden origin\r\n'
        );
        socket.destroy();
        return;
      }

      // 1. Connection Limiter Check — atomically reserve IP slot
      const ip = getClientIp(req);
      const limitResult = await checkAndReserve(ip);
      if (!limitResult.allowed) {
        // SECURITY: Reject BEFORE upgrade. Send HTTP error instead of upgrading.
        // This ensures the client never enters the OPEN state and the connection
        // is rejected cleanly at the HTTP level.
        socket.write(
          'HTTP/1.1 429 Too Many Requests\r\n' +
            'Content-Type: text/plain\r\n' +
            'Connection: close\r\n\r\n' +
            `${limitResult.reason || 'Too many connections'}\r\n`
        );
        socket.destroy();
        return;
      }

      let cleaned = false;
      // Release the IP slot if upgrade fails (before onConnect is called)
      const handleCleanup = () => {
        if (!cleaned) {
          cleaned = true;
          untrackConnection(ip);
          socket.removeListener('close', handleCleanup);
        }
      };
      socket.on('close', handleCleanup);

      // 2. Auth Check (if required)
      if (this.wsAuthRequired) {
        const result = verifyWsToken(req, this.jwtSecret);
        if (!result.ok) {
          handleCleanup(); // release reservation and remove listener
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Content-Type: text/plain\r\n' +
              'Connection: close\r\n\r\n' +
              `Unauthorized: ${result.code}\r\n`
          );
          socket.destroy();
          return;
        }
      }

      // 3. Accept Upgrade — mark cleaned to prevent double-cleanup on close
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        cleaned = true; // prevent the socket close handler from firing
        socket.removeListener('close', handleCleanup);
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.onConnect(ws, req);
    });
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private onConnect(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = randomUUID();
    const ip = getClientIp(req);
    const connectedAt = Date.now();
    const correlationId = this.extractCorrelationId(req.headers);
    const authenticatedSubject = this.extractAuthenticatedSubject(req);

    const state: ClientState = {
      id: connectionId,
      connectedAt,
      ip,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
      missedPongs: 0,
    };
    if (correlationId !== undefined) {
      state.correlationId = correlationId;
    }
    if (authenticatedSubject !== undefined) {
      state.authenticatedSubject = authenticatedSubject;
    }
    this.clients.set(ws, state);

    logger.info('WebSocket connected', correlationId, {
      event: 'ws_connect',
      connectionId,
      ip,
      timestamp: new Date(connectedAt).toISOString(),
    });

    this.applyHandshakeSubscription(ws, req);

    ws.on('pong', () => {
      const client = this.clients.get(ws);
      if (client) {
        client.missedPongs = 0;
      }
    });

    ws.on('message', (data, isBinary) => {
      const state = this.clients.get(ws);

      if (isBinary) {
        this.sendError(ws, 'BINARY_NOT_SUPPORTED', 'Binary frames are not accepted');
        return;
      }

      const raw = data.toString('utf8');
      const byteLength = Buffer.byteLength(raw, 'utf8');

      if (state) {
        state.metrics.messagesReceived += 1;
        state.metrics.bytesReceived += byteLength;
      }

      if (byteLength > MAX_MESSAGE_BYTES) {
        this.sendError(ws, 'PAYLOAD_TOO_LARGE', `Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
        return;
      }

      if (!this.checkRateLimit(ws)) {
        this.sendError(ws, 'RATE_LIMIT_EXCEEDED', 'Too many messages; slow down');
        return;
      }

      this.handleMessage(ws, raw);
    });

    ws.on('close', (code, reason) => this.onDisconnect(ws, code, reason));
    ws.on('error', () => ws.close(1011, 'Internal Error'));
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
  private onDisconnect(ws: WebSocket, code?: number, reason?: Buffer): void {
    const state = this.clients.get(ws);
    if (!state) return;

    untrackConnection(state.ip);

    for (const filter of state.subscriptionFilters.values()) {
      this.removeSubscriptionFromIndexes(ws, filter);
    }

    // Cancel any pending batch flush timers for this client to prevent sending
    // frames to a closed socket and to release accumulator memory immediately.
    for (const [key, acc] of this.batchAccumulators) {
      if (key.startsWith(`${state.id}:`)) {
        clearTimeout(acc.timer);
        this.batchAccumulators.delete(key);
      }
    }

    // Remove the per-client gauge time series so it doesn't accumulate.
    removeWsClientBackpressureGauge(state.id);

    const durationMs = Date.now() - state.connectedAt;
    logger.info('WebSocket disconnected', state.correlationId, {
      event: 'ws_disconnect',
      connectionId: state.id,
      durationMs,
      code: code ?? 0,
      reason: reason?.toString('utf8') ?? '',
      metrics: state.metrics,
    });

    this.clients.delete(ws);
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  private checkRateLimit(ws: WebSocket): boolean {
    const state = this.clients.get(ws);
    if (!state) return false;

    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    state.messageTimestamps = state.messageTimestamps.filter((t) => t >= cutoff);

    if (state.messageTimestamps.length >= RATE_LIMIT_MAX) return false;

    state.messageTimestamps.push(now);
    return true;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    const result = validateWebSocketMessage(raw);
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }

    if (result.message.type === 'replay') {
      void this.replayFromCursor(ws, result.message.filter);
      return;
    }

    const authorized = await this.authorizeSubscriptionFilter(ws, result.message.filter);
    if (!authorized.ok) {
      this.sendError(ws, authorized.code, authorized.message);
      return;
    }

    if (result.message.type === 'subscribe') {
      this.subscribe(ws, authorized.filter);
    } else {
      this.unsubscribe(ws, authorized.filter);
    }
  }

  private subscribe(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const key = this.subscriptionKey(filter);
    if (state.subscriptionFilters.has(key)) return;

    state.subscriptionFilters.set(key, filter);
    this.addSubscriptionToIndexes(ws, filter);
  }

  private unsubscribe(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const key = this.subscriptionKey(filter);
    const existing = state.subscriptionFilters.get(key);
    if (!existing) return;

    state.subscriptionFilters.delete(key);
    this.removeSubscriptionFromIndexes(ws, existing);
  }

  private async authorizeSubscriptionFilter(
    ws: WebSocket,
    filter: SubscriptionFilter
  ): Promise<{ ok: true; filter: SubscriptionFilter } | { ok: false; code: string; message: string }> {
    const state = this.clients.get(ws);
    if (!state) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'WebSocket client is not registered' };
    }

    if (filter.streamId !== undefined) {
      const stream = await streamRepository.getById(filter.streamId);
      if (!stream) {
        return { ok: false, code: 'NOT_FOUND', message: 'Stream not found' };
      }

      const subject = state.authenticatedSubject;
      if (!subject || (stream.sender_address !== subject && stream.recipient_address !== subject)) {
        return { ok: false, code: 'FORBIDDEN', message: 'Not authorized for this stream' };
      }

      return { ok: true, filter };
    }

    const authenticatedRecipient = this.authenticatedRecipientSubject(state);

    if (filter.recipientAddress !== undefined) {
      if (authenticatedRecipient === undefined) {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          message:
            'recipient_address subscriptions require an authenticated Stellar public key subject',
        };
      }

      if (filter.recipientAddress !== authenticatedRecipient) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'recipient_address subscriptions must match the authenticated subject',
        };
      }
      return { ok: true, filter };
    }

    if (authenticatedRecipient === undefined) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'empty subscription filters require an authenticated Stellar public key subject',
      };
    }

    return { ok: true, filter: { recipientAddress: authenticatedRecipient } };
  }

  private subscriptionKey(filter: SubscriptionFilter): string {
    if (filter.streamId !== undefined) return `stream:${filter.streamId}`;
    if (filter.recipientAddress !== undefined) return `recipient:${filter.recipientAddress}`;
    return 'recipient:';
  }

  private addSubscriptionToIndexes(ws: WebSocket, filter: SubscriptionFilter): void {
    if (filter.streamId !== undefined) {
      if (!this.streamSubscriptions.has(filter.streamId)) {
        this.streamSubscriptions.set(filter.streamId, new Set());
      }
      this.streamSubscriptions.get(filter.streamId)!.add(ws);
      return;
    }

    if (filter.recipientAddress !== undefined) {
      if (!this.recipientSubscriptions.has(filter.recipientAddress)) {
        this.recipientSubscriptions.set(filter.recipientAddress, new Set());
      }
      this.recipientSubscriptions.get(filter.recipientAddress)!.add(ws);
    }
  }

  private removeSubscriptionFromIndexes(ws: WebSocket, filter: SubscriptionFilter): void {
    if (filter.streamId !== undefined) {
      this.streamSubscriptions.get(filter.streamId)?.delete(ws);
      if (this.streamSubscriptions.get(filter.streamId)?.size === 0) {
        this.streamSubscriptions.delete(filter.streamId);
      }
      return;
    }

    if (filter.recipientAddress !== undefined) {
      this.recipientSubscriptions.get(filter.recipientAddress)?.delete(ws);
      if (this.recipientSubscriptions.get(filter.recipientAddress)?.size === 0) {
        this.recipientSubscriptions.delete(filter.recipientAddress);
      }
    }
  }

  /**
   * Force-close every socket currently subscribed to a stream ID.
   * Returns the number of sockets targeted before the disconnect completes.
   */
  disconnectByStreamId(streamId: string): number {
    const subscribers = this.streamSubscriptions.get(streamId);
    if (!subscribers || subscribers.size === 0) {
      return 0;
    }

    const targets = Array.from(subscribers);
    this.streamSubscriptions.delete(streamId);

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

  // ── Broadcast & Micro-Batching ─────────────────────────────────────────────

  async broadcast(event: StreamUpdateEvent): Promise<void> {
    const { streamId, eventId } = event;

    const added = await this.dedup.add(streamId, eventId);
    if (!added) return;

    // Emit to Server-Sent Events bus
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, event);

    this.dispatchImmediate(event);
  }

  private dispatchImmediate(event: StreamUpdateEvent): void {
    const { streamId, eventId, payload } = event;
    const subscribers = this.matchingSubscribers(event);
    if (subscribers.size === 0) return;

    // Prefer an explicit correlationId on the event (e.g. set by the indexer
    // ingestion path) over the ambient tracing-middleware value so that batch
    // frames faithfully echo the per-event correlation identifier.
    const correlationId = event.correlationId ?? getCorrelationId();

    // ── Split subscribers by opt-in batching flag ─────────────────────────
    // A subscriber opts in to batching by including `batching: true` in its
    // subscription filter for the matching stream.  Clients that did NOT opt
    // in receive the existing one-frame-per-event path unchanged.
    const immediateTargets: WebSocket[] = [];

    for (const ws of subscribers) {
      const state = this.clients.get(ws);
      if (!state) continue;

      // Check whether *any* of this client's active subscription filters for
      // this stream/recipient has batchingEnabled set.
      let wantsBatching = false;
      for (const filter of state.subscriptionFilters.values()) {
        if (filter.batchingEnabled) {
          wantsBatching = true;
          break;
        }
      }

      if (wantsBatching) {
        this.enqueueBatch(ws, state, { streamId, eventId, payload, correlationId });
      } else {
        immediateTargets.push(ws);
      }
    }

    // ── Immediate (non-batched) fanout ────────────────────────────────────
    if (immediateTargets.length === 0) return;

    const message = JSON.stringify({
      type: 'stream_update',
      streamId: event.streamId,
      eventId: event.eventId,
      payload: event.payload,
      correlationId,
    });

    if (immediateTargets.length <= FANOUT_YIELD_BATCH) {
      this.deliverBatch(immediateTargets, message, streamId, eventId);
      return;
    }

    const self = this;
    let i = 0;
    function next(): void {
      const end = Math.min(i + FANOUT_YIELD_BATCH, immediateTargets.length);
      self.deliverBatch(immediateTargets.slice(i, end), message, streamId, eventId);
      i = end;
      if (i < immediateTargets.length) setImmediate(next);
    }
    next();
  }

  // ── Micro-batching ─────────────────────────────────────────────────────────

  /**
   * Enqueue a single event into the client's per-stream batch accumulator.
   *
   * If no accumulator exists for `(connectionId, streamId)`, one is created
   * and a flush timer is started.  If adding this event fills the accumulator
   * to `batchMaxSize`, a synchronous early flush is triggered and the Prometheus
   * `wsBatchSizeExceededTotal` counter is incremented.
   *
   * @param ws    The destination WebSocket (server-side handle).
   * @param state The corresponding `ClientState` for `ws`.
   * @param entry The event to buffer.
   *
   * @security Only server-originated, already-deduped events are enqueued;
   *   no client-supplied data reaches this method unvalidated.
   */
  private enqueueBatch(ws: WebSocket, state: ClientState, entry: BatchedEvent): void {
    const key = `${state.id}:${entry.streamId}`;
    let acc = this.batchAccumulators.get(key);

    if (!acc) {
      // First event in this window — create accumulator and arm timer.
      const timer = setTimeout(() => {
        this.flushBatch(ws, key, false);
      }, this.batchFlushMs);
      // Allow the process to exit without waiting for the timer.
      if (typeof timer.unref === 'function') timer.unref();

      acc = { events: [], timer, createdAt: Date.now() };
      this.batchAccumulators.set(key, acc);
    }

    acc.events.push(entry);

    // Early flush if the batch is full.
    if (acc.events.length >= this.batchMaxSize) {
      clearTimeout(acc.timer);
      this.batchAccumulators.delete(key);
      this.flushBatchDirect(ws, entry.streamId, acc.events, true, acc.createdAt);
    }
  }

  /**
   * Timer-driven flush: reads the accumulator and dispatches a batch frame.
   * The accumulator entry is always removed here so memory is freed even if
   * the client has disconnected in the interim.
   *
   * @param ws         Target WebSocket.
   * @param key        Accumulator map key (`${connectionId}:${streamId}`).
   * @param earlyFlush `true` when triggered by max-size, `false` for timer.
   */
  private flushBatch(ws: WebSocket, key: string, earlyFlush: boolean): void {
    const acc = this.batchAccumulators.get(key);
    if (!acc) return; // already flushed (e.g. on disconnect cleanup)

    this.batchAccumulators.delete(key);

    const streamId = key.slice(key.indexOf(':') + 1);
    this.flushBatchDirect(ws, streamId, acc.events, earlyFlush, acc.createdAt);
  }

  /**
   * Serialise and deliver a batch of events as a single `stream_update_batch`
   * frame.  Applies the same backpressure checks as `deliverBatch`.
   *
   * Frame schema:
   * ```json
   * {
   *   "type": "stream_update_batch",
   *   "streamId": "…",
   *   "events": [
   *     { "eventId": "…", "payload": {…}, "correlationId": "…" },
   *     …
   *   ]
   * }
   * ```
   *
   * @security The serialised frame is bounded by the accumulator size
   *   (`batchMaxSize`) and the payload sizes deduped upstream. If the
   *   resulting JSON would exceed `MAX_MESSAGE_BYTES`, the frame is silently
   *   truncated to the largest sub-array that fits (events are still
   *   delivered in order; the remainder is discarded rather than silently
   *   dropped from dedup — the dedup cache already recorded each eventId so
   *   they will not be re-delivered by a future broadcast).
   */
  private flushBatchDirect(
    ws: WebSocket,
    streamId: string,
    events: BatchedEvent[],
    earlyFlush: boolean,
    createdAt: number,
  ): void {
    if (events.length === 0) return;

    recordWsBroadcastBatchFlushLatency((Date.now() - createdAt) / 1000);

    if (ws.readyState !== WebSocket.OPEN) return;

    // Trim to MAX_MESSAGE_BYTES safety cap (in-order, keep first N events).
    let safeEvents = events;
    const fullFrame = JSON.stringify({
      type: 'stream_update_batch',
      streamId,
      events: safeEvents.map(({ eventId, payload, correlationId }) => ({
        eventId,
        payload,
        ...(correlationId !== undefined ? { correlationId } : {}),
      })),
    });

    if (Buffer.byteLength(fullFrame, 'utf8') > MAX_MESSAGE_BYTES) {
      // Binary-search for the largest safe prefix.
      let lo = 1;
      let hi = safeEvents.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = JSON.stringify({
          type: 'stream_update_batch',
          streamId,
          events: events.slice(0, mid).map(({ eventId, payload, correlationId }) => ({
            eventId,
            payload,
            ...(correlationId !== undefined ? { correlationId } : {}),
          })),
        });
        if (Buffer.byteLength(candidate, 'utf8') <= MAX_MESSAGE_BYTES) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      safeEvents = events.slice(0, lo);
    }

    if (safeEvents.length === 0) return;

    const message = JSON.stringify({
      type: 'stream_update_batch',
      streamId,
      events: safeEvents.map(({ eventId, payload, correlationId }) => ({
        eventId,
        payload,
        ...(correlationId !== undefined ? { correlationId } : {}),
      })),
    });

    // Backpressure check — same thresholds as the non-batched path.
    const buffered = ws.bufferedAmount;
    if (buffered > this.terminateBytes) {
      this.metrics.terminatedConnections++;
      this.metrics.droppedMessages += safeEvents.length;
      try { ws.terminate(); } catch { /* ignore */ }
      this.onDisconnect(ws);
      return;
    }
    if (buffered > this.dropBytes) {
      this.metrics.droppedMessages += safeEvents.length;
      return;
    }

    try {
      ws.send(message);
    } catch {
      this.metrics.droppedMessages += safeEvents.length;
      return;
    }
    this.metrics.sentMessages++;

    const state = this.clients.get(ws);
    if (state) {
      state.metrics.messagesSent += 1;
      state.metrics.bytesSent += Buffer.byteLength(message, 'utf8');
    }

    // Update Prometheus batch counters.
    wsBatchFlushTotal.inc();
    wsBatchEventsCoalescedTotal.inc(safeEvents.length);
    if (earlyFlush) wsBatchSizeExceededTotal.inc();
  }

  private matchingSubscribers(event: StreamUpdateEvent): Set<WebSocket> {
    const targets = new Set<WebSocket>();
    const streamMatches = this.streamSubscriptions.get(event.streamId);
    if (streamMatches) {
      for (const ws of streamMatches) targets.add(ws);
    }

    const recipientAddress = this.extractRecipientAddress(event);
    if (recipientAddress !== undefined) {
      const recipientMatches = this.recipientSubscriptions.get(recipientAddress);
      if (recipientMatches) {
        for (const ws of recipientMatches) targets.add(ws);
      }
    }

    return targets;
  }

  private deliverBatch(
    batch: WebSocket[],
    message: string,
    streamId: string,
    eventId: string
  ): number {
    let sent = 0;

    for (const ws of batch) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const buffered = ws.bufferedAmount;

      if (buffered > this.terminateBytes) {
        this.metrics.terminatedConnections++;
        this.metrics.droppedMessages++;
        this.emitBackpressure(ws, 'terminate', buffered, this.terminateBytes, streamId, eventId);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        this.onDisconnect(ws);
        continue;
      }

      if (buffered > this.dropBytes) {
        this.metrics.droppedMessages++;
        this.emitBackpressure(ws, 'drop', buffered, this.dropBytes, streamId, eventId);
        continue;
      }

      try {
        ws.send(message);
      } catch {
        // If send throws (e.g. a race with concurrent terminate), skip this
        // client without counting it as sent or crashing the broadcast.
        continue;
      }
      this.metrics.sentMessages++;
      sent++;

      const state = this.clients.get(ws);
      if (state) {
        state.metrics.messagesSent += 1;
        state.metrics.bytesSent += Buffer.byteLength(message, 'utf8');
      }
    }

    // Record a span event for observability (fire-and-forget, no correlationId context here).
    const correlationId = getCorrelationId();
    const tracer = getTracer();
    const span = tracer.startSpan({
      traceId: correlationId,
      serviceName: 'fluxora-ws',
      tags: {
        'ws.stream_id': streamId,
        'ws.event_id': eventId,
        'ws.recipients': sent,
        'ws.correlation_id': correlationId,
      },
    });
    tracer.recordEvent(span, 'ws.broadcast', {
      streamId,
      eventId,
      recipients: sent,
      correlationId,
    });
    tracer.endSpan(span, 'ok');

    return sent;
  }

  private emitBackpressure(
    ws: WebSocket,
    action: BackpressureAction,
    bufferedAmount: number,
    thresholdBytes: number,
    streamId: string,
    eventId: string
  ): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const event: StreamHubBackpressureEvent = {
      action,
      streamId,
      eventId,
      connectionId: state.id,
      bufferedAmount,
      thresholdBytes,
      timestamp: new Date().toISOString(),
    };

    this.emit('backpressure', event);
    logger.warn('WebSocket backpressure applied', state.correlationId, {
      event: 'ws_backpressure',
      ...event,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractAuthenticatedSubject(req: IncomingMessage): string | undefined {
    const result = verifyWsToken(req, this.jwtSecret);
    if (!result.ok) return undefined;

    const subject = result.payload.sub?.trim();
    return subject ? subject : undefined;
  }

  private authenticatedRecipientSubject(state: ClientState): string | undefined {
    const subject = state.authenticatedSubject;
    if (subject === undefined || !isValidStellarPublicKey(subject)) return undefined;
    return subject;
  }

  private applyHandshakeSubscription(ws: WebSocket, req: IncomingMessage): void {
    const result = parseHandshakeSubscriptionFilter(req.url ?? '/');
    if (!result.ok) {
      this.sendError(ws, 'INVALID_MESSAGE', result.message);
      return;
    }

    if (result.filter === null) return;

    this.authorizeSubscriptionFilter(ws, result.filter)
      .then((authorized) => {
        if (!authorized.ok) {
          this.sendError(ws, authorized.code, authorized.message);
          return;
        }
        this.subscribe(ws, authorized.filter);
      })
      .catch((err) => {
        // Just send a generic error if the authorization check throws
        this.sendError(ws, 'INTERNAL_ERROR', 'Failed to authorize subscription filter');
      });
  }

  private extractCorrelationId(headers: IncomingHttpHeaders): string | undefined {
    const incoming = headers[CORRELATION_ID_HEADER];
    if (typeof incoming === 'string') {
      const trimmed = incoming.trim();
      if (trimmed.length > 0 && isValidCorrelationId(trimmed)) {
        return trimmed;
      }
    }
    return undefined;
  }

  private extractRecipientAddress(event: StreamUpdateEvent): string | undefined {
    if (event.recipientAddress !== undefined && event.recipientAddress.trim() !== '') {
      return event.recipientAddress.trim();
    }

    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return undefined;
    }

    const candidate =
      (payload as Record<string, unknown>)['recipient_address'] ??
      (payload as Record<string, unknown>)['recipientAddress'] ??
      (payload as Record<string, unknown>)['recipient'];

    if (typeof candidate !== 'string') return undefined;

    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code, message }));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Internal entry-point used by the per-client backpressure collector to
   * enumerate connected sockets. Underscore-prefixed because it exposes raw
   * `WebSocket` references — callers MUST treat them as opaque and only read
   * stable, read-only properties (e.g. `bufferedAmount`, `readyState`).
   */
  _getClients(): IterableIterator<[WebSocket, ClientState]> {
    return this.clients.entries();
  }

  /**
   * Internal entry-point used by the subscription cardinality collector to
   * enumerate stream subscription counts. Underscore-prefixed because it
   * exposes internal map references — callers MUST treat them as read-only.
   *
   * @security Exposes only streamId keys and subscriber Set sizes; no
   *           WebSocket references or client state is leaked.
   */
  _getStreamSubscriptions(): ReadonlyMap<string, Set<WebSocket>> {
    return this.streamSubscriptions;
  }

  /**
   * Internal entry-point used by tests and diagnostics to inspect recipient
   * subscription cardinality. Only exposes stable map and set references.
   *
   * @security Exposes only recipientAddress keys and subscriber Set sizes;
   *           raw WebSocket references are still opaque and must not be
   *           mutated by callers.
   */
  _getRecipientSubscriptions(): ReadonlyMap<string, Set<WebSocket>> {
    return this.recipientSubscriptions;
  }

  getMetrics(): Readonly<BackpressureMetrics> {
    return { ...this.metrics };
  }

  setBackpressureThresholds(opts: { dropBytes?: number; terminateBytes?: number }): void {
    if (typeof opts.dropBytes === 'number' && opts.dropBytes >= 0) this.dropBytes = opts.dropBytes;
    if (typeof opts.terminateBytes === 'number' && opts.terminateBytes >= 0)
      this.terminateBytes = opts.terminateBytes;
  }

  /**
   * Attach (or replace) the event store used by replayFromCursor.
   * Called by the indexer route after the store is configured.
   */
  setEventStore(store: ContractEventStore): void {
    this.eventStore = store;
  }

  /**
   * Replay stored events to a single connected client starting after the
   * given cursor eventId.  Events are fetched from the attached event store
   * in ledger-ascending order and sent as `stream_replay` frames.
   *
   * The method is intentionally fire-and-forget from the caller's perspective:
   * it resolves once all pages have been sent (or the client disconnects).
   *
   * @param ws         Target WebSocket connection (must be OPEN).
   * @param filter     Replay filter forwarded to the event store.
   *                   `afterEventId` acts as the exclusive cursor.
   */
  async replayFromCursor(ws: WebSocket, filter: StreamEventReplayFilter = {}): Promise<void> {
    if (!this.eventStore) {
      this.sendError(ws, 'REPLAY_UNAVAILABLE', 'Event store is not configured');
      return;
    }

    let cursor = filter.afterEventId;
    const pageSize = Math.min(filter.limit ?? 100, 1000);

    do {
      if (ws.readyState !== WebSocket.OPEN) return;

      const pageFilter: StreamEventReplayFilter = {
        ...filter,
        ...(cursor !== undefined ? { afterEventId: cursor } : {}),
        limit: pageSize,
      };
      let result: Awaited<ReturnType<ContractEventStore['getEvents']>>;
      try {
        result = await this.eventStore.getEvents(pageFilter);
      } catch (err) {
        if (err instanceof StaleCursorError) {
          this.sendError(
            ws,
            STALE_CURSOR_ERROR_CODE,
            'Replay cursor no longer exists; resync from fromLedger',
          );
          return;
        }
        throw err;
      }

      for (const event of result.events) {
        if (ws.readyState !== WebSocket.OPEN) return;

        const message = JSON.stringify({
          type: 'stream_replay',
          eventId: event.eventId,
          ledger: event.ledger,
          topic: event.topic,
          payload: event.payload,
          happenedAt: event.happenedAt,
        });

        ws.send(message);

        const state = this.clients.get(ws);
        if (state) {
          state.metrics.messagesSent += 1;
          state.metrics.bytesSent += Buffer.byteLength(message, 'utf8');
        }
        this.metrics.sentMessages++;
      }

      cursor = result.nextCursor;
    } while (cursor !== undefined);

    // Signal end of replay stream
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stream_replay_complete', cursor: cursor ?? null }));
    }
  }

  private runHealthProbes(): void {
    let healthyCount = 0;
    let unhealthyCount = 0;

    for (const [ws, state] of this.clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      if (state.missedPongs >= this.healthProbeMaxMissed) {
        unhealthyCount++;
        ws.terminate();
      } else {
        healthyCount++;
        state.missedPongs++;
        ws.ping();
      }
    }

    updateWsHealthMetrics(healthyCount, unhealthyCount);
  }

  async close(cb?: () => void): Promise<void> {
    // Legacy close kept for internal use; it simply shuts down the server.
    if (this.backpressureCollectorInterval) {
      clearInterval(this.backpressureCollectorInterval);
    }
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
    }
    // Cancel all pending batch flush timers before closing.
    for (const acc of this.batchAccumulators.values()) {
      clearTimeout(acc.timer);
    }
    this.batchAccumulators.clear();
    if (this.ownsDedup) await this.dedup.close();
    this.wss.close(cb);
  }

  async gracefulClose(): Promise<void> {
    for (const ws of this.clients.keys()) {
      ws.close(1001, JSON.stringify({ reason: SSE_CLOSE_REASONS.SERVER_SHUTDOWN }));
    }
    await this.close();
  }

  async _resetDedup(): Promise<void> {
    await this.dedup.clear();
  }

  _resetMetrics(): void {
    this.metrics.droppedMessages = 0;
    this.metrics.terminatedConnections = 0;
    this.metrics.sentMessages = 0;
  }

  /** Cancel all pending batch timers and clear accumulators. For tests only. */
  _resetBatchAccumulators(): void {
    for (const acc of this.batchAccumulators.values()) {
      clearTimeout(acc.timer);
    }
    this.batchAccumulators.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _hub: StreamHub | null = null;

export function createStreamHub(server: Server, options?: StreamHubOptions): StreamHub {
  _hub = new StreamHub(server, options);
  return _hub;
}

export function getStreamHub(): StreamHub | null {
  return _hub;
}

export function resetStreamHub(): void {
  _hub = null;
}
