import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

/** Dedicated registry so default Node.js metrics don't leak into other registries. */
export const registry = new Registry();

registry.setDefaultLabels({ service: 'fluxora-backend' });

collectDefaultMetrics({ register: registry });

/**
 * Total HTTP requests received, partitioned by method, route, and status code.
 * Operators can alert on error-rate spikes (5xx) or track traffic distribution.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

/**
 * HTTP request duration in seconds.
 * Buckets are tuned for a typical API service — most responses under 300 ms,
 * with wider buckets to catch slow outliers.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
