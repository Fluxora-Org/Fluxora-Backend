import { describe, expect, it } from 'vitest';
import {
  InMemoryContractEventStore,
  PostgresContractEventStore,
  StaleCursorError,
} from '../src/indexer/store.js';
import type { ContractEventRecord } from '../src/indexer/types.js';

function makeRecord(eventId: string, ledger: number, ledgerHash?: string): ContractEventRecord {
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
    ledgerHash: ledgerHash ?? `hash-${ledger}`,
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
});

// ---------------------------------------------------------------------------
// ledger_hash insert / read round-trip tests (regression for "column does not
// exist" failure described in the issue).
// ---------------------------------------------------------------------------

describe('ledger_hash insert/read round-trip — InMemoryContractEventStore', () => {
  it('stores and retrieves ledger_hash via insertMany + getEvents', async () => {
    const store = new InMemoryContractEventStore();
    const hash = 'abc123def456';
    await store.insertMany([makeRecord('e1', 200, hash)]);

    const { events } = await store.getEvents({});
    expect(events).toHaveLength(1);
    expect(events[0]!.ledgerHash).toBe(hash);
  });

  it('getLedgerHash returns the stored hash', async () => {
    const store = new InMemoryContractEventStore();
    const hash = 'deadbeef1234';
    await store.insertMany([makeRecord('e1', 300, hash)]);

    expect(await store.getLedgerHash(300)).toBe(hash);
  });

  it('getLedgerHash returns null when no row exists for that ledger', async () => {
    const store = new InMemoryContractEventStore();
    expect(await store.getLedgerHash(999)).toBeNull();
  });

  it('rollbackBeforeLedger evicts the correct ledger_hash', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([makeRecord('e1', 400, 'hash-400'), makeRecord('e2', 401, 'hash-401')]);

    await store.rollbackBeforeLedger(401);

    expect(await store.getLedgerHash(400)).toBe('hash-400'); // retained
    expect(await store.getLedgerHash(401)).toBeNull();        // evicted
  });

  it('preserves NULL-equivalent ledger_hash when hash is empty string', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([makeRecord('e1', 500, '')]);

    const { events } = await store.getEvents({});
    expect(events[0]!.ledgerHash).toBe('');
  });
});

describe('ledger_hash insert/read round-trip — PostgresContractEventStore', () => {
  it('INSERT SQL includes ledger_hash as the 11th column', async () => {
    const captured: Array<{ sql: string; values: unknown[] }> = [];
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        captured.push({ sql, values: values ?? [] });
        // Simulate RETURNING event_id
        if (sql.includes('ON CONFLICT')) {
          return { rows: [{ event_id: 'e1' }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    await store.insertMany([makeRecord('e1', 100, 'ledger-hash-hex')]);

    const insertQuery = captured.find((q) => q.sql.includes('ON CONFLICT'));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.sql).toContain('ledger_hash');
    // The 11th value (index 10) is ledger_hash
    expect(insertQuery!.values[10]).toBe('ledger-hash-hex');
  });

  it('getLedgerHash SELECT includes ledger_hash column', async () => {
    const captured: string[] = [];
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        captured.push(sql);
        return { rows: [{ ledger_hash: 'some-hash' }] as T[], rowCount: 1 };
      },
    });

    const result = await store.getLedgerHash(123);
    expect(result).toBe('some-hash');
    expect(captured[0]).toContain('SELECT ledger_hash');
  });

  it('getEvents SELECT projection includes ledger_hash and maps to ledgerHash', async () => {
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ count: '1' }] as T[], rowCount: 1 };
        }
        // Data query — return a row with ledger_hash populated
        return {
          rows: [{
            event_id: 'e1', ledger: 100, ledger_hash: 'replay-hash',
            contract_id: 'C1', topic: 'stream.created', tx_hash: 'tx1',
            tx_index: 0, operation_index: 0, event_index: 0,
            payload: {}, happened_at: '2026-01-01T00:00:00Z', ingested_at: '2026-01-01T00:00:00Z',
          }] as T[],
          rowCount: 1,
        };
      },
    });

    const { events } = await store.getEvents({});
    expect(events).toHaveLength(1);
    expect(events[0]!.ledgerHash).toBe('replay-hash');
  });

  it('getEvents handles NULL ledger_hash from legacy rows without throwing', async () => {
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] as T[], rowCount: 1 };
        return {
          rows: [{
            event_id: 'e2', ledger: 50, ledger_hash: null,
            contract_id: 'C2', topic: 'stream.closed', tx_hash: 'tx2',
            tx_index: 0, operation_index: 0, event_index: 0,
            payload: {}, happened_at: '2026-01-01T00:00:00Z', ingested_at: '2026-01-01T00:00:00Z',
          }] as T[],
          rowCount: 1,
        };
      },
    });

    const { events } = await store.getEvents({});
    expect(events[0]!.ledgerHash).toBeNull();
  });
});
