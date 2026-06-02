import { Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';

export const heapUsedBytes = new Gauge({
  name: 'fluxora_nodejs_heap_used_bytes',
  help: 'Node.js heap used size in bytes',
  registers: [registry],
});

export const heapTotalBytes = new Gauge({
  name: 'fluxora_nodejs_heap_total_bytes',
  help: 'Node.js heap total size in bytes',
  registers: [registry],
});

export const externalBytes = new Gauge({
  name: 'fluxora_nodejs_external_bytes',
  help: 'Node.js external memory size in bytes',
  registers: [registry],
});

export const eventLoopLagSeconds = new Histogram({
  name: 'fluxora_nodejs_event_loop_lag_seconds',
  help: 'Node.js event loop lag in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

let intervalTimer: NodeJS.Timeout | null = null;
let lastCheckTime: number = 0;

/**
 * Starts the runtime metrics collector to periodically sample
 * heap memory usage and event-loop lag.
 *
 * @param intervalMs The sampling interval in milliseconds (defaults to METRICS_SAMPLE_INTERVAL_MS or 10000).
 */
export function startRuntimeMetrics(
  intervalMs = Number(process.env['METRICS_SAMPLE_INTERVAL_MS']) || 10000
): void {
  if (intervalTimer) {
    return; // Already running
  }

  logger.info('Starting runtime metrics collector', undefined, { intervalMs });

  lastCheckTime = process.uptime() * 1000;

  intervalTimer = setInterval(() => {
    try {
      // Memory metrics
      const memUsage = process.memoryUsage();
      heapUsedBytes.set(memUsage.heapUsed);
      heapTotalBytes.set(memUsage.heapTotal);
      externalBytes.set(memUsage.external);

      // Event loop lag
      const now = process.uptime() * 1000;
      const elapsed = now - lastCheckTime;
      const lagMs = Math.max(0, elapsed - intervalMs);
      const lagSeconds = lagMs / 1000;
      
      eventLoopLagSeconds.observe(lagSeconds);

      lastCheckTime = now;
    } catch (err) {
      logger.error('Error collecting runtime metrics', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);

  // Allow the process to exit even if the timer is still active
  intervalTimer.unref();
}

/**
 * Stops the runtime metrics collector.
 */
export function stopRuntimeMetrics(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
    logger.info('Stopped runtime metrics collector');
  }
}
