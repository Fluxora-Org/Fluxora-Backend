import { Gauge } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Closed set of connection-health status values.
 *
 * The label cardinality is therefore fixed at three — `healthy`, `stalled`,
 * and `unhealthy` — regardless of how many connections churn through the
 * process. No connection identifier, IP, or JWT subject is ever used as a
 * label, so the metric can never grow unboundedly.
 */
export type WsConnectionHealthStatus = 'healthy' | 'stalled' | 'unhealthy';

function metric<T>(name: string, factory: () => T): T {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as unknown as T;
  return factory();
}

export const wsConnectionHealthTotal = metric(
  'fluxora_ws_connection_health_total',
  () =>
    new Gauge({
      name: 'fluxora_ws_connection_health_total',
      help:
        'Number of WebSocket connections by health status. ' +
        'healthy = OPEN and draining; ' +
        'stalled = OPEN but outbound queue saturated above the stall threshold ' +
        '(frames buffering faster than the peer drains them); ' +
        'unhealthy = missed heartbeat pongs and being terminated. ' +
        'Alert when status="stalled" is non-zero for 2 minutes.',
      labelNames: ['status'],
      registers: [registry],
    }),
);

/**
 * Publish the current per-status connection counts.
 *
 * @param healthyCount   OPEN connections that are draining normally.
 * @param unhealthyCount Connections that missed the heartbeat pong budget and
 *                       are being terminated by the health probe.
 * @param stalledCount   OPEN connections whose outbound `bufferedAmount`
 *                       exceeds the stall threshold — an open socket here is
 *                       NOT healthy, so it must be reported as `stalled`
 *                       rather than folded into `healthy`.
 *
 * ### Alert threshold
 * Page on `fluxora_ws_connection_health_total{status="stalled"} > 0` sustained
 * for **2 minutes**. A single stalled connection longer than a heartbeat
 * interval indicates the peer stopped draining its outbound queue; the hub
 * will begin dropping frames once the backpressure drop threshold is crossed.
 */
export function updateWsHealthMetrics(
  healthyCount: number,
  unhealthyCount: number,
  stalledCount = 0,
): void {
  wsConnectionHealthTotal.set({ status: 'healthy' }, healthyCount);
  wsConnectionHealthTotal.set({ status: 'unhealthy' }, unhealthyCount);
  wsConnectionHealthTotal.set({ status: 'stalled' }, stalledCount);
}

export function resetWsHealthMetrics(): void {
  wsConnectionHealthTotal.reset();
}
