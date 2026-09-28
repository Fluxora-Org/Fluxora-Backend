import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import {
  businessEventsTotal,
  collectBusinessEvents,
  deRegisterBusinessEventMetrics,
} from '../../src/metrics/businessEventCollector.js';

describe('businessEventCollector', () => {
  /** Minimal pg.Pool stand-in that replays a fixed result set. */
  const fakePool = (rows: Record<string, unknown>[]): pg.Pool =>
    ({ query: async () => ({ rows }) }) as unknown as pg.Pool;

  const getMetricValue = async (eventType: string): Promise<number | undefined> => {
    const metric = await businessEventsTotal.get();
    return metric.values.find((v) => v.labels.event_type === eventType)?.value;
  };

  beforeEach(() => {
    businessEventsTotal.reset();
  });

  afterEach(() => {
    businessEventsTotal.reset();
    deRegisterBusinessEventMetrics();
  });

  it('reflects failure states and does not double-count on retry', async () => {
    // 1. Initial state
    await collectBusinessEvents(fakePool([]));
    expect(await getMetricValue('stream.created')).toBeUndefined();

    // 2. Ingestion of 2 streams
    await collectBusinessEvents(
      fakePool([{ event_type: 'stream.created', count: '2' }])
    );
    expect(await getMetricValue('stream.created')).toBe(2);

    // 3. Failure state: Reorg rolls back 1 stream
    await collectBusinessEvents(
      fakePool([{ event_type: 'stream.created', count: '1' }])
    );
    expect(await getMetricValue('stream.created')).toBe(1);

    // 4. Replay: The indexer replays the ledger, re-ingesting the stream
    // Because the collector queries the DB idempotently, it correctly reflects 2,
    // rather than double-counting to 3 (which a simple Counter would do).
    await collectBusinessEvents(
      fakePool([{ event_type: 'stream.created', count: '2' }])
    );
    expect(await getMetricValue('stream.created')).toBe(2);
  });
  
  it('resets gauges for event types that drop to zero entirely', async () => {
    await collectBusinessEvents(
      fakePool([{ event_type: 'withdrawal.made', count: '1' }])
    );
    expect(await getMetricValue('withdrawal.made')).toBe(1);

    // Simulate complete rollback of all withdrawals
    await collectBusinessEvents(fakePool([]));
    
    // It should not remain 1; since businessEventsTotal.reset() is called,
    // the value is either zero or the label disappears.
    // In our implementation, reset() clears the samples, so it becomes undefined.
    expect(await getMetricValue('withdrawal.made')).toBeUndefined();
  });
});
