/**
 * Stabilization tests for WebSocket backpressure metrics (#1049).
 *
 * Locks down edge cases previously implicit: micro-batching counter increments,
 * hub with partial or absent optional methods, and recordWsBroadcastBatchFlushLatency
 * edge values.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectWsBackpressureMetrics,
  removeWsClientBackpressureGauge,
  resetWsBackpressureMetrics,
  wsClientBufferedBytes,
  wsBatchFlushTotal,
  wsBatchEventsCoalescedTotal,
  wsBatchSizeExceededTotal,
  recordWsBroadcastBatchFlushLatency,
  wsBroadcastBatchFlushLatencySeconds,
  DEFAULT_WS_SLOW_CLIENT_BYTES,
  DEFAULT_WS_BACKPRESSURE_INTERVAL_MS,
  DEFAULT_WS_STREAM_CARDINALITY_TOP_N,
} from '../../src/metrics/wsBackpressure.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHub = any;

async function readCounter(gauge: typeof wsBatchFlushTotal): Promise<number> {
  const result = (await gauge.get()) as { values: Array<{ value: number }> };
  return result.values[0]?.value ?? 0;
}

async function readHistogramCount(histogram: typeof wsBroadcastBatchFlushLatencySeconds): Promise<number> {
  const result = (await histogram.get()) as { values: Array<{ metricName: string; value: number }> };
  return result.values.find((v) => v.metricName.endsWith('_count'))?.value ?? 0;
}

describe('WebSocket Backpressure Stabilization (#1049)', () => {
  beforeEach(() => {
    resetWsBackpressureMetrics();
  });

  describe('hub with partial optional methods', () => {
    it('handles hub with _getClients() returning undefined (no clients method at all)', () => {
      const hub = {};
      expect(() => collectWsBackpressureMetrics(hub)).not.toThrow();
    });

    it('handles hub with _getStreamSubscriptions() returning undefined', () => {
      const hub = { _getClients: function* () {} };
      expect(() => collectWsBackpressureMetrics(hub)).not.toThrow();
    });

    it('handles hub with clients but without stream subscriptions', () => {
      const clientIterator = (function* () {
        yield [{ readyState: 1, bufferedAmount: 500 }, { id: 'conn-0' }];
      })();
      const hub = { _getClients: () => clientIterator };
      expect(() => collectWsBackpressureMetrics(hub)).not.toThrow();
    });

    it('handles hub with stream subscriptions but without clients', () => {
      const subs = new Map<string, Set<unknown>>();
      subs.set('stream-A', new Set([{ readyState: 1, bufferedAmount: 0 }]));
      const hub = { _getStreamSubscriptions: () => subs };
      expect(() => collectWsBackpressureMetrics(hub)).not.toThrow();
    });
  });

  describe('micro-batching counters', () => {
    it('wsBatchFlushTotal increments via manual observe (simulating hub.ts calls)', async () => {
      wsBatchFlushTotal.inc();
      wsBatchFlushTotal.inc();
      const val = await readCounter(wsBatchFlushTotal);
      expect(val).toBe(2);
    });

    it('wsBatchEventsCoalescedTotal increments correctly', async () => {
      wsBatchEventsCoalescedTotal.inc(10);
      wsBatchEventsCoalescedTotal.inc(5);
      const val = await readCounter(wsBatchEventsCoalescedTotal);
      expect(val).toBe(15);
    });

    it('wsBatchSizeExceededTotal increments correctly', async () => {
      wsBatchSizeExceededTotal.inc();
      wsBatchSizeExceededTotal.inc();
      wsBatchSizeExceededTotal.inc();
      const val = await readCounter(wsBatchSizeExceededTotal);
      expect(val).toBe(3);
    });

    it('all three counters are independently tracked', async () => {
      wsBatchFlushTotal.inc();
      wsBatchEventsCoalescedTotal.inc(7);
      wsBatchSizeExceededTotal.inc();

      const [flush, coalesced, exceeded] = await Promise.all([
        readCounter(wsBatchFlushTotal),
        readCounter(wsBatchEventsCoalescedTotal),
        readCounter(wsBatchSizeExceededTotal),
      ]);
      expect(flush).toBe(1);
      expect(coalesced).toBe(7);
      expect(exceeded).toBe(1);
    });
  });

  describe('recordWsBroadcastBatchFlushLatency edge cases', () => {
    beforeEach(() => {
      wsBroadcastBatchFlushLatencySeconds.reset();
    });

    it('ignores negative duration', async () => {
      recordWsBroadcastBatchFlushLatency(-1);
      expect(await readHistogramCount(wsBroadcastBatchFlushLatencySeconds)).toBe(0);
    });

    it('ignores NaN duration', async () => {
      recordWsBroadcastBatchFlushLatency(NaN);
      expect(await readHistogramCount(wsBroadcastBatchFlushLatencySeconds)).toBe(0);
    });

    it('ignores Infinity duration', async () => {
      recordWsBroadcastBatchFlushLatency(Infinity);
      expect(await readHistogramCount(wsBroadcastBatchFlushLatencySeconds)).toBe(0);
    });

    it('records zero latency as valid', async () => {
      recordWsBroadcastBatchFlushLatency(0);
      expect(await readHistogramCount(wsBroadcastBatchFlushLatencySeconds)).toBe(1);
    });
  });

  describe('default constants', () => {
    it('DEFAULT_WS_SLOW_CLIENT_BYTES is 1 MiB', () => {
      expect(DEFAULT_WS_SLOW_CLIENT_BYTES).toBe(1 * 1024 * 1024);
    });

    it('DEFAULT_WS_BACKPRESSURE_INTERVAL_MS is 5000', () => {
      expect(DEFAULT_WS_BACKPRESSURE_INTERVAL_MS).toBe(5_000);
    });

    it('DEFAULT_WS_STREAM_CARDINALITY_TOP_N is 20', () => {
      expect(DEFAULT_WS_STREAM_CARDINALITY_TOP_N).toBe(20);
    });
  });
});
