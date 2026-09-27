import { Counter } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Counter for observed entry into and exit from RPC degradation mode.
 *
 * Incremented by `rpcDegradationMiddleware` each time the circuit-breaker
 * state it observes changes between requests. `from` is the previous state
 * and `to` the new one, so `{from="CLOSED",to="OPEN"}` counts entries into
 * degradation and `{from="OPEN",to="CLOSED"}` counts automatic recoveries.
 */
export const rpcDegradationTransitionsTotal =
  (registry.getSingleMetric('rpc_degradation_transitions_total') as Counter<'from' | 'to'>) ||
  new Counter({
    name: 'rpc_degradation_transitions_total',
    help: 'Total Stellar RPC degradation-mode transitions observed by the HTTP degradation middleware',
    labelNames: ['from', 'to'] as const,
    registers: [registry],
  });

export const rpcCircuitOpenFallbackHitsTotal =
  (registry.getSingleMetric('rpc_circuit_open_fallback_hits_total') as Counter<'operation'>) ||
  new Counter({
    name: 'rpc_circuit_open_fallback_hits_total',
    help: 'Total Stellar RPC calls served from last-known-good cache while the circuit breaker is OPEN',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

export const rpcCircuitOpenFallbackMissesTotal =
  (registry.getSingleMetric('rpc_circuit_open_fallback_misses_total') as Counter<'operation'>) ||
  new Counter({
    name: 'rpc_circuit_open_fallback_misses_total',
    help: 'Total Stellar RPC calls that missed last-known-good cache while the circuit breaker is OPEN',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

export const rpcFallbackCacheExhaustedTotal =
  (registry.getSingleMetric('rpc_fallback_cache_exhausted_total') as Counter<'operation'>) ||
  new Counter({
    name: 'rpc_fallback_cache_exhausted_total',
    help: 'Total Stellar RPC calls refused because the last-known-good cache entry exceeded the maximum fallback age',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

export const rpcFallbackCacheHitsTotal =
  (registry.getSingleMetric('rpc_fallback_cache_hits_total') as Counter<'operation'>) ||
  new Counter({
    name: 'rpc_fallback_cache_hits_total',
    help: 'Total Stellar RPC calls served from the Redis fallback cache while the circuit breaker is CLOSED',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

export const rpcFallbackCacheMissesTotal =
  (registry.getSingleMetric('rpc_fallback_cache_misses_total') as Counter<'operation'>) ||
  new Counter({
    name: 'rpc_fallback_cache_misses_total',
    help: 'Total Stellar RPC calls that missed the Redis fallback cache while the circuit breaker is CLOSED',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

export const rpcFallbackCacheEarlyRefreshesTotal =
  (registry.getSingleMetric('rpc_fallback_cache_early_refreshes_total') as Counter<'operation'>) ||
  new Counter({
    name: 'rpc_fallback_cache_early_refreshes_total',
    help: 'Total probabilistic early refreshes started for Stellar RPC fallback cache entries',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

import { Gauge } from 'prom-client';

/**
 * Gauge (0 or 1) exposing whether the backend is currently serving in RPC
 * degradation mode: 1 = degraded (circuit breaker not CLOSED), 0 = healthy.
 *
 * Set by `rpcDegradationMiddleware` on every request so dashboards and alerts
 * can detect sustained degradation without polling the health endpoint.
 */
export const rpcDegradedModeGauge =
  (registry.getSingleMetric('rpc_degraded_mode') as Gauge) ||
  new Gauge({
    name: 'rpc_degraded_mode',
    help: 'Whether the backend is in Stellar RPC degradation mode (1 = degraded, 0 = healthy)',
    registers: [registry],
  });

/**
 * Gauge (0 or 1) reflecting the most recent provider health-check outcome.
 * 1 = healthy, 0 = unhealthy (consecutive health-check failures exceeded the
 * threshold). Lets dashboards/alerts surface provider degradation independent of
 * the circuit breaker (which only trips on call failures, not proactive pings).
 */
export const rpcProviderHealthyGauge =
  (registry.getSingleMetric('rpc_provider_healthy') as Gauge<'provider'>) ||
  new Gauge({
    name: 'rpc_provider_healthy',
    help: 'Stellar RPC provider health-check status (1 = healthy, 0 = unhealthy)',
    labelNames: ['provider'] as const,
    registers: [registry],
  });

/** Counter for background health-check failures. */
export const rpcProviderHealthCheckFailuresTotal =
  (registry.getSingleMetric('rpc_provider_health_check_failures_total') as Counter<'provider' | 'reason'>) ||
  new Counter({
    name: 'rpc_provider_health_check_failures_total',
    help: 'Total Stellar RPC background health-check failures',
    labelNames: ['provider', 'reason'] as const,
    registers: [registry],
  });

/**
 * Counter for cache corruption events (e.g., SyntaxError or invalid envelope shape).
 * Useful for alerting on cache poisoning or serialization regressions.
 */
export const fluxora_rpc_cache_corrupt_total =
  (registry.getSingleMetric('fluxora_rpc_cache_corrupt_total') as Counter<'operation' | 'reason'>) ||
  new Counter({
    name: 'fluxora_rpc_cache_corrupt_total',
    help: 'Total Stellar RPC calls that encountered corrupt data in the Redis fallback cache',
    labelNames: ['operation', 'reason'] as const,
    registers: [registry],
  });

export function deRegisterRpcMetrics(): void {
  registry.removeSingleMetric('rpc_degradation_transitions_total');
  registry.removeSingleMetric('rpc_degraded_mode');
  registry.removeSingleMetric('rpc_circuit_open_fallback_hits_total');
  registry.removeSingleMetric('rpc_circuit_open_fallback_misses_total');
  registry.removeSingleMetric('rpc_fallback_cache_hits_total');
  registry.removeSingleMetric('rpc_fallback_cache_misses_total');
  registry.removeSingleMetric('rpc_fallback_cache_early_refreshes_total');
  registry.removeSingleMetric('fluxora_rpc_cache_corrupt_total');
}

