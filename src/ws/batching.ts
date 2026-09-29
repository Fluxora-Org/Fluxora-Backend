/**
 * WebSocket micro-batching.
 *
 * Clients that subscribe with `batching: true` receive one
 * `stream_update_batch` frame per flush window instead of one frame per event.
 * This module owns the accumulators, the flush timers, and the frame shape;
 * delivering the finished frame still goes through the hub's backpressure
 * path so a batched client is dropped or terminated exactly like an
 * unbatched one.
 *
 * Accumulators are keyed by `${connectionId}:${streamId}` and are cancelled
 * on disconnect, on hub shutdown, and when a batch fills up.
 *
 * @module ws/batching
 */

import { WebSocket } from 'ws';
import {
  recordWsBroadcastBatchFlushLatency,
  wsBatchEventsCoalescedTotal,
  wsBatchFlushTotal,
  wsBatchSizeExceededTotal,
} from '../metrics/wsBackpressure.js';
import { MAX_MESSAGE_BYTES } from './hubConfig.js';
import type { BatchedEvent, ClientBatchAccumulator, ClientState } from './hubTypes.js';

/**
 * Queues a serialized batch frame through the hub's backpressure path.
 *
 * @param frames Number of events the frame carries, so the caller can account
 *               for every event when the frame is refused.
 * @returns `true` when the frame was accepted.
 */
export type DeliverFrame = (ws: WebSocket, message: string, frames: number) => boolean;

export class BatchAccumulator {
  /** Pending accumulators keyed by `${connectionId}:${streamId}`. */
  private readonly accumulators = new Map<string, ClientBatchAccumulator>();

  constructor(
    private readonly flushMs: number,
    private readonly maxSize: number,
    private readonly deliver: DeliverFrame
  ) {}

  /**
   * Buffer one event for a client, starting the flush window on the first
   * event of the window.
   *
   * When the batch reaches `maxSize` it is flushed immediately (and the
   * `wsBatchSizeExceededTotal` counter records the early flush) instead of
   * waiting for the timer.
   */
  enqueue(ws: WebSocket, state: ClientState, entry: BatchedEvent): void {
    const key = `${state.id}:${entry.streamId}`;
    let acc = this.accumulators.get(key);

    if (!acc) {
      // First event in this window — create accumulator and arm timer.
      const timer = setTimeout(() => {
        this.flush(ws, key);
      }, this.flushMs);
      // Allow the process to exit without waiting for the timer.
      if (typeof timer.unref === 'function') timer.unref();

      acc = { events: [], timer, createdAt: Date.now() };
      this.accumulators.set(key, acc);
    }

    acc.events.push(entry);

    // Early flush if the batch is full.
    if (acc.events.length >= this.maxSize) {
      clearTimeout(acc.timer);
      this.accumulators.delete(key);
      this.send(ws, entry.streamId, acc.events, true, acc.createdAt);
    }
  }

  /**
   * Timer-driven flush: reads the accumulator and dispatches a batch frame.
   * The accumulator entry is always removed here so memory is freed even if
   * the client has disconnected in the interim.
   */
  private flush(ws: WebSocket, key: string): void {
    const acc = this.accumulators.get(key);
    if (!acc) return; // already flushed (e.g. on disconnect cleanup)

    this.accumulators.delete(key);

    const streamId = key.slice(key.indexOf(':') + 1);
    this.send(ws, streamId, acc.events, false, acc.createdAt);
  }

  /**
   * Serialise and deliver a batch of events as a single `stream_update_batch`
   * frame.  Applies the same backpressure path as an unbatched frame.
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
   *   (`maxSize`) and the payload sizes deduped upstream. If the resulting JSON
   *   would exceed `MAX_MESSAGE_BYTES`, the frame is silently truncated to the
   *   largest sub-array that fits (events are still delivered in order; the
   *   remainder is discarded rather than silently dropped from dedup — the
   *   dedup cache already recorded each eventId so they will not be
   *   re-delivered by a future broadcast).
   */
  private send(
    ws: WebSocket,
    streamId: string,
    events: BatchedEvent[],
    earlyFlush: boolean,
    createdAt: number
  ): void {
    if (events.length === 0) return;

    recordWsBroadcastBatchFlushLatency((Date.now() - createdAt) / 1000);

    if (ws.readyState !== WebSocket.OPEN) return;

    const frame = (subset: BatchedEvent[]) =>
      JSON.stringify({
        type: 'stream_update_batch',
        streamId,
        events: subset.map(({ eventId, payload, correlationId }) => ({
          eventId,
          payload,
          ...(correlationId !== undefined ? { correlationId } : {}),
        })),
      });

    // Trim to MAX_MESSAGE_BYTES safety cap (in-order, keep first N events).
    let safeEvents = events;
    if (Buffer.byteLength(frame(events), 'utf8') > MAX_MESSAGE_BYTES) {
      // Binary-search for the largest safe prefix.
      let lo = 1;
      let hi = events.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(frame(events.slice(0, mid)), 'utf8') <= MAX_MESSAGE_BYTES) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      safeEvents = events.slice(0, lo);
    }

    if (safeEvents.length === 0) return;

    if (!this.deliver(ws, frame(safeEvents), safeEvents.length)) return;

    // Update Prometheus batch counters.
    wsBatchFlushTotal.inc();
    wsBatchEventsCoalescedTotal.inc(safeEvents.length);
    if (earlyFlush) wsBatchSizeExceededTotal.inc();
  }

  /** Cancel and drop every pending accumulator for one connection. */
  clearConnection(connectionId: string): void {
    for (const [key, acc] of this.accumulators) {
      if (key.startsWith(`${connectionId}:`)) {
        clearTimeout(acc.timer);
        this.accumulators.delete(key);
      }
    }
  }

  /** Cancel and drop every pending accumulator (disconnect, shutdown, tests). */
  clearAll(): void {
    for (const acc of this.accumulators.values()) {
      clearTimeout(acc.timer);
    }
    this.accumulators.clear();
  }
}
