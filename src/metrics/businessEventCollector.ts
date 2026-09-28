import pg from 'pg';
import { Gauge } from 'prom-client';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';

/**
 * Gauge tracking the idempotent count of business events.
 * 
 * Alert threshold: This is a cumulative metric (Gauge behaving like a Counter). 
 * Alerts should be based on rate(fluxora_business_events_total[5m]) dropping to 0 
 * unexpectedly, or falling behind the expected ingestion rate.
 */
export const businessEventsTotal =
  (registry.getSingleMetric('fluxora_business_events_total') as Gauge<'event_type'>) ||
  new Gauge({
    name: 'fluxora_business_events_total',
    help: 'Total number of business events (streams created, withdrawals made) counted idempotently to avoid double-counting on indexer replay',
    labelNames: ['event_type'] as const,
    registers: [registry],
  });

/**
 * Query the database to idempotently count business events.
 * Only known business events ('stream.created', 'withdrawal.made') are counted
 * to strictly bound label cardinality.
 */
export async function collectBusinessEvents(pool: pg.Pool): Promise<void> {
  try {
    const result = await pool.query<{ event_type: string, count: string }>(`
      SELECT event_type, COUNT(*) as count
      FROM contract_events
      WHERE event_type IN ('stream.created', 'withdrawal.made')
      GROUP BY event_type
    `);
    
    // Reset to handle the failure state where a reorg drops all events of a type
    businessEventsTotal.reset();

    for (const row of result.rows) {
      businessEventsTotal.set({ event_type: row.event_type }, parseInt(row.count, 10));
    }
  } catch (err) {
    logger.warn('Business events metrics collection failed', undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the periodic business events collector.
 * Runs one immediate collection then schedules subsequent collections.
 */
export function startBusinessEventCollector(
  pool: pg.Pool,
  intervalMs = 60_000,
): NodeJS.Timeout {
  void collectBusinessEvents(pool);
  return setInterval(() => {
    void collectBusinessEvents(pool);
  }, intervalMs);
}

/** Remove the Gauge from the registry — used between test runs. */
export function deRegisterBusinessEventMetrics(): void {
  registry.removeSingleMetric('fluxora_business_events_total');
}
