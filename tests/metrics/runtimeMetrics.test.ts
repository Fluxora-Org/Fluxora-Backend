import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  heapUsedBytes,
  heapTotalBytes,
  externalBytes,
  eventLoopLagSeconds,
  startRuntimeMetrics,
  stopRuntimeMetrics,
} from '../../src/metrics/runtimeMetrics.js';

describe('Runtime Metrics Collector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 100000,
      heapTotal: 200000,
      heapUsed: 150000,
      external: 50000,
      arrayBuffers: 10000,
    });
    
    // Clear metrics values before each test
    heapUsedBytes.reset();
    heapTotalBytes.reset();
    externalBytes.reset();
    eventLoopLagSeconds.reset();
  });

  afterEach(() => {
    stopRuntimeMetrics();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts the collector and records metrics on interval', async () => {
    startRuntimeMetrics(1000);
    
    // Fast forward one interval
    vi.advanceTimersByTime(1000);
    
    const usedVal = await heapUsedBytes.get();
    expect(usedVal.values).toHaveLength(1);
    expect(usedVal.values[0]?.value).toBe(150000);

    const totalVal = await heapTotalBytes.get();
    expect(totalVal.values).toHaveLength(1);
    expect(totalVal.values[0]?.value).toBe(200000);

    const externalVal = await externalBytes.get();
    expect(externalVal.values).toHaveLength(1);
    expect(externalVal.values[0]?.value).toBe(50000);

    const lagVal = await eventLoopLagSeconds.get();
    expect(lagVal.values.length).toBeGreaterThan(0);
  });

  it('measures event loop lag correctly', async () => {
    // Mock process.uptime to simulate time passing
    let currentUptime = 0;
    vi.spyOn(process, 'uptime').mockImplementation(() => currentUptime);

    startRuntimeMetrics(1000);

    // Simulate 1000ms expected interval + 500ms lag
    currentUptime = 1.5; 
    
    vi.advanceTimersByTime(1000);

    const lagVal = await eventLoopLagSeconds.get();
    // In prom-client, Histogram get() returns an object with `values` containing bucket counts and `sum`
    const sumValue = lagVal.values.find((v) => v.metricName === 'fluxora_nodejs_event_loop_lag_seconds_sum');
    expect(sumValue?.value).toBeCloseTo(0.5);
  });

  it('stops the collector and clears interval', async () => {
    startRuntimeMetrics(1000);
    stopRuntimeMetrics();

    // Fast forward one interval
    vi.advanceTimersByTime(1000);

    // Metrics should not be updated since it's stopped
    const usedVal = await heapUsedBytes.get();
    expect(usedVal.values[0]?.value).toBe(0);
  });

  it('handles start being called multiple times gracefully', async () => {
    startRuntimeMetrics(1000);
    startRuntimeMetrics(500); // Should be ignored
    
    vi.advanceTimersByTime(1000);
    
    const usedVal = await heapUsedBytes.get();
    expect(usedVal.values).toHaveLength(1);
  });
});
