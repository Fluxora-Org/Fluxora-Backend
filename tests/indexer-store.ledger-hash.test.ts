/**
 * Migration round-trip regression test for ledger_hash on contract_events.
 *
 * Tests verified here:
 *  1. The forward migration (20260624000000) up()/down() calls the correct
 *     pgm methods with the correct column definition.
 *  2. The streams-table migration (1774715131962) includes ledger_hash in
 *     the contract_events createTable call.
 *  3. The initial-schema migration (1000000000000) includes ledger_hash in
 *     the contract_events createTable call.
 *  4. The store INSERT SQL targets all 11 columns including ledger_hash.
 *  5. NULL ledger_hash on old rows does not cause the store to throw.
 *
 * These are pure unit tests — no real database connection is required.
 * They guard against accidental regression where a developer edits a migration
 * and removes the ledger_hash column definition.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContractEventRecord } from '../src/indexer/types.js';
import { PostgresContractEventStore } from '../src/indexer/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal MigrationBuilder spy that records every method call. */
function makePgmSpy() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const handler: ProxyHandler<object> = {
    get: (_target, prop: string) =>
      (...args: unknown[]) => { calls.push({ method: prop, args }); },
  };
  const pgm = new Proxy({}, handler) as Parameters<typeof import('../migrations/20260624000000_add_ledger_hash_to_contract_events.js')['up']>[0];
  return { pgm, calls };
}

function makeRecord(overrides: Partial<ContractEventRecord> = {}): ContractEventRecord {
  return {
    eventId: 'evt-001',
    ledger: 100,
    contractId: 'CONTRACT_A',
    topic: 'stream.created',
    txHash: 'txabc123',
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '1.0000000' },
    happenedAt: '2026-06-24T00:00:00.000Z',
    ledgerHash: 'cafebabe1234567890abcdef',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Forward migration shape tests
// ---------------------------------------------------------------------------

describe('20260624000000_add_ledger_hash_to_contract_events — migration shape', () => {
  it('up() calls addColumn on contract_events with ledger_hash TEXT nullable', async () => {
    const { pgm, calls } = makePgmSpy();
    const { up } = await import('../migrations/20260624000000_add_ledger_hash_to_contract_events.js');
    await up(pgm);

    const addCall = calls.find((c) => c.method === 'addColumn');
    expect(addCall).toBeDefined();
    expect(addCall!.args[0]).toBe('contract_events');
    const colDef = addCall!.args[1] as Record<string, unknown>;
    expect(colDef).toHaveProperty('ledger_hash');
    const ledgerHashDef = colDef['ledger_hash'] as { type: string; notNull: boolean | undefined };
    expect(ledgerHashDef.type).toBe('text');
    // notNull must be falsy (nullable) so legacy rows survive
    expect(ledgerHashDef.notNull).toBeFalsy();
  });

  it('down() calls dropColumn on contract_events for ledger_hash', async () => {
    const { pgm, calls } = makePgmSpy();
    const { down } = await import('../migrations/20260624000000_add_ledger_hash_to_contract_events.js');
    await down(pgm);

    const dropCall = calls.find((c) => c.method === 'dropColumn');
    expect(dropCall).toBeDefined();
    expect(dropCall!.args[0]).toBe('contract_events');
    expect(dropCall!.args[1]).toBe('ledger_hash');
  });
});

// ---------------------------------------------------------------------------
// streams-table migration shape test
// ---------------------------------------------------------------------------

describe('1774715131962_streams-table — contract_events includes ledger_hash', () => {
  it('createTable call for contract_events includes a ledger_hash column definition', async () => {
    const { pgm, calls } = makePgmSpy();
    const { up } = await import('../migrations/1774715131962_streams-table.js');
    await up(pgm);

    const createCalls = calls.filter((c) => c.method === 'createTable');
    const contractEventsCall = createCalls.find((c) => c.args[0] === 'contract_events');
    expect(contractEventsCall).toBeDefined();

    const columns = contractEventsCall!.args[1] as Record<string, unknown>;
    expect(columns).toHaveProperty('ledger_hash');
    const col = columns['ledger_hash'] as { type: string; notNull?: boolean };
    expect(col.type).toBe('text');
    expect(col.notNull).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// initial-schema migration shape test
// ---------------------------------------------------------------------------

describe('1000000000000_initial_schema — contract_events includes ledger_hash', () => {
  it('createTable call for contract_events includes a ledger_hash column definition', async () => {
    const { pgm, calls } = makePgmSpy();
    const { up } = await import('../migrations/1000000000000_initial_schema.js');
    await up(pgm);

    const createCalls = calls.filter((c) => c.method === 'createTable');
    const contractEventsCall = createCalls.find((c) => c.args[0] === 'contract_events');
    expect(contractEventsCall).toBeDefined();

    const columns = contractEventsCall!.args[1] as Record<string, unknown>;
    expect(columns).toHaveProperty('ledger_hash');
  });
});

// ---------------------------------------------------------------------------
// Store SQL round-trip tests (mock PgClient)
// ---------------------------------------------------------------------------

describe('PostgresContractEventStore — ledger_hash SQL round-trip', () => {
  it('INSERT binds ledger_hash as $11', async () => {
    const capturedValues: unknown[] = [];
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        if (values) capturedValues.push(...values);
        if (sql.includes('ON CONFLICT')) {
          return { rows: [{ event_id: 'evt-001' }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    await store.insertMany([makeRecord()]);

    // 11 parameters per row; index 10 (0-based) is ledger_hash
    expect(capturedValues[10]).toBe('cafebabe1234567890abcdef');
  });

  it('INSERT SQL column list contains ledger_hash', async () => {
    let capturedSql = '';
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        if (sql.includes('ON CONFLICT')) { capturedSql = sql; return { rows: [{ event_id: 'evt-001' }] as T[], rowCount: 1 }; }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    await store.insertMany([makeRecord()]);
    expect(capturedSql).toContain('ledger_hash');
  });

  it('getLedgerHash query references the ledger_hash column', async () => {
    let capturedSql = '';
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        capturedSql = sql;
        return { rows: [{ ledger_hash: 'myhash' }] as T[], rowCount: 1 };
      },
    });

    const hash = await store.getLedgerHash(100);
    expect(hash).toBe('myhash');
    expect(capturedSql).toContain('ledger_hash');
    expect(capturedSql).toContain('WHERE ledger = $1');
  });

  it('getEvents maps ledger_hash → ledgerHash on each row', async () => {
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] as T[], rowCount: 1 };
        return {
          rows: [{
            event_id: 'e1', ledger: 100, ledger_hash: 'replay-hash-abc',
            contract_id: 'C1', topic: 't', tx_hash: 'tx1',
            tx_index: 0, operation_index: 0, event_index: 0,
            payload: {}, happened_at: '2026-01-01T00:00:00Z', ingested_at: '2026-01-01T00:00:00Z',
          }] as T[],
          rowCount: 1,
        };
      },
    });

    const { events } = await store.getEvents({});
    expect(events[0]!.ledgerHash).toBe('replay-hash-abc');
  });

  it('getEvents tolerates NULL ledger_hash from pre-migration rows', async () => {
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] as T[], rowCount: 1 };
        return {
          rows: [{
            event_id: 'e2', ledger: 50, ledger_hash: null,
            contract_id: 'C2', topic: 't', tx_hash: 'tx2',
            tx_index: 0, operation_index: 0, event_index: 0,
            payload: {}, happened_at: '2026-01-01T00:00:00Z', ingested_at: '2026-01-01T00:00:00Z',
          }] as T[],
          rowCount: 1,
        };
      },
    });

    const { events } = await store.getEvents({});
    // Should not throw; legacy NULL is surfaced as-is
    expect(events[0]!.ledgerHash).toBeNull();
  });

  it('reorg lookup (getLedgerHash) returns null when no row exists at that ledger', async () => {
    const store = new PostgresContractEventStore({
      query: async <T>() => ({ rows: [] as T[], rowCount: 0 }),
    });

    expect(await store.getLedgerHash(999)).toBeNull();
  });
});
