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

const VALID_BUSINESS_EVENT_TYPES = new Set(['stream.created', 'withdrawal.made'] as const);
const MAX_BUSINESS_EVENT_COUNT = Number.MAX_SAFE_INTEGER;

export type BusinessEventMetricRow = {
  event_type: string;
  count: string | number;
};

export class BusinessEventValidationError extends Error {
  public readonly reason: string;
  public readonly field?: string;
  public readonly value?: unknown;

  constructor(reason: string, field?: string, value?: unknown) {
    super(`Invalid business event metric input: ${reason}${field ? ` (${field})` : ''}`);
    this.name = 'BusinessEventValidationError';
    this.reason = reason;
    this.field = field;
    this.value = value;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function validateBusinessEventRows(
  rows: ReadonlyArray<unknown>,
): BusinessEventMetricRow[] {
  if (!Array.isArray(rows)) {
    throw new BusinessEventValidationError('rows must be an array');
  }

  return rows.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new BusinessEventValidationError('row must be an object', 'rows', { index, row });
    }

    const eventType = (row as Record<string, unknown>).event_type;
    if (typeof eventType !== 'string' || eventType.trim() === '') {
      throw new BusinessEventValidationError('event_type must be a non-empty string', 'event_type', eventType);
    }

    const trimmedEventType = eventType.trim();
    if (!VALID_BUSINESS_EVENT_TYPES.has(trimmedEventType as 'stream.created' | 'withdrawal.made')) {
      throw new BusinessEventValidationError('event_type is not supported', 'event_type', trimmedEventType);
    }

    const countValue = (row as Record<string, unknown>).count;
    if (typeof countValue !== 'string' && typeof countValue !== 'number') {
      throw new BusinessEventValidationError('count must be a string or number', 'count', countValue);
    }

    const normalizedCount = typeof countValue === 'string' ? Number(countValue.trim()) : Number(countValue);

    if (!Number.isFinite(normalizedCount) || !Number.isInteger(normalizedCount) || normalizedCount < 0) {
      throw new BusinessEventValidationError('count must be a non-negative integer', 'count', countValue);
    }

    if (normalizedCount > MAX_BUSINESS_EVENT_COUNT) {
      throw new BusinessEventValidationError('count exceeds the maximum supported value', 'count', countValue);
    }

    return {
      event_type: trimmedEventType,
      count: normalizedCount.toString(),
    };
  });
}

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

    const validatedRows = validateBusinessEventRows(result.rows);

    // Reset to handle the failure state where a reorg drops all events of a type
    businessEventsTotal.reset();

    for (const row of validatedRows) {
      businessEventsTotal.set({ event_type: row.event_type }, parseInt(row.count, 10));
    }
  } catch (err) {
    if (err instanceof BusinessEventValidationError) {
      throw err;
    }
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
