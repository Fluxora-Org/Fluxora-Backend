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
