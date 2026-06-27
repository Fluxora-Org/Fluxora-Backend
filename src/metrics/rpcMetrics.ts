import { Counter } from 'prom-client';
import { registry } from '../metrics.js';

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
  registry.removeSingleMetric('rpc_circuit_open_fallback_hits_total');
  registry.removeSingleMetric('rpc_circuit_open_fallback_misses_total');
  registry.removeSingleMetric('rpc_fallback_cache_hits_total');
  registry.removeSingleMetric('rpc_fallback_cache_misses_total');
  registry.removeSingleMetric('rpc_fallback_cache_early_refreshes_total');
  registry.removeSingleMetric('fluxora_rpc_cache_corrupt_total');
}

