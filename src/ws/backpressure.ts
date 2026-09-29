/**
 * WebSocket outbound backpressure.
 *
 * One `bufferedAmount` is not enough to describe a slow client, so this module
 * keeps the whole outbound path in one place:
 *
 *  - a per-connection outbound queue with message-count and byte ceilings, so a
 *    saturated peer cannot make the hub buffer without bound,
 *  - the two thresholds every send passes through: above the drop threshold a
 *    frame is discarded, above the terminate threshold the socket is killed,
 *  - the aggregate counters the hub reports through `getMetrics()` and emits
 *    as `backpressure` events.
 *
 * A send that is refused (queue full, socket not open, peer above a threshold)
 * reports `false` to the caller, which owns the retry/drop accounting decision
 * for that frame.
 *
 * @module ws/backpressure
 */

import type { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { logger } from '../lib/logger.js';
import { wsOutboundQueueLimitViolationsTotal } from '../metrics/wsBackpressure.js';
import type { ConnectionRegistry } from './connectionRegistry.js';
import type {
  BackpressureAction,
  BackpressureMetrics,
  StreamHubBackpressureEvent,
} from './hubTypes.js';

/** Sink for the hub's `backpressure` event and warn log. */
export type BackpressureReporter = (
  action: BackpressureAction,
  ws: WebSocket,
  bufferedAmount: number,
  thresholdBytes: number,
  streamId: string,
  eventId: string
) => void;

/** Called after a connection was force-terminated, so state can be released. */
export type OnTerminate = (ws: WebSocket) => void;

/**
 * Report one slow-client action: emit the hub's `backpressure` event and write
 * the matching warn log. A socket with no registered state is ignored.
 */
export function reportBackpressure(
  emitter: EventEmitter,
  registry: ConnectionRegistry,
  action: BackpressureAction,
  ws: WebSocket,
  bufferedAmount: number,
  thresholdBytes: number,
  streamId: string,
  eventId: string
): void {
  const state = registry.get(ws);
  if (!state) return;

  const timestamp = new Date().toISOString();
  const payload: StreamHubBackpressureEvent = {
    action,
    streamId,
    eventId,
    connectionId: state.id,
    bufferedAmount,
    thresholdBytes,
    timestamp,
  };
  emitter.emit('backpressure', payload);
  logger.warn('WebSocket backpressure applied', state.correlationId, {
    event: 'ws_backpressure',
    action,
    streamId,
    eventId,
    connectionId: state.id,
    bufferedAmount,
    thresholdBytes,
    timestamp,
  });
}

export class OutboundBackpressure {
  /** Buffered-bytes threshold above which a frame is dropped for a slow client. */
  private dropBytes: number;
  /** Buffered-bytes threshold above which a slow client's socket is terminated. */
  private terminateBytes: number;
  /** Frames waiting to be handed to a socket, keyed by socket. */
  private readonly outboundQueues = new Map<WebSocket, string[]>();
  private readonly metrics: BackpressureMetrics = {
    droppedMessages: 0,
    terminatedConnections: 0,
    sentMessages: 0,
  };

  constructor(
    thresholds: { dropBytes: number; terminateBytes: number },
    private readonly maxQueuePerConnection: number,
    private readonly maxQueueBytesPerConnection: number,
    private readonly registry: ConnectionRegistry,
    private readonly report: BackpressureReporter,
    private readonly onTerminate: OnTerminate
  ) {
    this.dropBytes = thresholds.dropBytes;
    this.terminateBytes = thresholds.terminateBytes;
  }

  // ── Thresholds ───────────────────────────────────────────────────────────

  setThresholds(opts: { dropBytes?: number; terminateBytes?: number }): void {
    if (typeof opts.dropBytes === 'number' && opts.dropBytes >= 0) this.dropBytes = opts.dropBytes;
    if (typeof opts.terminateBytes === 'number' && opts.terminateBytes >= 0)
      this.terminateBytes = opts.terminateBytes;
  }

  getThresholds(): { dropBytes: number; terminateBytes: number } {
    return { dropBytes: this.dropBytes, terminateBytes: this.terminateBytes };
  }

  // ── Counters ─────────────────────────────────────────────────────────────

  getMetrics(): Readonly<BackpressureMetrics> {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics.droppedMessages = 0;
    this.metrics.terminatedConnections = 0;
    this.metrics.sentMessages = 0;
  }

  countDropped(frames = 1): void {
    this.metrics.droppedMessages += frames;
  }

  // ── Outbound queue ───────────────────────────────────────────────────────

  /**
   * Enqueue one serialized frame and try to drain it.
   *
   * Returns `false` when the frame was refused: the socket is not open, or the
   * connection already holds `maxQueuePerConnection` frames /
   * `maxQueueBytesPerConnection` bytes. The Prometheus queue-limit counter is
   * incremented in the latter case.
   */
  queueOutboundMessage(ws: WebSocket, message: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;

    const queue = this.outboundQueues.get(ws) ?? [];
    const queuedBytes = queue.reduce(
      (total, queuedMessage) => total + Buffer.byteLength(queuedMessage, 'utf8'),
      0
    );
    const messageBytes = Buffer.byteLength(message, 'utf8');
    if (
      queue.length >= this.maxQueuePerConnection ||
      queuedBytes + messageBytes > this.maxQueueBytesPerConnection
    ) {
      wsOutboundQueueLimitViolationsTotal.inc();
      return false;
    }

    queue.push(message);
    this.outboundQueues.set(ws, queue);
    this.flushOutboundQueue(ws);
    return true;
  }

  /**
   * Drain a connection's queue while the peer keeps up.
   *
   * The loop stops as soon as the socket is saturated (`bufferedAmount` above
   * the drop threshold) or closed, leaving the remaining frames queued for the
   * next send. A socket above the terminate threshold is killed and its queued
   * frames are counted as dropped.
   */
  private flushOutboundQueue(ws: WebSocket): void {
    const queue = this.outboundQueues.get(ws);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.outboundQueues.delete(ws);
        return;
      }

      const buffered = ws.bufferedAmount;
      if (buffered > this.terminateBytes) {
        this.metrics.terminatedConnections++;
        this.metrics.droppedMessages += queue.length;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        this.onTerminate(ws);
        return;
      }

      if (buffered > this.dropBytes) {
        return;
      }

      const next = queue.shift();
      if (next === undefined) break;

      try {
        ws.send(next);
      } catch {
        this.metrics.droppedMessages++;
        return;
      }

      this.metrics.sentMessages++;
      const state = this.registry.get(ws);
      if (state) {
        state.metrics.messagesSent += 1;
        state.metrics.bytesSent += Buffer.byteLength(next, 'utf8');
      }
    }

    if (queue.length === 0) {
      this.outboundQueues.delete(ws);
    }
  }

  /**
   * Live outbound queues, keyed by socket.
   *
   * Exposed so the hub can surface the queue map to diagnostics and suites that
   * assert the per-connection ceilings; the map itself stays owned here.
   */
  queues(): Map<WebSocket, string[]> {
    return this.outboundQueues;
  }

  /** Forget a connection's queued frames (used on disconnect). */
  forget(ws: WebSocket): void {
    this.outboundQueues.delete(ws);
  }

  /** Forget every queued frame (used on shutdown). */
  clearAll(): void {
    for (const ws of Array.from(this.outboundQueues.keys())) {
      this.outboundQueues.delete(ws);
    }
  }

  // ── Fanout delivery ──────────────────────────────────────────────────────

  /**
   * Deliver one serialized frame to a batch of recipients, applying the
   * thresholds per recipient and counting what was sent.
   *
   * @returns The number of recipients the frame was accepted for.
   */
  deliverBatch(
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
        this.report('terminate', ws, buffered, this.terminateBytes, streamId, eventId);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        this.onTerminate(ws);
        continue;
      }

      if (buffered > this.dropBytes) {
        this.metrics.droppedMessages++;
        this.report('drop', ws, buffered, this.dropBytes, streamId, eventId);
        continue;
      }

      if (!this.queueOutboundMessage(ws, message)) {
        this.metrics.droppedMessages++;
        continue;
      }
      sent++;
    }

    return sent;
  }
}
