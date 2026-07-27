import { Gauge } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Gauge tracking active WebSocket connections vs configured maximum.
 *
 * Updated atomically whenever connection count changes (checkAndReserve,
 * untrackConnection). Allows operators to alert when approaching capacity.
 */
export const wsActiveConnectionsGauge = new Gauge({
  name: 'websocket_active_connections',
  help: 'Current number of active WebSocket connections',
  registers: [registry],
});

/**
 * Gauge tracking configured maximum connections per IP.
 *
 * Read from WS_MAX_CONNECTIONS_PER_IP env var (default 10).
 * Set once at startup, updated if env changes.
 */
export const wsMaxConnectionsPerIpGauge = new Gauge({
  name: 'websocket_max_connections_per_ip',
  help: 'Configured maximum WebSocket connections allowed per IP address',
  registers: [registry],
});

/**
 * Update the max connections gauge from env var.
 * Called at startup and whenever env might change.
 */
export function updateMaxConnectionsGauge(): void {
  const maxConnections = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '10', 10);
  wsMaxConnectionsPerIpGauge.set(maxConnections);
}
