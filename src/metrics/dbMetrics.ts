import { Counter } from 'prom-client';
import { registry } from '../metrics.js';

export const dbSlowQueriesTotal =
  (registry.getSingleMetric('fluxora_db_slow_queries_total') as Counter<'table_hint'>) ||
  new Counter({
    name: 'fluxora_db_slow_queries_total',
    help: 'Total number of PostgreSQL queries exceeding the slow-query threshold',
    labelNames: ['table_hint'] as const,
    registers: [registry],
  });

export function deRegisterDbMetrics(): void {
  registry.removeSingleMetric('fluxora_db_slow_queries_total');
}
