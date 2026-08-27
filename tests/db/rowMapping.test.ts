// @ts-nocheck
// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
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
import { rowToStreamEventRecord } from '../../src/indexer/store.js';
import { RowMappingError, INT32_MAX, BIGINT_SAFE_MAX } from '../../src/db/rowMapping.js';

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

// ── Issue #1316: reject silent null-to-default coercion ───────────────────────
//
// The contract is taken from migrations/1000000000002_create_replay_cursors.ts.
// NOT NULL: id, contract_id, ledger, total_rows, last_committed_offset,
// started_at. Nullable: from_block, to_block, completed_at.

describe('rowToReplayCursor — contract enforcement (#1316)', () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');

  /** A row that satisfies the contract; individual cases override one column. */
  const validRow = (): Record<string, unknown> => ({
    id: 'uuid-1',
    contract_id: 'contract-a',
    ledger: 42,
    from_block: 10,
    to_block: null,
    total_rows: 100,
    last_committed_offset: 25,
    started_at: startedAt,
    completed_at: null,
  });

  const expectRejection = (column: string, override: unknown, absent = false) => {
    const row = validRow();
    if (absent) {
      delete row[column];
    } else {
      row[column] = override;
    }

    try {
      rowToReplayCursor(row);
    } catch (err) {
      expect(err).toBeInstanceOf(RowMappingError);
      const mappingError = err as RowMappingError;
      expect(mappingError.table).toBe('replay_cursors');
      expect(mappingError.column).toBe(column);
      // The message must not echo the rejected value — rows reach logs.
      expect(mappingError.received).not.toContain('secret');
      return;
    }
    throw new Error(`expected ${column} to be rejected`);
  };

  const NOT_NULL_COLUMNS = [
    'id',
    'contract_id',
    'ledger',
    'total_rows',
    'last_committed_offset',
    'started_at',
  ] as const;

  describe('NULL, undefined and missing columns', () => {
    it.each(NOT_NULL_COLUMNS)('rejects NULL in NOT NULL column %s', (column) => {
      expectRejection(column, null);
    });

    it.each(NOT_NULL_COLUMNS)('rejects undefined in NOT NULL column %s', (column) => {
      expectRejection(column, undefined);
    });

    it.each(NOT_NULL_COLUMNS)('rejects an absent NOT NULL column %s', (column) => {
      expectRejection(column, undefined, true);
    });

    it('still maps NULL in the nullable columns', () => {
      const cursor = rowToReplayCursor({
        ...validRow(),
        from_block: null,
        to_block: null,
        completed_at: null,
      });

      expect(cursor.from_block).toBeNull();
      expect(cursor.to_block).toBeNull();
      expect(cursor.completed_at).toBeNull();
    });
  });

  describe('wrong types', () => {
    // Every one of these is silently coerced by `Number()`: Number(true) is 1,
    // Number([]) is 0, Number(new Date()) is an epoch, Number('') is 0.
    it.each([
      ['boolean', true],
      ['empty array', []],
      ['object', {}],
      ['Date', new Date()],
      ['non-numeric string', 'abc'],
      ['whitespace string', ' '],
      ['empty string', ''],
      ['hex string', '0x10'],
      ['exponent string', '1e3'],
      ['fractional number', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects %s in the integer column ledger', (_label, value) => {
      expectRejection('ledger', value);
    });

    it.each([
      ['number', 123],
      ['object', {}],
      ['array', []],
      ['boolean', false],
    ])('rejects %s in the text column contract_id', (_label, value) => {
      expectRejection('contract_id', value);
    });

    it.each([
      ['unparseable string', 'not-a-date'],
      ['Invalid Date', new Date('nonsense')],
      ['epoch number', 1735689600000],
      ['boolean', true],
    ])('rejects %s in the timestamptz column started_at', (_label, value) => {
      expectRejection('started_at', value);
    });

    it('rejects a wrong-typed value in a nullable column', () => {
      // Nullable means "may be NULL", not "may be anything".
      expectRejection('to_block', 'not-a-number');
      expectRejection('completed_at', 'not-a-date');
    });
  });

  describe('boundaries', () => {
    it('accepts the inclusive lower bound of the integer columns', () => {
      const cursor = rowToReplayCursor({
        ...validRow(),
        ledger: 0,
        from_block: 0,
        total_rows: 0,
        last_committed_offset: 0,
      });

      expect(cursor.ledger).toBe(0);
      expect(cursor.from_block).toBe(0);
      expect(cursor.total_rows).toBe(0);
      expect(cursor.last_committed_offset).toBe(0);
    });

    it('accepts INT32_MAX, the widest value the integer columns can hold', () => {
      expect(rowToReplayCursor({ ...validRow(), total_rows: INT32_MAX }).total_rows).toBe(
        INT32_MAX,
      );
    });

    it('rejects one past INT32_MAX', () => {
      expectRejection('total_rows', INT32_MAX + 1);
    });

    it('rejects negative ledgers, offsets and block heights', () => {
      expectRejection('ledger', -1);
      expectRejection('last_committed_offset', -1);
      expectRejection('from_block', -1);
    });

    it('rejects integer strings past the safe-integer range instead of rounding', () => {
      // Number('9007219254740993') rounds silently; a bigint column must never
      // be truncated into a plausible-looking count.
      expectRejection('total_rows', '9007199254740993');
    });

    it('accepts an empty contract_id only when it is genuinely empty text', () => {
      // A NOT NULL text column holding '' is corrupt for an identifier.
      expectRejection('contract_id', '');
      expectRejection('id', '');
    });
  });

  describe('error payload', () => {
    it('names the table, the column and the reason', () => {
      try {
        rowToReplayCursor({ ...validRow(), total_rows: null });
        throw new Error('expected a rejection');
      } catch (err) {
        const mappingError = err as RowMappingError;
        expect(mappingError.name).toBe('RowMappingError');
        expect(mappingError.code).toBe('ROW_MAPPING_INVALID');
        expect(mappingError.table).toBe('replay_cursors');
        expect(mappingError.column).toBe('total_rows');
        expect(mappingError.message).toContain('replay_cursors.total_rows');
      }
    });

    it('describes the received value without echoing its contents', () => {
      try {
        rowToReplayCursor({ ...validRow(), contract_id: 'super-secret-tenant-id' });
        // contract_id is a valid string here, so nothing is thrown.
      } catch {
        throw new Error('a valid contract_id must not be rejected');
      }

      try {
        rowToReplayCursor({ ...validRow(), ledger: 'super-secret-tenant-id' });
        throw new Error('expected a rejection');
      } catch (err) {
        const mappingError = err as RowMappingError;
        expect(mappingError.message).not.toContain('super-secret-tenant-id');
        expect(mappingError.received).toBe('string(length=22)');
      }
    });
  });
});

describe('rowToContractEvent — contract enforcement (#1316)', () => {
  const createdAt = new Date('2026-03-01T00:00:00.000Z');

  /** A row shaped like `fetchEventBatch`'s SELECT list. */
  const validRow = (): Record<string, unknown> => ({
    event_id: 'evt-1',
    contract_id: 'contract-a',
    ledger: 7,
    event_type: 'transfer',
    event_data: { amount: '10' },
    block_height: 9001,
    transaction_hash: 'abc',
  });

  const expectRejection = (column: string, override: unknown, absent = false) => {
    const row = validRow();
    if (absent) {
      delete row[column];
    } else {
      row[column] = override;
    }

    try {
      rowToContractEvent(row);
    } catch (err) {
      expect(err).toBeInstanceOf(RowMappingError);
      const mappingError = err as RowMappingError;
      expect(mappingError.table).toBe('historical_events');
      expect(mappingError.column).toBe(column);
      return;
    }
    throw new Error(`expected ${column} to be rejected`);
  };

  const NOT_NULL_COLUMNS = [
    'event_id',
    'contract_id',
    'ledger',
    'event_type',
    'event_data',
    'block_height',
    'transaction_hash',
  ] as const;

  describe('NULL, undefined and missing columns', () => {
    it.each(NOT_NULL_COLUMNS)('rejects NULL in NOT NULL column %s', (column) => {
      expectRejection(column, null);
    });

    it.each(NOT_NULL_COLUMNS)('rejects undefined in NOT NULL column %s', (column) => {
      expectRejection(column, undefined);
    });

    it.each(NOT_NULL_COLUMNS)('rejects an absent NOT NULL column %s', (column) => {
      expectRejection(column, undefined, true);
    });

    it('maps a selected-but-NULL created_at to null rather than an Invalid Date', () => {
      // created_at carries a DEFAULT but no NOT NULL, so NULL is legal.
      const event = rowToContractEvent({ ...validRow(), created_at: null });
      expect(event.created_at).toBeNull();
    });

    it('omits ingested_at and created_at entirely when the columns are not selected', () => {
      // fetchEventBatch selects neither. An unselected column must not
      // materialise as a fabricated timestamp.
      const event = rowToContractEvent(validRow());
      expect('ingested_at' in event).toBe(false);
      expect('created_at' in event).toBe(false);
    });
  });

  describe('event_data JSON shape', () => {
    it('rejects a jsonb column holding the JSON literal null', () => {
      // `jsonb 'null'` arrives as JS null, indistinguishable from SQL NULL.
      expectRejection('event_data', null);
    });

    it.each([
      ['array', []],
      ['populated array', [1, 2, 3]],
      ['number', 42],
      ['boolean', true],
      ['Date', new Date()],
    ])('rejects %s in the jsonb column event_data', (_label, value) => {
      expectRejection('event_data', value);
    });

    it('rejects an unparsed JSON string instead of parsing it', () => {
      // pg already parses json/jsonb. A string here means the value never went
      // through the type parser, and repairing it in the mapper would hide that.
      expectRejection('event_data', '{"amount":"10"}');
    });

    it('accepts an empty object', () => {
      expect(rowToContractEvent({ ...validRow(), event_data: {} }).event_data).toEqual({});
    });
  });

  describe('wrong types', () => {
    it.each([
      ['boolean', true],
      ['empty array', []],
      ['object', {}],
      ['Date', new Date()],
      ['non-numeric string', 'abc'],
      ['empty string', ''],
      ['fractional number', 1.5],
      ['NaN', Number.NaN],
    ])('rejects %s in the bigint column block_height', (_label, value) => {
      expectRejection('block_height', value);
    });

    it.each([
      ['number', 123],
      ['object', {}],
      ['boolean', false],
    ])('rejects %s in the text column event_type', (_label, value) => {
      expectRejection('event_type', value);
    });

    it('rejects a wrong-typed value in the nullable timestamp columns', () => {
      expectRejection('created_at', 'not-a-date');
      expectRejection('ingested_at', true);
    });
  });

  describe('boundaries', () => {
    it('accepts zero for ledger and block_height', () => {
      const event = rowToContractEvent({ ...validRow(), ledger: 0, block_height: 0 });
      expect(event.ledger).toBe(0);
      expect(event.block_height).toBe(0);
    });

    it('accepts block_height at the safe-integer ceiling', () => {
      const event = rowToContractEvent({
        ...validRow(),
        block_height: String(BIGINT_SAFE_MAX),
      });
      expect(event.block_height).toBe(BIGINT_SAFE_MAX);
    });

    it('rejects a bigint past the safe-integer range instead of rounding it', () => {
      // Number('9007199254740993') === 9007199254740992. A replay ordered by a
      // rounded block height would skip or repeat events.
      expectRejection('block_height', '9007199254740993');
    });

    it('rejects a ledger past the int4 ceiling', () => {
      expectRejection('ledger', INT32_MAX + 1);
    });

    it('rejects negative ledgers and block heights', () => {
      expectRejection('ledger', -1);
      expectRejection('block_height', -1);
    });

    it('rejects empty identifiers', () => {
      expectRejection('event_id', '');
      expectRejection('transaction_hash', '');
    });
  });
});

describe('rowToVacuumRow — contract enforcement (#1316)', () => {
  const lastAutovacuum = new Date('2026-04-01T00:00:00.000Z');

  const validRow = (): Record<string, unknown> => ({
    table_name: 'streams',
    n_dead_tup: '12',
    n_live_tup: '100',
    last_autovacuum: lastAutovacuum,
  });

  const expectRejection = (column: string, override: unknown, absent = false) => {
    const row = validRow();
    if (absent) {
      delete row[column];
    } else {
      row[column] = override;
    }

    try {
      rowToVacuumRow(row);
    } catch (err) {
      expect(err).toBeInstanceOf(RowMappingError);
      const mappingError = err as RowMappingError;
      expect(mappingError.table).toBe('pg_stat_user_tables');
      expect(mappingError.column).toBe(column);
      return;
    }
    throw new Error(`expected ${column} to be rejected`);
  };

  const NOT_NULL_COLUMNS = ['table_name', 'n_dead_tup', 'n_live_tup'] as const;

  describe('NULL, undefined and missing columns', () => {
    it.each(NOT_NULL_COLUMNS)('rejects NULL in %s instead of defaulting it', (column) => {
      // The old mapper turned a NULL table_name into '' and a NULL count into
      // '0'. Both were then published as genuine Gauge readings.
      expectRejection(column, null);
    });

    it.each(NOT_NULL_COLUMNS)('rejects undefined in %s', (column) => {
      expectRejection(column, undefined);
    });

    it.each(NOT_NULL_COLUMNS)('rejects an absent %s column', (column) => {
      expectRejection(column, undefined, true);
    });

    it('still maps a NULL last_autovacuum to null', () => {
      // A table that has never been autovacuumed reports NULL; the collector
      // turns that into the -1 sentinel.
      expect(rowToVacuumRow({ ...validRow(), last_autovacuum: null }).last_autovacuum).toBeNull();
    });
  });

  describe('wrong types', () => {
    it.each([
      ['empty string', ''],
      ['non-numeric string', 'abc'],
      ['literal NaN string', 'NaN'],
      ['boolean', true],
      ['object', {}],
      ['array', []],
      ['fractional number', 1.5],
      ['NaN', Number.NaN],
    ])('rejects %s in the count column n_dead_tup', (_label, value) => {
      // Each of these previously survived as a string and became NaN at
      // parseInt time, which prom-client exported verbatim.
      expectRejection('n_dead_tup', value);
    });

    it.each([
      ['number', 42],
      ['object', {}],
      ['boolean', false],
    ])('rejects %s in the text column table_name', (_label, value) => {
      // A non-string table_name becomes a Gauge label, so it must be rejected
      // before it can widen label cardinality.
      expectRejection('table_name', value);
    });

    it.each([
      ['unparseable string', 'never'],
      ['Invalid Date', new Date('nonsense')],
      ['boolean', true],
    ])('rejects %s in the timestamp column last_autovacuum', (_label, value) => {
      expectRejection('last_autovacuum', value);
    });
  });

  describe('boundaries', () => {
    it('accepts zero counts and emits them as canonical strings', () => {
      const row = rowToVacuumRow({ ...validRow(), n_dead_tup: 0, n_live_tup: 0 });
      expect(row.n_dead_tup).toBe('0');
      expect(row.n_live_tup).toBe('0');
    });

    it('accepts counts at the safe-integer ceiling', () => {
      const row = rowToVacuumRow({ ...validRow(), n_live_tup: String(BIGINT_SAFE_MAX) });
      expect(row.n_live_tup).toBe(String(BIGINT_SAFE_MAX));
    });

    it('rejects counts past the safe-integer range instead of rounding them', () => {
      expectRejection('n_live_tup', '9007199254740993');
    });

    it('rejects negative tuple counts', () => {
      // pg_stat_user_tables never reports a negative count; one means the
      // aggregate is corrupt.
      expectRejection('n_dead_tup', -1);
    });

    it('rejects an empty table_name', () => {
      expectRejection('table_name', '');
    });
  });
});

describe('rowToStreamEventRecord — contract enforcement (#1316)', () => {
  const happenedAt = new Date('2026-01-01T00:00:00.000Z');
  const ingestedAt = new Date('2026-01-01T00:00:05.000Z');

  const validRow = (): Record<string, unknown> => ({
    event_id: 'e1',
    ledger: 100,
    ledger_hash: 'hash-100',
    contract_id: 'C1',
    topic: 'stream.created',
    tx_hash: 'tx-e1',
    tx_index: 0,
    operation_index: 0,
    event_index: 0,
    payload: { amount: '1.0000000' },
    happened_at: happenedAt,
    ingested_at: ingestedAt,
  });

  const expectRejection = (column: string, override: unknown, absent = false) => {
    const row = validRow();
    if (absent) {
      delete row[column];
    } else {
      row[column] = override;
    }

    try {
      rowToStreamEventRecord(row);
    } catch (err) {
      expect(err).toBeInstanceOf(RowMappingError);
      const mappingError = err as RowMappingError;
      expect(mappingError.table).toBe('contract_events');
      expect(mappingError.column).toBe(column);
      return;
    }
    throw new Error(`expected ${column} to be rejected`);
  };

  const NOT_NULL_COLUMNS = [
    'event_id',
    'ledger',
    'contract_id',
    'topic',
    'tx_hash',
    'tx_index',
    'operation_index',
    'event_index',
    'payload',
    'happened_at',
    'ingested_at',
  ] as const;

  describe('NULL, undefined and missing columns', () => {
    it.each(NOT_NULL_COLUMNS)('rejects NULL in NOT NULL column %s', (column) => {
      expectRejection(column, null);
    });

    it.each(NOT_NULL_COLUMNS)('rejects undefined in NOT NULL column %s', (column) => {
      expectRejection(column, undefined);
    });

    it.each(NOT_NULL_COLUMNS)('rejects an absent NOT NULL column %s', (column) => {
      expectRejection(column, undefined, true);
    });

    it('maps a legacy row with a NULL ledger_hash', () => {
      // ledger_hash was added as a nullable column so pre-existing rows stayed
      // valid without a backfill. Those rows must still be readable.
      expect(rowToStreamEventRecord({ ...validRow(), ledger_hash: null }).ledgerHash).toBeNull();
    });

    it('rejects a wrong-typed ledger_hash even though the column is nullable', () => {
      expectRejection('ledger_hash', 123);
    });
  });

  describe('timestamp conversion', () => {
    it('converts timestamptz columns to ISO-8601 strings', () => {
      const record = rowToStreamEventRecord(validRow());
      expect(record.happenedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(record.ingestedAt).toBe('2026-01-01T00:00:05.000Z');
    });

    it('accepts a timestamp already delivered as a string', () => {
      const record = rowToStreamEventRecord({
        ...validRow(),
        happened_at: '2026-01-01T00:00:00.000Z',
      });
      expect(record.happenedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it.each([
      ['unparseable string', 'garbage'],
      ['Invalid Date', new Date('nonsense')],
      ['epoch number', 1767225600000],
    ])('rejects %s in happened_at', (_label, value) => {
      expectRejection('happened_at', value);
    });
  });

  describe('payload JSON shape', () => {
    it.each([
      ['array', []],
      ['number', 7],
      ['boolean', true],
    ])('rejects %s in the jsonb column payload', (_label, value) => {
      expectRejection('payload', value);
    });

    it('rejects an unparsed JSON string', () => {
      expectRejection('payload', '{"amount":"1.0000000"}');
    });

    it('accepts an empty payload object', () => {
      expect(rowToStreamEventRecord({ ...validRow(), payload: {} }).payload).toEqual({});
    });
  });

  describe('boundaries', () => {
    it('accepts zero for every index column', () => {
      const record = rowToStreamEventRecord({
        ...validRow(),
        ledger: 0,
        tx_index: 0,
        operation_index: 0,
        event_index: 0,
      });
      expect(record.ledger).toBe(0);
      expect(record.txIndex).toBe(0);
      expect(record.operationIndex).toBe(0);
      expect(record.eventIndex).toBe(0);
    });

    it('accepts INT32_MAX for the integer columns', () => {
      expect(rowToStreamEventRecord({ ...validRow(), ledger: INT32_MAX }).ledger).toBe(INT32_MAX);
    });

    it('rejects values past the int4 ceiling', () => {
      expectRejection('ledger', INT32_MAX + 1);
      expectRejection('tx_index', INT32_MAX + 1);
    });

    it('rejects negative ledgers and indexes', () => {
      expectRejection('ledger', -1);
      expectRejection('tx_index', -1);
      expectRejection('operation_index', -1);
      expectRejection('event_index', -1);
    });

    it('rejects fractional indexes', () => {
      expectRejection('event_index', 1.5);
    });

    it('rejects empty identifiers', () => {
      expectRejection('event_id', '');
      expectRejection('contract_id', '');
      expectRejection('tx_hash', '');
    });
  });

  it('names the partition it was given when reporting a rejection', () => {
    // Partitioned reads pass the child table name so the error points at the
    // partition that actually holds the bad row.
    try {
      rowToStreamEventRecord({ ...validRow(), ledger: null }, 'contract_events_y2026m01');
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as RowMappingError).table).toBe('contract_events_y2026m01');
    }
  });
});
