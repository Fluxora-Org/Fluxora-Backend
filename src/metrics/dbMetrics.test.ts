import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registry } from '../metrics.js';

vi.mock('../metrics.js', async () => {
  const { Registry } = await import('prom-client');
  return { registry: new Registry() };
});

let metrics: typeof import('./dbMetrics.js');

beforeEach(async () => {
  vi.resetModules();
  metrics = await import('./dbMetrics.js');
});

afterEach(() => {
  metrics.deRegisterDbMetrics();
});

describe('dbMetrics', () => {
  it('registers the duration histogram with repository and operation labels', async () => {
    const name = 'fluxora_db_query_duration_seconds';
    const labels = { repository: 'streamRepository', operation: 'upsertStream' };
    metrics.dbQueryDurationSeconds.observe(labels, 0.025);

    expect(registry.getSingleMetric(name)).toBe(metrics.dbQueryDurationSeconds);
    const histogram = await metrics.dbQueryDurationSeconds.get();
    expect(histogram.type).toBe('histogram');
    expect(histogram.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metricName: name + '_sum', labels, value: 0.025 }),
        expect.objectContaining({ metricName: name + '_count', labels, value: 1 }),
      ]),
    );
  });

  it('records slow queries by table hint', async () => {
    const name = 'fluxora_db_slow_queries_total';
    metrics.dbSlowQueriesTotal.inc({ table_hint: 'streams' }, 2);

    expect(registry.getSingleMetric(name)).toBe(metrics.dbSlowQueriesTotal);
    expect((await metrics.dbSlowQueriesTotal.get()).values).toEqual([
      expect.objectContaining({ labels: { table_hint: 'streams' }, value: 2 }),
    ]);
  });

  it('records one error counter series per supported error type', async () => {
    expect(metrics.DB_ERROR_TYPES).toEqual([
      'pool_exhausted',
      'query_timeout',
      'duplicate_entry',
      'other',
    ]);
    for (const error_type of metrics.DB_ERROR_TYPES) {
      metrics.dbQueryErrorsTotal.inc({ error_type });
    }

    expect(registry.getSingleMetric('fluxora_db_query_errors_total')).toBe(metrics.dbQueryErrorsTotal);
    expect((await metrics.dbQueryErrorsTotal.get()).values).toEqual(
      metrics.DB_ERROR_TYPES.map((error_type) =>
        expect.objectContaining({ labels: { error_type }, value: 1 }),
      ),
    );
  });

  it('deregisters each DB metric and is safe to call again', () => {
    const names = [
      'fluxora_db_query_duration_seconds',
      'fluxora_db_slow_queries_total',
      'fluxora_db_pool_active_connections',
      'fluxora_db_pool_idle_connections',
      'fluxora_db_pool_waiting_requests',
      'fluxora_db_pool_exhausted_total',
      'fluxora_db_write_fence_rejected_total',
      'fluxora_db_query_errors_total',
      'fluxora_db_replication_lag_seconds',
    ];
    for (const name of names) expect(registry.getSingleMetric(name)).toBeDefined();

    metrics.deRegisterDbMetrics();

    for (const name of names) expect(registry.getSingleMetric(name)).toBeUndefined();
    expect(() => metrics.deRegisterDbMetrics()).not.toThrow();
  });
});
