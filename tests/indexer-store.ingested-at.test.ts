import { describe, expect, it } from 'vitest';
import { PostgresContractEventStore } from '../src/indexer/store.js';
import type { ContractEventRecord } from '../src/indexer/types.js';

function makeRecord(eventId: string, ledger = 100, ingestedAt?: string): ContractEventRecord {
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
    ...(ingestedAt !== undefined ? { ingestedAt } : {}),
  };
}

describe('PostgresContractEventStore — ingested_at dynamic defaults', () => {
  it('omits ingested_at from values and binds DEFAULT in SQL placeholder when omitted', async () => {
    let capturedSql = '';
    const capturedValues: unknown[] = [];

    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO')) {
          capturedSql = sql;
          if (values) capturedValues.push(...values);
          return { rows: [{ event_id: 'e1' }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    await store.insertMany([makeRecord('e1')]);

    // Check SQL column list and placeholders
    expect(capturedSql).toContain('ingested_at');
    // The placeholder should end with DEFAULT to trigger DB default
    expect(capturedSql).toContain('DEFAULT)');
    // Total parameters should be exactly 11 (event_id to ledger_hash)
    expect(capturedValues).toHaveLength(11);
    expect(capturedValues[10]).toBe('hash-100'); // Last param is ledgerHash
  });

  it('binds explicit ingested_at and uses parameter placeholder when provided', async () => {
    let capturedSql = '';
    const capturedValues: unknown[] = [];
    const testTime = '2026-06-27T10:00:00.000Z';

    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO')) {
          capturedSql = sql;
          if (values) capturedValues.push(...values);
          return { rows: [{ event_id: 'e1' }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    await store.insertMany([makeRecord('e1', 100, testTime)]);

    expect(capturedSql).toContain('ingested_at');
    // Should have parameter placeholder $12 for ingested_at
    expect(capturedSql).toContain('$12::timestamptz');
    // Total parameters should be exactly 12
    expect(capturedValues).toHaveLength(12);
    expect(capturedValues[10]).toBe('hash-100'); // index 10 is ledgerHash
    expect(capturedValues[11]).toBe(testTime); // index 11 is explicit ingestedAt
  });

  it('existing event insertion behavior remains unchanged for other fields', async () => {
    const capturedValues: unknown[] = [];
    const store = new PostgresContractEventStore({
      query: async <T>(sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO')) {
          if (values) capturedValues.push(...values);
          return { rows: [{ event_id: 'e1' }] as T[], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    const record = makeRecord('e1', 250);
    await store.insertMany([record]);

    expect(capturedValues[0]).toBe(record.eventId);
    expect(capturedValues[1]).toBe(record.ledger);
    expect(capturedValues[2]).toBe(record.contractId);
    expect(capturedValues[3]).toBe(record.topic);
    expect(capturedValues[4]).toBe(record.txHash);
    expect(capturedValues[5]).toBe(record.txIndex);
    expect(capturedValues[6]).toBe(record.operationIndex);
    expect(capturedValues[7]).toBe(record.eventIndex);
    expect(capturedValues[8]).toBe(JSON.stringify(record.payload));
    expect(capturedValues[9]).toBe(record.happenedAt);
    expect(capturedValues[10]).toBe(record.ledgerHash);
  });
});

describe('20260627110000_contract_events_ingested_at_default migration', () => {
  it('up() calls alterColumn and repair query on contract_events', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = {
      get(_target: object, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
        };
      },
    };
    const pgm = new Proxy({}, handler) as any;

    const { up } = await import('../migrations/20260627110000_contract_events_ingested_at_default.js');
    await up(pgm);

    // Verify repairs query
    const sqlCall = calls.find((c) => c.method === 'sql');
    expect(sqlCall).toBeDefined();
    expect(sqlCall!.args[0]).toContain('UPDATE contract_events');
    expect(sqlCall!.args[0]).toContain('SET ingested_at = NOW() WHERE ingested_at IS NULL');

    // Verify alterColumn
    const alterCall = calls.find((c) => c.method === 'alterColumn');
    expect(alterCall).toBeDefined();
    expect(alterCall!.args[0]).toBe('contract_events');
    expect(alterCall!.args[1]).toBe('ingested_at');
    expect(alterCall!.args[2]).toMatchObject({
      notNull: true,
    });
  });

  it('down() calls alterColumn to revert constraint and default', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = {
      get(_target: object, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
        };
      },
    };
    const pgm = new Proxy({}, handler) as any;

    const { down } = await import('../migrations/20260627110000_contract_events_ingested_at_default.js');
    await down(pgm);

    const alterCall = calls.find((c) => c.method === 'alterColumn');
    expect(alterCall).toBeDefined();
    expect(alterCall!.args[0]).toBe('contract_events');
    expect(alterCall!.args[1]).toBe('ingested_at');
    expect(alterCall!.args[2]).toMatchObject({
      default: null,
      notNull: false,
    });
  });
});
