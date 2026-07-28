/**
 * Unit tests for typed Postgres row mappers (issue #886).
 *
 * Ensures domain types are produced via explicit converters rather than
 * `pool.query<DomainType>()`, which violates pg's QueryResultRow constraint.
 */

import { describe, it, expect } from 'vitest';
import {
  rowToReplayCursor,
  rowToContractEvent,
} from '../../src/indexer/service.js';
import { rowToVacuumRow } from '../../src/metrics/vacuumCollector.js';

describe('rowToReplayCursor', () => {
  it('maps a raw row into a ReplayCursor with numeric coercion', () => {
    const started = new Date('2026-01-01T00:00:00Z');
    const cursor = rowToReplayCursor({
      id: 'uuid-1',
      contract_id: 'contract-a',
      ledger: '42',
      from_block: '10',
      to_block: null,
      total_rows: '100',
      last_committed_offset: '25',
      started_at: started,
      completed_at: null,
    });

    expect(cursor).toEqual({
      id: 'uuid-1',
      contract_id: 'contract-a',
      ledger: 42,
      from_block: 10,
      to_block: null,
      total_rows: 100,
      last_committed_offset: 25,
      started_at: started,
      completed_at: null,
    });
  });

  it('coerces completed_at timestamps from strings', () => {
    const cursor = rowToReplayCursor({
      id: 'uuid-2',
      contract_id: 'c',
      ledger: 1,
      from_block: undefined,
      to_block: undefined,
      total_rows: 0,
      last_committed_offset: 0,
      started_at: '2026-02-01T12:00:00.000Z',
      completed_at: '2026-02-01T13:00:00.000Z',
    });

    expect(cursor.from_block).toBeNull();
    expect(cursor.to_block).toBeNull();
    expect(cursor.started_at.toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(cursor.completed_at?.toISOString()).toBe('2026-02-01T13:00:00.000Z');
  });
});

describe('rowToContractEvent', () => {
  it('maps a historical_events row into a ContractEvent', () => {
    const event = rowToContractEvent({
      event_id: 'evt-1',
      contract_id: 'contract-a',
      ledger: '7',
      event_type: 'transfer',
      event_data: { amount: '10' },
      block_height: '9001',
      transaction_hash: 'abc',
    });

    expect(event).toEqual({
      event_id: 'evt-1',
      contract_id: 'contract-a',
      ledger: 7,
      event_type: 'transfer',
      event_data: { amount: '10' },
      block_height: 9001,
      transaction_hash: 'abc',
    });
  });

  it('includes optional ingested_at / created_at when present', () => {
    const created = new Date('2026-03-01T00:00:00Z');
    const event = rowToContractEvent({
      event_id: 'evt-2',
      contract_id: 'c',
      ledger: 1,
      event_type: 'mint',
      event_data: {},
      block_height: 1,
      transaction_hash: 'def',
      ingested_at: null,
      created_at: created,
    });

    expect(event.ingested_at).toBeNull();
    expect(event.created_at).toEqual(created);
  });
});

describe('rowToVacuumRow', () => {
  it('maps aggregate vacuum stats into VacuumRow strings', () => {
    const last = new Date('2026-04-01T00:00:00Z');
    const row = rowToVacuumRow({
      table_name: 'streams',
      n_dead_tup: 12,
      n_live_tup: 100,
      last_autovacuum: last,
    });

    expect(row).toEqual({
      table_name: 'streams',
      n_dead_tup: '12',
      n_live_tup: '100',
      last_autovacuum: last,
    });
  });

  it('treats missing last_autovacuum as null', () => {
    const row = rowToVacuumRow({
      table_name: 'audit_logs',
      n_dead_tup: '0',
      n_live_tup: '5',
      last_autovacuum: null,
    });

    expect(row.last_autovacuum).toBeNull();
  });
});
