import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

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


/**
 * Total requests rejected by the rate limiter with a 429 response.
 * Labels: identifier_type ('ip' | 'apiKey'), route (path or 'global').
 */
export const rateLimitRejectedTotal = new Counter({
  name: 'rate_limit_rejected_total',
  help: 'Total requests rejected by the rate limiter (HTTP 429)',
  labelNames: ['identifier_type', 'route'] as const,
  registers: [registry],
});


/**
 * Total Redis errors that triggered rate-limit fallback to in-memory store.
 * Labels: operation ('increment' | 'getCount').
 */
export const rateLimitRedisErrorsTotal = new Counter({
  name: 'rate_limit_redis_errors_total',
  help: 'Total Redis errors that triggered rate-limit fallback to in-memory store',
  labelNames: ['operation'] as const,
  registers: [registry],
});


/**
 * Total Redis errors in dedup operations (has/add).
 * Labels: operation ('has' | 'add').
 * No eventId/streamId labels — bounded cardinality, zero PII.
 */
export const dedupRedisErrorsTotal =
  (registry.getSingleMetric('dedup_redis_errors_total') as Counter<'operation'>) ||
  new Counter({
    name: 'dedup_redis_errors_total',
    help: 'Total Redis errors in dedup has/add operations',
    labelNames: ['operation'] as const,
    registers: [registry],
  });


/**
 * Total times HybridDedupCache fell back to in-memory because Redis was degraded.
 * Labels: operation ('has' | 'add').
 * No eventId/streamId labels — bounded cardinality, zero PII.
 */
export const dedupRedisFallbackTotal =
  (registry.getSingleMetric('dedup_redis_fallback_total') as Counter<'operation'>) ||
  new Counter({
    name: 'dedup_redis_fallback_total',
    help: 'Total HybridDedupCache fallback activations when Redis is degraded',
    labelNames: ['operation'] as const,
    registers: [registry],
  });


/**
 * Current number of active IP bans in the InMemoryBanStore.
 * Updated on every ban/unban operation via setActiveBansCount().
 */
export const banStoreActiveBans: Gauge =
  (registry.getSingleMetric('fluxora_ban_store_active_bans') as Gauge) ||
  new Gauge({
    name: 'fluxora_ban_store_active_bans',
    help: 'Current number of active bans in the InMemoryBanStore',
    registers: [registry],
  });

export function setActiveBansCount(count: number): void {
  banStoreActiveBans.set(count);
}

/**
 * Total SIGHUP / hot-config refresh attempts.
 * Labels:
 *   result — 'success' | 'failure' | 'noop' (success with no field changes)
 * Bounded cardinality; never labels secret values or env contents.
 */
export const configReloadTotal: Counter<'result'> =
  (registry.getSingleMetric('fluxora_config_reload_total') as Counter<'result'>) ||
  new Counter({
    name: 'fluxora_config_reload_total',
    help: 'Total hot-config reload attempts via SIGHUP / refreshHotConfig',
    labelNames: ['result'] as const,
    registers: [registry],
  });

/**
 * Duration of hot-config refresh cycles in seconds.
 */
export const configReloadDurationSeconds: Histogram =
  (registry.getSingleMetric('fluxora_config_reload_duration_seconds') as Histogram) ||
  new Histogram({
    name: 'fluxora_config_reload_duration_seconds',
    help: 'Duration of hot-config reload cycles in seconds',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });


/**
 * Monotonic generation of the last successfully applied HotConfig.
 * Useful for verifying deploys/retries converge on the same generation.
 */
export const configReloadGeneration: Gauge =
  (registry.getSingleMetric('fluxora_config_reload_generation') as Gauge) ||
  new Gauge({
    name: 'fluxora_config_reload_generation',
    help: 'Generation counter of the last successfully applied hot config',
    registers: [registry],
  });

/** Record a successful (or noop) config reload for observability. */
export function recordConfigReloadSuccess(opts: {
  changed: boolean;
  durationMs: number;
  generation: number;
}): void {
  configReloadTotal.inc({ result: opts.changed ? 'success' : 'noop' });
  configReloadDurationSeconds.observe(opts.durationMs / 1000);
  configReloadGeneration.set(opts.generation);
}


/** Record a failed config reload for observability. */
export function recordConfigReloadFailure(durationMs: number): void {
  configReloadTotal.inc({ result: 'failure' });
  configReloadDurationSeconds.observe(durationMs / 1000);
}
