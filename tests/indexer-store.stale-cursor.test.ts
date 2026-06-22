import { describe, expect, it } from 'vitest';
import {
  InMemoryContractEventStore,
  PostgresContractEventStore,
  StaleCursorError,
} from '../src/indexer/store.js';
import type { ContractEventRecord } from '../src/indexer/types.js';

function makeRecord(eventId: string, ledger: number): ContractEventRecord {
  return {
    eventId,
    ledger,
    contractId: 'C1',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '1.0000000' },
    happenedAt: '2026-01-01T00:00:00.000Z',
    ledgerHash: `hash-${ledger}`,
  };
}

describe('ContractEventStore stale cursor handling', () => {
  it('throws STALE_CURSOR from memory store when afterEventId no longer exists', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([makeRecord('e1', 100)]);

    await expect(store.getEvents({ afterEventId: 'evicted-cursor' }))
      .rejects.toMatchObject({ code: 'STALE_CURSOR', afterEventId: 'evicted-cursor' });
  });

  it('keeps normal end-of-store cursor reads as an empty page', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([makeRecord('e1', 100)]);

    const result = await store.getEvents({ afterEventId: 'e1' });

    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('throws STALE_CURSOR from Postgres store when the cursor lookup misses', async () => {
    const store = new PostgresContractEventStore({
      query: async <T>() => ({ rows: [] as T[], rowCount: 0 }),
    });

    await expect(store.getEvents({ afterEventId: 'evicted-cursor' }))
      .rejects.toBeInstanceOf(StaleCursorError);
  });

  it('uses the Postgres cursor boundary when the cursor lookup succeeds', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('WHERE event_id = $1')) {
          return { rows: [{ ledger: 100 }] as T[], rowCount: 1 };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ count: '0' }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    await store.getEvents({ afterEventId: 'e1' });

    expect(queries[1]?.values).toEqual([100, 'e1']);
    expect(queries[2]?.sql).toContain('event_id > $2');
  });

  it('keeps Postgres insert idempotency compatible with partitioned keys', async () => {
    let insertSql = '';
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        insertSql = sql;
        return { rows: [{ event_id: 'e1' }] as T[], rowCount: 1 };
      },
    });

    await store.insertMany([makeRecord('e1', 100)]);

    expect(insertSql).toContain('ON CONFLICT DO NOTHING');
    expect(insertSql).not.toContain('ON CONFLICT (event_id)');
  });
});
