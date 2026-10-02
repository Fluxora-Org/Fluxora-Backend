import { Counter, Histogram } from 'prom-client';
import { registry } from '../metrics.js';
import { assertCollectorLabels } from './cardinality.js';

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

/**
 * Bounded set of valid RPC call outcomes.
 * Labels cardinality: 2 series per operation.
 */
export const RPC_CALL_OUTCOMES = ['success', 'failure'] as const;
export type RpcCallOutcome = (typeof RPC_CALL_OUTCOMES)[number];

/**
 * Bounded set of RPC failure kinds recorded by rpcUpstreamCallsFailedTotal.
 * Mirrors RpcFailureKind from stellar-rpc.ts.
 * Labels cardinality: 5 series per operation.
 */
export const RPC_FAILURE_KINDS = [
  'TIMEOUT',
  'NETWORK',
  'PROVIDER',
  'CIRCUIT_OPEN',
  'CANCELLED',
] as const;
export type RpcFailureKindLabel = (typeof RPC_FAILURE_KINDS)[number];

/**
 * Total upstream Stellar RPC calls, partitioned by operation and outcome.
 *
 * Emitted on every call path (both success and failure) so operators can
 * compute per-operation error rates (failures / total) without relying on
 * metrics that only fire on one path.
 *
 * Labels (bounded cardinality):
 *   operation — static method name: "getLatestLedger", "accountExists", ...
 *               Controlled by the application, never user input.
 *   outcome   — "success" | "failure" (see RPC_CALL_OUTCOMES).
 *
 * Alert thresholds:
 *   Per-operation failure rate (rpc_upstream_calls_total{outcome="failure"} /
 *   rpc_upstream_calls_total):
 *     warn ≥ 5% over 5m
 *     page ≥ 20% over 5m
 */
assertCollectorLabels(['operation', 'outcome']);
export const rpcUpstreamCallsTotal =
  (registry.getSingleMetric('rpc_upstream_calls_total') as Counter<
    'operation' | 'outcome'
  >) ||
  new Counter({
    name: 'rpc_upstream_calls_total',
    help:
      'Total upstream Stellar RPC calls by operation and outcome (success/failure). ' +
      'Alert: per-operation failure rate warn >= 5%, page >= 20% over 5m.',
    labelNames: ['operation', 'outcome'] as const,
    registers: [registry],
  });

/**
 * Failed upstream Stellar RPC calls, partitioned by operation and failure kind.
 *
 * Emitted on every failure path so operators can distinguish timeout spikes
 * from provider 5xxs from network-level issues, each of which calls for a
 * different runbook.
 *
 * Labels (bounded cardinality):
 *   operation — static method name: "getLatestLedger", "accountExists", ...
 *   kind      — TIMEOUT | NETWORK | PROVIDER | CIRCUIT_OPEN | CANCELLED
 *               (see RPC_FAILURE_KINDS).
 *
 * Alert thresholds:
 *   TIMEOUT rate per operation: page >= 10% over 5m (indicates provider
 *     slowness or deadline misconfiguration).
 *   CIRCUIT_OPEN transitions: warn on any non-zero increment over 1m (means
 *     the circuit breaker just tripped or recovery probes keep failing).
 */
assertCollectorLabels(['operation', 'kind']);
export const rpcUpstreamCallsFailedTotal =
  (registry.getSingleMetric('rpc_upstream_calls_failed_total') as Counter<
    'operation' | 'kind'
  >) ||
  new Counter({
    name: 'rpc_upstream_calls_failed_total',
    help:
      'Failed upstream Stellar RPC calls by operation and failure kind ' +
      '(TIMEOUT, NETWORK, PROVIDER, CIRCUIT_OPEN, CANCELLED). ' +
      'Alert: TIMEOUT rate >= 10% over 5m; any CIRCUIT_OPEN increment warns.',
    labelNames: ['operation', 'kind'] as const,
    registers: [registry],
  });

/**
 * Histogram of upstream Stellar RPC call duration in seconds, by operation and outcome.
 *
 * Records the full end-to-end wall-clock time of each call (including any
 * jittered retries performed by withJitteredRetry inside the operation body)
 * so per-operation p95/p99 latency is observable without being hidden behind
 * an aggregate average across all methods.
 *
 * Labels (bounded cardinality):
 *   operation — static method name: "getLatestLedger", "accountExists", ...
 *   outcome   — "success" | "failure" (see RPC_CALL_OUTCOMES).
 *
 * Buckets are tuned for Stellar RPC:
 *   - Sub-100ms buckets catch the fast getLatestLedger health pings
 *   - 250ms–1s buckets cover normal accountExists lookups
 *   - 2.5s–10s buckets catch slow Horizon responses
 *   - +Inf bucket catches timeouts and retry storm tails
 *
 * Alert thresholds (per operation, p95 over 5m):
 *   getLatestLedger:  warn >= 500ms,  page >= 2s
 *   accountExists:    warn >= 1.5s,   page >= 5s
 *   Any operation:    warn >= deadline * 0.8, page >= deadline
 */
assertCollectorLabels(['operation', 'outcome']);
export const rpcUpstreamCallDurationSeconds =
  (registry.getSingleMetric('rpc_upstream_call_duration_seconds') as Histogram<
    'operation' | 'outcome'
  >) ||
  new Histogram({
    name: 'rpc_upstream_call_duration_seconds',
    help:
      'Duration of upstream Stellar RPC calls in seconds by operation and outcome. ' +
      'Alert (p95/5m): getLatestLedger warn>=500ms/page>=2s; ' +
      'accountExists warn>=1.5s/page>=5s; any op >= deadline*0.8 warns.',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
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
  registry.removeSingleMetric('rpc_upstream_calls_total');
  registry.removeSingleMetric('rpc_upstream_calls_failed_total');
  registry.removeSingleMetric('rpc_upstream_call_duration_seconds');
}

