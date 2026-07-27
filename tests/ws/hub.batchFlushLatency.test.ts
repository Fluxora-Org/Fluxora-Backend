import { describe, it, expect, beforeEach } from 'vitest';
import { wsBroadcastBatchFlushLatencySeconds, recordWsBroadcastBatchFlushLatency } from '../../src/metrics/wsBackpressure';

describe('StreamHub Batch Flush Latency Metric', () => {
  beforeEach(() => {
    wsBroadcastBatchFlushLatencySeconds.reset();
  });

  it('records flush latency in the fluxora_ws_broadcast_batch_flush_seconds histogram', async () => {
    const initialMetric = await wsBroadcastBatchFlushLatencySeconds.get();
    const initialCount = initialMetric.values.find((v) => v.metricName.endsWith('_count'))?.value ?? 0;

    // Simulate batch flush latency recording 15ms (0.015s)
    recordWsBroadcastBatchFlushLatency(0.015);

    const updatedMetric = await wsBroadcastBatchFlushLatencySeconds.get();
    const updatedCount = updatedMetric.values.find((v) => v.metricName.endsWith('_count'))?.value ?? 0;

    expect(updatedCount).toBe(initialCount + 1);
  });

  it('ignores negative latency values safely', async () => {
    recordWsBroadcastBatchFlushLatency(-0.01);

    const metric = await wsBroadcastBatchFlushLatencySeconds.get();
    const count = metric.values.find((v) => v.metricName.endsWith('_count'))?.value ?? 0;

    expect(count).toBe(0);
  });
});
