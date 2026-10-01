import { getRuntimeEnv } from '../config/runtime-env.js';
/**
 * WebSocket Hub — stream update broadcast channel.
 *
 * The hub owns the server wiring and the broadcast lifecycle; every concern it
 * used to inline now lives in a focused module (`hubConfig`, `hubTypes`,
 * `upgradeHandler`, `connectionLifecycle`, `connectionRegistry`,
 * `subscriptionRouter`, `fanout`, `backpressure`, `batching`, `replay`,
 * `healthProbe`, `messageHandler`).
 *
 * Responsibilities: accept upgrades on `/ws/streams`, rate-limit inbound
 * frames per connection, deduplicate outbound events by `(streamId, eventId)`,
 * broadcast stream updates with backpressure for slow clients, and replay
 * stored events from a cursor.
 *
 * ## WebSocket JWT Auth (optional, backward-compatible)
 *
 * `WS_AUTH_REQUIRED=true` rejects upgrades without a valid HS256 token signed
 * with `JWT_SECRET` (HTTP 401 before the handshake completes). When the flag is
 * absent or false every connection is accepted, so auth can be rolled out with
 * zero downtime. Tokens are read from `Authorization: Bearer <token>`, falling
 * back to `?token=<jwt>`.
 *
 * @module ws/hub
 */

import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { DedupCache as IDedupCache } from '../redis/dedup.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import { SSE_CLOSE_REASONS } from '../streams/sseEmitter.js';
import type { ContractEventStore } from '../indexer/store.js';
import type { StreamEventReplayFilter } from '../db/types.js';
import { validateWebSocketMessage } from './messageHandler.js';
import {
  collectWsBackpressureMetrics,
  DEFAULT_WS_BACKPRESSURE_INTERVAL_MS,
  DEFAULT_WS_SLOW_CLIENT_BYTES,
  setWsResourceLimitMetrics,
  wsSubscriptionLimitViolationsTotal,
} from '../metrics/wsBackpressure.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { SubscriptionRouter } from './subscriptionRouter.js';
import { OutboundBackpressure, reportBackpressure } from './backpressure.js';
import { BatchAccumulator } from './batching.js';
import { attachUpgradeHandler } from './upgradeHandler.js';
import {
  disconnectStreamSubscribers,
  onConnect,
  onDisconnect,
  type ConnectionLifecycleDeps,
} from './connectionLifecycle.js';
import { broadcastEvent, recordBroadcastSpan } from './fanout.js';
import { replayFromCursor, type ReplayDeps } from './replay.js';
import { runHealthProbes } from './healthProbe.js';
import { WS_CLOSE_CODE_GOING_AWAY, resolveHubConfig } from './hubConfig.js';
import type {
  BackpressureMetrics,
  ClientState,
  StreamHubBackpressureCollectorOptions,
  StreamHubOptions,
  StreamUpdateEvent,
} from './hubTypes.js';

// The hub's public surface (constants and types) is defined by the modules it
// composes; re-exporting it here keeps every existing import site working.
export {
  BACKPRESSURE_DROP_BYTES,
  BACKPRESSURE_TERMINATE_BYTES,
  DEFAULT_WS_MAX_OUTBOUND_QUEUE_BYTES_PER_CONNECTION,
  DEFAULT_WS_MAX_OUTBOUND_QUEUE_PER_CONNECTION,
  DEFAULT_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  FANOUT_YIELD_BATCH,
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  WS_BATCH_FLUSH_MS,
  WS_BATCH_MAX_SIZE,
  WS_CLOSE_CODE_GOING_AWAY,
  WS_CLOSE_REASONS,
} from './hubConfig.js';
export type { WsCloseReason } from './hubConfig.js';
export type {
  BackpressureAction,
  BackpressureMetrics,
  BatchedEvent,
  ClientBatchAccumulator,
  ClientState,
  ConnectionMetrics,
  StreamHubBackpressureCollectorOptions,
  StreamHubBackpressureEvent,
  StreamHubOptions,
  StreamUpdateEvent,
} from './hubTypes.js';

export const MAX_MESSAGE_BYTES = 4_096;
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const DEFAULT_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;
export const DEFAULT_WS_MAX_OUTBOUND_QUEUE_PER_CONNECTION = 128;
export const DEFAULT_WS_MAX_OUTBOUND_QUEUE_BYTES_PER_CONNECTION = 1024 * 1024;

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
  const raw = parseInt(getRuntimeEnv()['WS_BATCH_FLUSH_MS'] ?? '', 10);
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
  const raw = parseInt(getRuntimeEnv()['WS_BATCH_MAX_SIZE'] ?? '', 10);
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
  /** Maximum number of subscriptions a single connection may hold. */
  maxSubscriptionsPerConnection?: number;
  /** Maximum number of queued outbound messages a single connection may retain. */
  maxOutboundQueuePerConnection?: number;
  /** Maximum retained outbound queue bytes for a single connection. */
  maxOutboundQueueBytesPerConnection?: number;
  /** Maximum inbound WebSocket message payload size in bytes. */
  maxInboundMessageBytes?: number;
  /** Number of consecutive missed pongs before termination. Default 2. */
  healthProbeMaxMissed?: number;
  /**
   * Outbound `bufferedAmount` (in bytes) above which an OPEN connection is
   * classified as **stalled** by the health probe rather than healthy.
   *
   * An open socket is not necessarily healthy: when frames buffer faster
   * than the peer drains them, the outbound queue saturates and the
   * connection is effectively stalled. Defaults to `BACKPRESSURE_DROP_BYTES`
   * (1 MiB) — the point at which the hub starts dropping frames for the
   * client. Values below 0 are ignored and the default is used.
   */
  healthProbeStallBytes?: number;
}

// ── Hub ──────────────────────────────────────────────────────────────────────

export class StreamHub extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly registry = new ConnectionRegistry();
  private readonly router: SubscriptionRouter;
  private readonly backpressure: OutboundBackpressure;
  private readonly batches: BatchAccumulator;
  private readonly dedup: IDedupCache;
  private readonly ownsDedup: boolean;
  private readonly wsAuthRequired: boolean;
  private readonly jwtSecret: string | undefined;
  private readonly allowedOrigins: ReadonlySet<string> | undefined;
  private readonly maxSubscriptionsPerConnection: number;
  private readonly maxOutboundQueuePerConnection: number;
  private readonly maxOutboundQueueBytesPerConnection: number;
  private readonly maxInboundMessageBytes: number;
  private eventStore: ContractEventStore | undefined;
  private readonly backpressureCollectorInterval: NodeJS.Timeout | undefined;
  private readonly backpressureSlowThresholdBytes: number;
  private readonly healthProbeIntervalMs: number;
  private readonly healthProbeMaxMissed: number;
  private readonly healthProbeStallBytes: number;
  private readonly healthProbeTimer: NodeJS.Timeout | undefined;

  /** Live connections keyed by socket; owned by the registry. */
  private get clients(): Map<WebSocket, ClientState> {
    return this.registry.clients;
  }

  /** Stream-scoped subscription index; owned by the registry. */
  private get streamSubscriptions(): ReadonlyMap<string, Set<WebSocket>> {
    return this.registry.streamSubscriptionIndex();
  }

  /** Per-connection outbound queues, owned by the backpressure layer. */
  private get outboundQueues(): Map<WebSocket, string[]> {
    return this.backpressure.queues();
  }

  public getEventStore(): ContractEventStore | undefined {
    return this.eventStore;
  }

  public getStreamSubscriptionCount(streamId: string): number {
    return this.registry.streamSubscriberCount(streamId);
  }

  constructor(server: Server, options?: StreamHubOptions) {
    super();

    // Every tunable comes from the validated environment schema unless the
    // caller overrides it for this instance.
    const config = resolveHubConfig(options);

    this.wsAuthRequired = config.wsAuthRequired;
    this.jwtSecret = config.jwtSecret;
    this.allowedOrigins = config.allowedOrigins;
    this.maxSubscriptionsPerConnection = config.maxSubscriptionsPerConnection;
    this.maxOutboundQueuePerConnection = config.maxOutboundQueuePerConnection;
    this.maxOutboundQueueBytesPerConnection = config.maxOutboundQueueBytesPerConnection;
    this.maxInboundMessageBytes = config.maxInboundMessageBytes;
    this.healthProbeIntervalMs = config.healthProbeIntervalMs;
    this.healthProbeMaxMissed = config.healthProbeMaxMissed;
    this.healthProbeStallBytes = config.healthProbeStallBytes;

    setWsResourceLimitMetrics({
      maxSubscriptionsPerConnection: this.maxSubscriptionsPerConnection,
      maxOutboundQueuePerConnection: this.maxOutboundQueuePerConnection,
      maxOutboundQueueBytesPerConnection: this.maxOutboundQueueBytesPerConnection,
      maxInboundMessageBytes: this.maxInboundMessageBytes,
    });

    if (options?.dedupCache) {
      this.dedup = options.dedupCache;
      this.ownsDedup = false;
    } else {
      this.dedup = new InMemoryDedupCache();
      this.ownsDedup = true;
    }

    this.eventStore = options?.eventStore;

    this.router = new SubscriptionRouter(
      this.registry,
      this.maxSubscriptionsPerConnection,
      (ws, code, message) => this.sendError(ws, code, message),
      () => wsSubscriptionLimitViolationsTotal.inc()
    );

    this.backpressure = new OutboundBackpressure(
      { dropBytes: config.dropBytes, terminateBytes: config.terminateBytes },
      this.maxOutboundQueuePerConnection,
      this.maxOutboundQueueBytesPerConnection,
      this.registry,
      (action, ws, bufferedAmount, thresholdBytes, streamId, eventId) =>
        reportBackpressure(
          this,
          this.registry,
          action,
          ws,
          bufferedAmount,
          thresholdBytes,
          streamId,
          eventId
        ),
      (ws) => this.disconnect(ws)
    );

    this.batches = new BatchAccumulator(
      config.batchFlushMs,
      config.batchMaxSize,
      (ws, message, frames) => {
        const queued = this.queueOutboundMessage(ws, message);
        if (!queued) this.backpressure.countDropped(frames);
        return queued;
      }
    );

    // Default: 5s poll, 1 MiB slow threshold. intervalMs=0 disables the timer.
    const collectorOpts: StreamHubBackpressureCollectorOptions | undefined =
      options?.backpressureCollector;
    const intervalMs = collectorOpts?.intervalMs ?? DEFAULT_WS_BACKPRESSURE_INTERVAL_MS;
    this.backpressureSlowThresholdBytes =
      collectorOpts?.slowThresholdBytes ?? DEFAULT_WS_SLOW_CLIENT_BYTES;

    // Use noServer mode so we fully control the upgrade handshake.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxInboundMessageBytes });

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

    attachUpgradeHandler(server, {
      wss: this.wss,
      allowedOrigins: this.allowedOrigins,
      wsAuthRequired: this.wsAuthRequired,
      jwtSecret: this.jwtSecret,
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      onConnect(ws, req, this.lifecycleDeps());
    });
  }

  // ── Inbound messages ────────────────────────────────────────────────────

  async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    const result = validateWebSocketMessage(raw, undefined, this.maxInboundMessageBytes);
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }

    if (result.message.type === 'replay') {
      void this.replay(ws, result.message.filter);
      return;
    }

    const authorized = await this.router.authorize(ws, result.message.filter);
    if (!authorized.ok) {
      this.sendError(ws, authorized.code, authorized.message);
      return;
    }

    if (result.message.type === 'subscribe') {
      this.router.subscribe(ws, authorized.filter);
    } else {
      this.router.unsubscribe(ws, authorized.filter);
    }
  }

  // ── Broadcast ────────────────────────────────────────────────────────────

  async broadcast(event: StreamUpdateEvent): Promise<void> {
    return broadcastEvent(event, {
      dedup: this.dedup,
      router: this.router,
      batches: this.batches,
      deliverBatch: (batch, message, batchStreamId, batchEventId) =>
        this.deliverBatch(batch, message, batchStreamId, batchEventId),
    });
  }

  /**
   * Force-close every socket currently subscribed to a stream ID.
   * Returns the number of sockets targeted before the disconnect completes.
   */
  disconnectByStreamId(streamId: string): number {
    return disconnectStreamSubscribers(this.registry, streamId);
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  /**
   * Attach (or replace) the event store used by replayFromCursor.
   * Called by the indexer route after the store is configured.
   */
  setEventStore(store: ContractEventStore): void {
    this.eventStore = store;
  }

  /** Replay stored events after the cursor, in ledger order, as `stream_replay` frames. */
  async replayFromCursor(ws: WebSocket, filter: StreamEventReplayFilter = {}): Promise<void> {
    return this.replay(ws, filter);
  }

  private replay(ws: WebSocket, filter: StreamEventReplayFilter): Promise<void> {
    return replayFromCursor(ws, this.replayDeps(), filter);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Collaborators shared by the connection lifecycle handlers. */
  private lifecycleDeps(): ConnectionLifecycleDeps {
    return {
      registry: this.registry,
      router: this.router,
      batches: this.batches,
      backpressure: this.backpressure,
      maxInboundMessageBytes: this.maxInboundMessageBytes,
      jwtSecret: this.jwtSecret,
      handleMessage: (ws, raw) => {
        void this.handleMessage(ws, raw);
      },
      sendError: (ws, code, message) => this.sendError(ws, code, message),
    };
  }

  /** Collaborators used by cursor replay. */
  private replayDeps(): ReplayDeps {
    return {
      getEventStore: () => this.eventStore,
      sendError: (ws, code, message) => this.sendError(ws, code, message),
      queueOutboundMessage: (ws, message) => this.queueOutboundMessage(ws, message),
    };
  }

  /** Release everything a connection held. Used by close and forced teardown. */
  private disconnect(ws: WebSocket): void {
    onDisconnect(ws, undefined, undefined, this.lifecycleDeps());
  }

  /** Deliver one serialized frame to a batch and record the broadcast span. */
  private deliverBatch(
    batch: WebSocket[],
    message: string,
    streamId: string,
    eventId: string
  ): number {
    const sent = this.backpressure.deliverBatch(batch, message, streamId, eventId);
    recordBroadcastSpan(sent, streamId, eventId);
    return sent;
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.queueOutboundMessage(ws, JSON.stringify({ type: 'error', code, message }));
  }

  /** Enqueue one serialized frame and try to drain it; `false` when refused. */
  private queueOutboundMessage(ws: WebSocket, message: string): boolean {
    return this.backpressure.queueOutboundMessage(ws, message);
  }

  private runHealthProbes(): void {
    runHealthProbes({
      registry: this.registry,
      maxMissed: this.healthProbeMaxMissed,
      stallBytes: this.healthProbeStallBytes,
    });
  }

  // ── Observability surface ────────────────────────────────────────────────

  get clientCount(): number {
    return this.registry.size;
  }

  /** Collector entry-point: enumerate sockets. Treat sockets as opaque. */
  _getClients(): IterableIterator<[WebSocket, ClientState]> {
    return this.registry.entries();
  }

  /** Collector entry-point: read-only view of the stream index. */
  _getStreamSubscriptions(): ReadonlyMap<string, Set<WebSocket>> {
    return this.registry.streamSubscriptionIndex();
  }

  /** Tests/diagnostics: read-only view of the recipient index. */
  _getRecipientSubscriptions(): ReadonlyMap<string, Set<WebSocket>> {
    return this.registry.recipientSubscriptionIndex();
  }

  getMetrics(): Readonly<BackpressureMetrics> {
    return this.backpressure.getMetrics();
  }

  setBackpressureThresholds(opts: { dropBytes?: number; terminateBytes?: number }): void {
    this.backpressure.setThresholds(opts);
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  async close(cb?: () => void): Promise<void> {
    // Legacy close kept for internal use; it simply shuts down the server.
    if (this.backpressureCollectorInterval) {
      clearInterval(this.backpressureCollectorInterval);
    }
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
    }
    // Cancel all pending batch flush timers before closing.
    this.batches.clearAll();
    this.backpressure.clearAll();
    if (this.ownsDedup) await this.dedup.close();
    this.wss.close(cb);
  }

  async gracefulClose(): Promise<void> {
    for (const ws of this.registry.keys()) {
      ws.close(WS_CLOSE_CODE_GOING_AWAY, JSON.stringify({ reason: SSE_CLOSE_REASONS.SERVER_SHUTDOWN }));
    }
    await this.close();
  }

  // ── Test hooks ───────────────────────────────────────────────────────────

  async _resetDedup(): Promise<void> {
    await this.dedup.clear();
  }

  /** Run one health-probe pass synchronously, for tests that disable the timer. */
  _runHealthProbes(): void {
    this.runHealthProbes();
  }

  _resetMetrics(): void {
    this.backpressure.resetMetrics();
  }

  /** Cancel all pending batch timers and clear accumulators. For tests only. */
  _resetBatchAccumulators(): void {
    this.batches.clearAll();
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

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

