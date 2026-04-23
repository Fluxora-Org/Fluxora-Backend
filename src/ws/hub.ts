/**
 * WebSocket Hub — stream update broadcast channel (#49).
 *
 * Responsibilities:
 *   - Track connected clients per stream subscription.
 *   - Rate-limit incoming messages per connection.
 *   - Reject oversized inbound payloads.
 *   - Deduplicate outbound events by (streamId, eventId) to prevent
 *     duplicate delivery on reconnect or RPC retry.
 *   - Broadcast stream update events to all subscribed clients.
 *   - Apply backpressure to slow/stalled clients so that a single slow
 *     consumer cannot grow unbounded socket buffers or stall the Node.js
 *     event loop during large fanout.
 *
 * Protocol (JSON over WebSocket):
 *   Client → Server:  { type: "subscribe",   streamId: string }
 *   Client → Server:  { type: "unsubscribe", streamId: string }
 *   Server → Client:  { type: "stream_update", streamId: string, eventId: string, payload: unknown }
 *   Server → Client:  { type: "error", code: string, message: string }
 *
 * Backpressure strategy (see #49 follow-up):
 *   Every WebSocket exposes `bufferedAmount`, the number of bytes queued in
 *   the kernel/TLS/framing layers that have not yet been flushed to the
 *   peer. When a consumer stops reading (congested network, suspended
 *   browser tab, stalled process) this value grows on every subsequent
 *   `send()`. In a fanout topology a single slow client can therefore:
 *     (a) consume an unbounded amount of server memory, and
 *     (b) keep the event loop busy copying payloads into full socket
 *         buffers, starving other connections.
 *
 *   To prevent this the hub enforces a per-connection high-water mark. On
 *   each broadcast we inspect `bufferedAmount` **before** sending:
 *     - If it exceeds `BACKPRESSURE_DROP_BYTES`, the message is dropped for
 *       that client (recorded in metrics) — other subscribers are still
 *       served. Dropping, rather than buffering in user-space, guarantees
 *       bounded memory usage.
 *     - If it also exceeds `BACKPRESSURE_TERMINATE_BYTES`, the connection
 *       is forcibly terminated. The client is expected to reconnect and
 *       resubscribe; the dedup cache ensures it will not miss events that
 *       have already been delivered to healthy peers, and at-least-once
 *       delivery from the indexer covers anything newer.
 *
 *   In addition, fanouts larger than `FANOUT_YIELD_BATCH` subscribers are
 *   chunked across `setImmediate` boundaries so the event loop can service
 *   I/O between batches. This keeps p99 latency bounded even when a single
 *   stream has thousands of subscribers.
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { DedupCache as IDedupCache } from '../redis/dedup.js';
import { InMemoryDedupCache } from '../redis/dedup.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_MESSAGE_BYTES = 4_096;
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 10_000;
const DEDUP_CACHE_MAX = 10_000;

/**
 * Per-connection outbound buffer high-water mark. When `ws.bufferedAmount`
 * exceeds this value the next outbound message for that client is dropped
 * instead of queued. 1 MiB is enough to absorb short network hiccups while
 * bounding worst-case memory per client.
 */
export const BACKPRESSURE_DROP_BYTES = 1 * 1024 * 1024;

/**
 * Hard ceiling. When `ws.bufferedAmount` exceeds this the connection is
 * terminated: the peer is considered unhealthy and allowing it to continue
 * risks OOM or event-loop starvation. 4 MiB ≈ 4× the drop threshold, which
 * is the point at which the kernel/TLS send queues are clearly not
 * draining.
 */
export const BACKPRESSURE_TERMINATE_BYTES = 4 * 1024 * 1024;

/**
 * Fanouts larger than this many subscribers are chunked across
 * `setImmediate` turns so the event loop can interleave I/O. For small
 * fanouts the extra scheduling round-trip is unnecessary.
 */
export const FANOUT_YIELD_BATCH = 256;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamUpdateEvent {
  streamId: string;
  eventId: string;
  payload: unknown;
}

/** Observable counters for backpressure events. Exposed for metrics/tests. */
export interface BackpressureMetrics {
  /** Messages dropped because `bufferedAmount` exceeded the drop threshold. */
  droppedMessages: number;
  /** Connections terminated because `bufferedAmount` exceeded the terminate threshold. */
  terminatedConnections: number;
  /** Total `ws.send()` calls that were actually invoked. */
  sentMessages: number;
}

interface ClientState {
  id: string;
  connectedAt: number;
  ip: string;
  metrics: ConnectionMetrics;
  subscriptions: Set<string>;
  messageTimestamps: number[];
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export interface StreamHubOptions {
  dedupCache?: IDedupCache;
}

export class StreamHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly subscriptions = new Map<string, Set<WebSocket>>();
  private readonly dedup = new DedupCache();
  private readonly metrics: BackpressureMetrics = {
    droppedMessages: 0,
    terminatedConnections: 0,
    sentMessages: 0,
  };

  /**
   * Optional override of the backpressure thresholds (primarily for tests
   * that want to exercise the slow-consumer path without having to actually
   * buffer megabytes of data).
   */
  private dropBytes: number = BACKPRESSURE_DROP_BYTES;
  private terminateBytes: number = BACKPRESSURE_TERMINATE_BYTES;

  constructor(server: Server, options?: StreamHubOptions) {
    this.wss = new WebSocketServer({ server, path: '/ws/streams' });

    if (options?.dedupCache) {
      this.dedup = options.dedupCache;
      this.ownsDedup = false;
    } else {
      this.dedup = new InMemoryDedupCache();
      this.ownsDedup = true;
    }

    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      this.onConnect(ws);
    });
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private onConnect(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = randomUUID();
    const ip = req.socket.remoteAddress || 'unknown';
    const connectedAt = Date.now();

    this.clients.set(ws, {
      id: connectionId,
      connectedAt,
      ip,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptions: new Set(),
      messageTimestamps: [],
    });

    console.info(
      JSON.stringify({
        event: 'ws_connect',
        connectionId,
        ip,
        timestamp: new Date(connectedAt).toISOString(),
      }),
    );

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

  private onDisconnect(ws: WebSocket, code: number, reason: Buffer): void {
    const state = this.clients.get(ws);
    if (!state) return;

    for (const streamId of state.subscriptions) {
      this.subscriptions.get(streamId)?.delete(ws);
      if (this.subscriptions.get(streamId)?.size === 0) {
        this.subscriptions.delete(streamId);
      }
    }

    const durationMs = Date.now() - state.connectedAt;
    console.info(
      JSON.stringify({
        event: 'ws_disconnect',
        connectionId: state.id,
        durationMs,
        code,
        reason: reason.toString('utf8'),
        metrics: state.metrics,
      }),
    );

    this.clients.delete(ws);
  }

  // ── Network Transmission ───────────────────────────────────────────────────

  private sendMessage(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      const state = this.clients.get(ws);
      if (state) {
        state.metrics.messagesSent += 1;
        state.metrics.bytesSent += Buffer.byteLength(message, 'utf8');
      }
    }
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  private checkRateLimit(ws: WebSocket): boolean {
    const state = this.clients.get(ws);
    if (!state) return false;

    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    state.messageTimestamps = state.messageTimestamps.filter((t) => t >= cutoff);

    if (state.messageTimestamps.length >= RATE_LIMIT_MAX) {
      return false;
    }

    state.messageTimestamps.push(now);
    return true;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(ws, 'INVALID_JSON', 'Message is not valid JSON');
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      this.sendError(ws, 'INVALID_MESSAGE', 'Message must be a JSON object');
      return;
    }

    const { type, streamId } = msg as Record<string, unknown>;

    if (typeof streamId !== 'string' || streamId.trim() === '') {
      this.sendError(ws, 'INVALID_MESSAGE', 'streamId must be a non-empty string');
      return;
    }

    if (type === 'subscribe') {
      this.subscribe(ws, streamId);
    } else if (type === 'unsubscribe') {
      this.unsubscribe(ws, streamId);
    } else {
      this.sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${String(type)}`);
    }
  }

  private subscribe(ws: WebSocket, streamId: string): void {
    const state = this.clients.get(ws);
    if (!state) return;

    state.subscriptions.add(streamId);

    if (!this.subscriptions.has(streamId)) {
      this.subscriptions.set(streamId, new Set());
    }
    this.subscriptions.get(streamId)!.add(ws);
  }

  private unsubscribe(ws: WebSocket, streamId: string): void {
    const state = this.clients.get(ws);
    if (!state) return;

    state.subscriptions.delete(streamId);
    this.subscriptions.get(streamId)?.delete(ws);
    if (this.subscriptions.get(streamId)?.size === 0) {
      this.subscriptions.delete(streamId);
    }
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────

  /**
   * Broadcast a stream update to all clients subscribed to `event.streamId`.
   *
   * Deduplication: if (streamId, eventId) has already been broadcast, the call
   * is a no-op. This prevents duplicate delivery when the indexer retries or
   * the RPC layer replays events.
   *
   * Backpressure: see the file header. Clients whose send buffer has grown
   * past the drop threshold are skipped for this broadcast; clients past the
   * terminate threshold are disconnected. The broadcast is processed in
   * batches of `FANOUT_YIELD_BATCH` subscribers, yielding to the event loop
   * between batches on large fanouts.
   *
   * Note: the payload is serialized **once** with `JSON.stringify`. Callers
   * are responsible for ensuring decimal/amount fields are already encoded
   * as strings before they reach the hub — this preserves the decimal-string
   * serialization guarantee for chain/API amount fields (no Number coercion
   * occurs in the hub).
   */
  async broadcast(event: StreamUpdateEvent): Promise<void> {
    const { streamId, eventId, payload } = event;

    if (await this.dedup.has(streamId, eventId)) {
      return;
    }
    await this.dedup.add(streamId, eventId);

    const subscribers = this.subscriptions.get(streamId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({ type: 'stream_update', streamId, eventId, payload });

    // Snapshot the subscriber set so that disconnects/terminations triggered
    // by backpressure during this broadcast do not mutate the iterator.
    const targets = Array.from(subscribers);

    if (targets.length <= FANOUT_YIELD_BATCH) {
      this.deliverBatch(targets, message);
      return;
    }

    // Large fanout: chunk across setImmediate turns so the event loop can
    // interleave other I/O (new connections, inbound messages, timers).
    const self = this;
    let i = 0;
    function next(): void {
      const end = Math.min(i + FANOUT_YIELD_BATCH, targets.length);
      self.deliverBatch(targets.slice(i, end), message);
      i = end;
      if (i < targets.length) {
        setImmediate(next);
      }
    }
    next();
  }

  /**
   * Deliver `message` to each ws in `batch`, honoring backpressure thresholds.
   */
  private deliverBatch(batch: WebSocket[], message: string): void {
    for (const ws of batch) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const buffered = ws.bufferedAmount;

      if (buffered > this.terminateBytes) {
        // Peer is definitively not draining — cut it loose.
        this.metrics.terminatedConnections++;
        this.metrics.droppedMessages++;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        this.onDisconnect(ws);
        continue;
      }

      if (buffered > this.dropBytes) {
        // Transient congestion — skip this message for this client only.
        this.metrics.droppedMessages++;
        continue;
      }

      ws.send(message);
      this.metrics.sentMessages++;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendMessage(ws, JSON.stringify({ type: 'error', code, message }));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Snapshot of backpressure counters (for health/metrics). */
  getMetrics(): Readonly<BackpressureMetrics> {
    return { ...this.metrics };
  }

  /**
   * Override backpressure thresholds. Primarily for tests; also useful for
   * environments that want tighter per-connection memory limits.
   */
  setBackpressureThresholds(opts: { dropBytes?: number; terminateBytes?: number }): void {
    if (typeof opts.dropBytes === 'number' && opts.dropBytes >= 0) {
      this.dropBytes = opts.dropBytes;
    }
    if (typeof opts.terminateBytes === 'number' && opts.terminateBytes >= 0) {
      this.terminateBytes = opts.terminateBytes;
    }
  }

  /** Close the underlying WebSocket server (for graceful shutdown). */
  async close(cb?: () => void): Promise<void> {
    if (this.ownsDedup) {
      await this.dedup.close();
    }
    this.wss.close(cb);
  }

  /** Reset dedup cache (for testing). */
  async _resetDedup(): Promise<void> {
    await this.dedup.clear();
  }

  /** Reset metrics counters (for testing). */
  _resetMetrics(): void {
    this.metrics.droppedMessages = 0;
    this.metrics.terminatedConnections = 0;
    this.metrics.sentMessages = 0;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _hub: StreamHub | null = null;

export function createStreamHub(server: Server): StreamHub {
  _hub = new StreamHub(server);
  return _hub;
}

export function getStreamHub(): StreamHub | null {
  return _hub;
}

export function resetStreamHub(): void {
  _hub = null;
}
