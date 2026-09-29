/**
 * Shared type declarations for the WebSocket stream hub.
 *
 * The hub is split across focused modules (registry, routing, backpressure,
 * batching, configuration). These declarations are the vocabulary they share,
 * kept in one place so no module has to import another just to name a type.
 *
 * @module ws/hubTypes
 */

import type { SubscriptionFilter } from './messageHandler.js';
import type { ContractEventStore } from '../indexer/store.js';
import type { DedupCache } from '../redis/dedup.js';

/** A stream update fanned out to subscribers over the WebSocket hub. */
export interface StreamUpdateEvent {
  streamId: string;
  eventId: string;
  payload: unknown;
  correlationId?: string;
  ledger?: number;
  recipientAddress?: string;
}

/** Per-connection frame and byte counters surfaced in the disconnect log. */
export interface ConnectionMetrics {
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
}

/** Everything the hub tracks for one connected client. */
export interface ClientState {
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

/**
 * A single event entry stored in a client's per-stream batch accumulator while
 * waiting for the flush window to expire.
 */
export interface BatchedEvent {
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
 * Keyed by `${connectionId}:${streamId}`. The `timer` field holds the scheduled
 * flush timeout so it can be cancelled on client disconnect or hub shutdown.
 */
export interface ClientBatchAccumulator {
  events: BatchedEvent[];
  /** `setTimeout` handle for the pending flush. */
  timer: NodeJS.Timeout;
  /** Timestamp (ms) the accumulator was created — i.e. when its oldest event arrived. */
  createdAt: number;
}

/** Aggregate counters the hub keeps for the backpressure path. */
export interface BackpressureMetrics {
  droppedMessages: number;
  terminatedConnections: number;
  sentMessages: number;
}

/** What the hub did with a frame addressed to a slow client. */
export type BackpressureAction = 'drop' | 'terminate';

/** Emitted on the hub's `backpressure` event and written to the warn log. */
export interface StreamHubBackpressureEvent {
  action: BackpressureAction;
  streamId: string;
  eventId: string;
  connectionId: string;
  bufferedAmount: number;
  thresholdBytes: number;
  timestamp: string;
}

/** Overrides for the per-client backpressure collector. */
export interface StreamHubBackpressureCollectorOptions {
  /** Poll interval in milliseconds. 0 disables the periodic collector. */
  intervalMs?: number;
  /** Threshold above which a client is counted as "slow" in the aggregate gauge. */
  slowThresholdBytes?: number;
}

/** Construction options for `StreamHub`. */
export interface StreamHubOptions {
  dedupCache?: DedupCache;
  /** Buffered-bytes threshold above which events are dropped for a slow client. Defaults to `BACKPRESSURE_DROP_BYTES` (1 MiB). */
  dropBytes?: number;
  /** Buffered-bytes threshold above which a slow client's connection is terminated. Defaults to `BACKPRESSURE_TERMINATE_BYTES` (4 MiB). */
  terminateBytes?: number;
  /**
   * When true, upgrade requests without a valid JWT are rejected with 401.
   * Defaults to the validated `WS_AUTH_REQUIRED` setting.
   */
  wsAuthRequired?: boolean;
  /**
   * JWT secret used to verify tokens on upgrade.
   * Defaults to the validated `JWT_SECRET` setting.
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
   * Micro-batching tunables.  When absent, the validated `WS_BATCH_FLUSH_MS` /
   * `WS_BATCH_MAX_SIZE` settings are used.  Providing these in tests lets
   * suites run at faster cadences without mutating env vars.
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
