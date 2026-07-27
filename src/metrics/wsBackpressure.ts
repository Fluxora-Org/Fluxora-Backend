/**
 * src/metrics/wsBackpressure.ts
 *
 * Per-client WebSocket backpressure gauges, subscription cardinality
 * metrics, and micro-batching counters exposed to Prometheus.
 *
 * Four metrics are emitted for live WebSocket subscribers on the
 * `/ws/streams` endpoint:
 *
 *   - `fluxora_ws_backpressure_buffered_bytes{connection_id="…"}` — current
 *     `ws.bufferedAmount` per client, useful for finding a specific slow
 *     peer.  This is the primary, bounded-cardinality gauge required by the
 *     per-client observability feature.
 *   - `fluxora_ws_max_buffered_bytes`     — max bufferedAmount across all
 *     live clients (low cardinality, suitable for dashboards/alerts).
 *   - `fluxora_ws_slow_clients`           — count of clients whose buffered
 *     bytes exceed the configurable warning threshold (default 1 MiB).
 *   - `fluxora_ws_stream_subscriber_count{stream_id="…"}` — subscriber
 *     count for the top-N streams by fan-out size (default N=20). Reports
 *     only the most-subscribed streams so operators can spot a single hot
 *     stream driving disproportionate broadcast fan-out before it causes
 *     backpressure incidents.
 *
 * ### Micro-batching counters (three series)
 *
 *   - `fluxora_ws_batch_flush_total`         — total flush operations (each
 *     flush produces one outbound `stream_update_batch` frame per client).
 *   - `fluxora_ws_batch_events_coalesced_total` — total individual events
 *     that were coalesced across all flushes.  Comparing this to
 *     `fluxora_ws_batch_flush_total` gives the average batch size.
 *   - `fluxora_ws_batch_size_exceeded_total` — flushes where the batch hit
 *     `WS_BATCH_MAX_SIZE` before the flush window expired (early ejection).
 *
 * ### Edge-case behaviours
 *
 *   - **Empty client set**: when no clients are connected,
 *     `_getClients()` returns an empty iterator, and aggregate gauges
 *     (`wsMaxBufferedBytes`, `wsSlowClients`) are left at 0. The per-client
 *     gauge retains prior label series until `removeWsClientBackpressureGauge`
 *     or `resetWsBackpressureMetrics` is called.
 *   - **Non-OPEN sockets**: clients whose `readyState !== 1` (OPEN) are
 *     silently skipped — their bufferedAmount is not recorded. This prevents
 *     stale readings from closing/closed sockets that are still in the client
 *     map during a race between `onDisconnect` cleanup and the poll timer.
 *   - **`undefined` bufferedAmount**: if a socket's `bufferedAmount` property
 *     is not a number (defensive fallback), the value is treated as 0 rather
 *     than throwing. This covers mocked or polyfilled WebSocket instances.
 *   - **Slow-threshold underflow**: a `slowThresholdBytes` of 0 or negative
 *     classifies every connected client as "slow". The default (1 MiB) aligns
 *     with `BACKPRESSURE_DROP_BYTES`; callers that pass an explicit lower
 *     threshold must ensure it does not trigger excessive alerts on normal
 *     traffic.
 *   - **Zero-subscriber streams**: streams with an empty subscriber Set are
 *     still included in the sorted output (`set.size === 0`). They appear in
 *     the gauge when they rank within top-N, which can happen if the hub has
 *     zero total subscribers but one or more empty stream entries.
 *   - **Top-N tie-breaking**: streams with identical subscriber counts are
 *     ordered by `stream_id` lexicographically (via `localeCompare`). This
 *     guarantees stable sort output across consecutive collection cycles so
 *     the gauge does not flap between streams of equal weight.
 *   - **Stale series cleanup**: `wsStreamSubscriberCount.reset()` is called
 *     at the start of each collection cycle. Streams that drop out of the
 *     top-N have their time-series removed by the `reset()` call before only
 *     the current top-N entries are re-set. This prevents unbounded label
 *     cardinality over time.
 *   - **Early-flush vs timer-flush**: the `wsBatchSizeExceededTotal` counter
 *     distinguishes early (size-triggered) flushes from window-timer flushes.
 *     An early flush also increments `wsBatchFlushTotal` and
 *     `wsBatchEventsCoalescedTotal` normally.
 *   - **Latency with negative durations**: `recordWsBroadcastBatchFlushLatency`
 *     silently discards negative `durationSeconds` values to prevent clock-skew
 *     or race-condition values from corrupting the histogram.
 *
 * The per-client gauge is updated by a poll loop so the value reflects the
 * actual kernel/OS send-buffer state, not just the snapshot taken during a
 * `deliverBatch` call.  Series for disconnected clients are explicitly removed
 * via `removeWsClientBackpressureGauge` to prevent unbounded label
 * accumulation.  See `docs/observability.md` for the labeling-choice rationale
 * and bounded-cardinality guarantee.
 */

import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';
import type { StreamHub } from '../ws/hub.js';

/**
 * Default warning threshold for "slow client" classification.
 * Mirrors `BACKPRESSURE_DROP_BYTES` in `src/ws/hub.ts` (1 MiB) by default,
 * but can be overridden via `startWsBackpressureCollector` to e.g. trigger
 * before the hub actively drops frames.
 */
export const DEFAULT_WS_SLOW_CLIENT_BYTES = 1 * 1024 * 1024;

/**
 * Default poll interval for the backpressure collector. Five seconds is a
 * reasonable balance between metric freshness and CPU churn when there are
 * many concurrent connections — Prometheus typically scrapes every 15s, so
 * 5s-poll values are always at most one poll-stale in the worst case.
 */
export const DEFAULT_WS_BACKPRESSURE_INTERVAL_MS = 5_000;

export const DEFAULT_WS_STREAM_CARDINALITY_TOP_N = 20;

/**
 * Histogram tracking the age of the oldest event in a batch when flushed.
 * Buckets are tuned specifically for sub-second to low-second micro-batching windows.
 */
export const wsBroadcastBatchFlushLatencySeconds =
  (registry.getSingleMetric('fluxora_ws_broadcast_batch_flush_seconds') as Histogram) ||
  new Histogram({
    name: 'fluxora_ws_broadcast_batch_flush_seconds',
    help: 'Latency (in seconds) from the oldest event enqueued to the moment the batch is flushed to WebSockets.',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
    registers: [registry],
  });

/**
 * Helper to record batch flush latency in seconds.
 */
export function recordWsBroadcastBatchFlushLatency(durationSeconds: number): void {
  if (durationSeconds >= 0) {
    wsBroadcastBatchFlushLatencySeconds.observe(durationSeconds);
  }
}

// ── Per-client backpressure gauge ─────────────────────────────────────────

/** @security connection_id is a server-generated UUID v4 — never PII or user input. */
export const wsClientBufferedBytes =
  (registry.getSingleMetric('fluxora_ws_backpressure_buffered_bytes') as Gauge<'connection_id'>) ||
  new Gauge<'connection_id'>({
    name: 'fluxora_ws_backpressure_buffered_bytes',
    help: 'Current bufferedAmount per WebSocket connection.',
    labelNames: ['connection_id'] as const,
    registers: [registry],
  });

export const wsMaxBufferedBytes =
  (registry.getSingleMetric('fluxora_ws_max_buffered_bytes') as Gauge) ||
  new Gauge({
    name: 'fluxora_ws_max_buffered_bytes',
    help: 'Maximum bufferedAmount across all connected WebSocket clients.',
    registers: [registry],
  });

export const wsSlowClients =
  (registry.getSingleMetric('fluxora_ws_slow_clients') as Gauge) ||
  new Gauge({
    name: 'fluxora_ws_slow_clients',
    help: 'Number of WebSocket clients whose bufferedAmount exceeds the slow threshold.',
    registers: [registry],
  });

// ── Subscription cardinality gauge ────────────────────────────────────────

export const wsStreamSubscriberCount =
  (registry.getSingleMetric('fluxora_ws_stream_subscriber_count') as Gauge<'stream_id'>) ||
  new Gauge<'stream_id'>({
    name: 'fluxora_ws_stream_subscriber_count',
    help: 'Number of subscribers per stream (top-N capped).',
    labelNames: ['stream_id'] as const,
    registers: [registry],
  });

// ── Batch flush counters ──────────────────────────────────────────────────

export const wsBatchFlushTotal =
  (registry.getSingleMetric('fluxora_ws_batch_flush_total') as Counter) ||
  new Counter({
    name: 'fluxora_ws_batch_flush_total',
    help: 'Total number of batch flushes (one frame emitted per flush).',
    registers: [registry],
  });

export const wsBatchEventsCoalescedTotal =
  (registry.getSingleMetric('fluxora_ws_batch_events_coalesced_total') as Counter) ||
  new Counter({
    name: 'fluxora_ws_batch_events_coalesced_total',
    help: 'Total number of individual events coalesced across all batch flushes.',
    registers: [registry],
  });

export const wsBatchSizeExceededTotal =
  (registry.getSingleMetric('fluxora_ws_batch_size_exceeded_total') as Counter) ||
  new Counter({
    name: 'fluxora_ws_batch_size_exceeded_total',
    help: 'Number of batch flushes triggered early by hitting the max-size cap.',
    registers: [registry],
  });

// ── Collection ────────────────────────────────────────────────────────────

export function collectWsBackpressureMetrics(
  hub: {
    _getClients?: () => IterableIterator<[unknown, { id: string }]>;
    _getStreamSubscriptions?: () => ReadonlyMap<string, Set<unknown>>;
  },
  slowThresholdBytes: number = DEFAULT_WS_SLOW_CLIENT_BYTES,
  topN: number = DEFAULT_WS_STREAM_CARDINALITY_TOP_N,
): void {
  const clientIterator = hub._getClients?.();
  if (clientIterator) {
    let max = 0;
    let slowCount = 0;

    for (const [ws, state] of clientIterator) {
      const socket = ws as { readyState?: number; bufferedAmount?: number };
      if (socket.readyState !== 1) continue;

      const ba = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
      wsClientBufferedBytes.set({ connection_id: state.id }, ba);

      if (ba > max) max = ba;
      if (ba > slowThresholdBytes) slowCount++;
    }

    wsMaxBufferedBytes.set(max);
    wsSlowClients.set(slowCount);
  }

  const streamSubs = hub._getStreamSubscriptions?.();
  if (streamSubs) {
    const sorted = Array.from(streamSubs.entries())
      .map(([id, set]) => [id, set.size] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN);

    wsStreamSubscriberCount.reset();
    for (const [id, count] of sorted) {
      wsStreamSubscriberCount.set({ stream_id: id }, count);
    }
  }
}

export function removeWsClientBackpressureGauge(connectionId: string): void {
  wsClientBufferedBytes.remove({ connection_id: connectionId });
}

export function resetWsBackpressureMetrics(): void {
  wsClientBufferedBytes.reset();
  wsMaxBufferedBytes.reset();
  wsSlowClients.reset();
  wsStreamSubscriberCount.reset();
}
