import { describe, expect, it, vi } from 'vitest';

import {
  InvalidReplayIndexOptionError,
  MAX_REPLAY_INDEX_COLUMNS,
  MAX_REPLAY_INDEX_IDENTIFIER_LENGTH,
  MAX_REPLAY_INDEX_PREDICATE_LENGTH,
  REPLAY_INDEX_DEFINITIONS,
  down,
  up,
  validateReplayIndexDefinition,
} from './001_add_contract_events_replay_indexes.js';
import type { ReplayIndexDefinition } from './001_add_contract_events_replay_indexes.js';

interface PgmMock {
  noTransaction: ReturnType<typeof vi.fn>;
  createIndex: ReturnType<typeof vi.fn>;
  dropIndex: ReturnType<typeof vi.fn>;
}

function createPgmMock(): PgmMock {
  return {
    noTransaction: vi.fn(),
    createIndex: vi.fn(),
    dropIndex: vi.fn(),
  };
}

function expectNoWrites(pgm: PgmMock): void {
  expect(pgm.noTransaction).not.toHaveBeenCalled();
  expect(pgm.createIndex).not.toHaveBeenCalled();
  expect(pgm.dropIndex).not.toHaveBeenCalled();
}

async function captureError(run: () => Promise<void>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the migration to reject');
}

function definition(
  overrides: Partial<Record<keyof ReplayIndexDefinition, unknown>> = {},
): ReplayIndexDefinition {
  return {
    table: 'contract_events',
    columns: ['contract_id'],
    name: 'idx_contract_events_replay_null_ingested',
    ...overrides,
  } as ReplayIndexDefinition;
}

async function expectRejection(
  run: (pgm: PgmMock) => Promise<void>,
  field: string,
  reason: string,
): Promise<void> {
  const pgm = createPgmMock();
  const error = await captureError(() => run(pgm));

  expect(error).toBeInstanceOf(InvalidReplayIndexOptionError);
  expect(error).toMatchObject({
    name: 'InvalidReplayIndexOptionError',
    code: 'INVALID_REPLAY_INDEX_OPTION',
    field,
    reason,
  });
  expect((error as Error).message).toContain(field);
  expect((error as Error).message).toContain(reason);
  expectNoWrites(pgm);
}

describe('001_add_contract_events_replay_indexes normal path', () => {
  it('creates both default indexes concurrently without a transaction', async () => {
    const pgm = createPgmMock();

    await up(pgm as unknown as Parameters<typeof up>[0]);

    expect(pgm.noTransaction).toHaveBeenCalledTimes(1);
    expect(pgm.createIndex).toHaveBeenCalledTimes(2);
    expect(pgm.createIndex).toHaveBeenNthCalledWith(
      1,
      'contract_events',
      ['contract_id', 'ledger_sequence'],
      {
        name: 'idx_contract_events_contract_ledger',
        concurrently: true,
        ifNotExists: true,
      },
    );
    expect(pgm.createIndex).toHaveBeenNthCalledWith(
      2,
      'contract_events',
      ['contract_id'],
      {
        name: 'idx_contract_events_replay_null_ingested',
        concurrently: true,
        ifNotExists: true,
        where: 'ingested_at IS NULL',
      },
    );
  });

  it('drops both default indexes concurrently without a transaction', async () => {
    const pgm = createPgmMock();

    await down(pgm as unknown as Parameters<typeof down>[0]);

    expect(pgm.noTransaction).toHaveBeenCalledTimes(1);
    expect(pgm.dropIndex).toHaveBeenCalledTimes(2);
    expect(pgm.dropIndex).toHaveBeenNthCalledWith(
      1,
      'contract_events',
      ['contract_id', 'ledger_sequence'],
      {
        name: 'idx_contract_events_contract_ledger',
        concurrently: true,
        ifExists: true,
      },
    );
    expect(pgm.dropIndex).toHaveBeenNthCalledWith(
      2,
      'contract_events',
      ['contract_id'],
      {
        name: 'idx_contract_events_replay_null_ingested',
        concurrently: true,
        ifExists: true,
      },
    );
  });

  it('leaves valid custom definitions unchanged', async () => {
    const pgm = createPgmMock();
    const definitions: ReplayIndexDefinition[] = [
      {
        table: 'contract_events',
        columns: ['contract_id', 'ledger_sequence'],
        name: 'idx_custom_replay',
        where: 'ingested_at IS NULL',
      },
    ];

    await up(pgm as unknown as Parameters<typeof up>[0], definitions);
    await down(pgm as unknown as Parameters<typeof down>[0], definitions);

    expect(pgm.createIndex).toHaveBeenCalledWith(
      'contract_events',
      ['contract_id', 'ledger_sequence'],
      {
        name: 'idx_custom_replay',
        concurrently: true,
        ifNotExists: true,
        where: 'ingested_at IS NULL',
      },
    );
    expect(pgm.dropIndex).toHaveBeenCalledWith(
      'contract_events',
      ['contract_id', 'ledger_sequence'],
      {
        name: 'idx_custom_replay',
        concurrently: true,
        ifExists: true,
      },
    );
  });

  it('validates the default definitions without alteration', () => {
    expect(REPLAY_INDEX_DEFINITIONS.map(validateReplayIndexDefinition)).toEqual([
      {
        table: 'contract_events',
        columns: ['contract_id', 'ledger_sequence'],
        name: 'idx_contract_events_contract_ledger',
        where: undefined,
      },
      {
        table: 'contract_events',
        columns: ['contract_id'],
        name: 'idx_contract_events_replay_null_ingested',
        where: 'ingested_at IS NULL',
      },
    ]);
  });
});

describe('001_add_contract_events_replay_indexes validation', () => {
  it('rejects a malformed table identifier before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ table: 'contract_events; DROP TABLE streams' }),
        ]),
      'table',
      'malformed',
    );
  });

  it('rejects an empty table identifier before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [definition({ table: '   ' })]),
      'table',
      'empty',
    );
  });

  it('rejects an oversized table identifier before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ table: 'a'.repeat(MAX_REPLAY_INDEX_IDENTIFIER_LENGTH + 1) }),
        ]),
      'table',
      'oversized',
    );
  });

  it('rejects a non-array column list before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ columns: 'contract_id' }),
        ]),
      'columns',
      'malformed',
    );
  });

  it('rejects an empty column list before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [definition({ columns: [] })]),
      'columns',
      'empty',
    );
  });

  it('rejects an oversized column list before writing', async () => {
    const columns = Array.from(
      { length: MAX_REPLAY_INDEX_COLUMNS + 1 },
      (_value, index) => `column_${index}`,
    );

    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [definition({ columns })]),
      'columns',
      'oversized',
    );
  });

  it('rejects a malformed column identifier before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ columns: ['contract_id', 'ledger_sequence --'] }),
        ]),
      'columns',
      'malformed',
    );
  });

  it('rejects an empty index name before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [definition({ name: '' })]),
      'name',
      'empty',
    );
  });

  it('rejects an oversized index name before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ name: 'i'.repeat(MAX_REPLAY_INDEX_IDENTIFIER_LENGTH + 1) }),
        ]),
      'name',
      'oversized',
    );
  });

  it('rejects a malformed index name before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ name: 'idx replay index' }),
        ]),
      'name',
      'malformed',
    );
  });

  it('rejects an empty predicate before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [definition({ where: '' })]),
      'where',
      'empty',
    );
  });

  it('rejects an oversized predicate before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ where: 'a'.repeat(MAX_REPLAY_INDEX_PREDICATE_LENGTH + 1) }),
        ]),
      'where',
      'oversized',
    );
  });

  it('rejects an unsafe predicate before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ where: 'ingested_at IS NULL; DROP TABLE contract_events' }),
        ]),
      'where',
      'malformed',
    );
  });

  it('rejects a missing field before writing', async () => {
    await expectRejection(
      (pgm) =>
        up(pgm as unknown as Parameters<typeof up>[0], [
          definition({ name: undefined }),
        ]),
      'name',
      'missing',
    );
  });

  it('rejects an empty definition list before writing', async () => {
    await expectRejection(
      (pgm) => up(pgm as unknown as Parameters<typeof up>[0], []),
      'definitions',
      'empty',
    );
  });

  it('rejects malformed input before dropping anything', async () => {
    await expectRejection(
      (pgm) =>
        down(pgm as unknown as Parameters<typeof down>[0], [
          definition({ columns: ['contract_id', ''] }),
        ]),
      'columns',
      'empty',
    );
  });
});
