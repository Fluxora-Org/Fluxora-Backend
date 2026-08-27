import { Gauge } from 'prom-client';
import { registry } from '../metrics.js';

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
      help: 'Total number of healthy vs unhealthy WebSocket connections.',
      labelNames: ['status'],
      registers: [registry],
    }),
);

export function updateWsHealthMetrics(healthyCount: number, unhealthyCount: number): void {
  wsConnectionHealthTotal.set({ status: 'healthy' }, healthyCount);
  wsConnectionHealthTotal.set({ status: 'unhealthy' }, unhealthyCount);
}

export function resetWsHealthMetrics(): void {
  wsConnectionHealthTotal.reset();
}
