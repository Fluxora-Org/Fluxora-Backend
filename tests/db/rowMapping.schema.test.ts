/**
 * Live PostgreSQL contract tests for the replay_cursors row mapper (issue #1426).
 *
 * These run when DATABASE_URL is set. CI applies migrations before including
 * this file in its explicit live-database test manifest.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { RowMappingError } from '../../src/db/rowMapping.js';
import { rowToReplayCursor } from '../../src/indexer/replayRowMappers.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const OFFLINE_TEST_DATABASE_URL = 'postgresql://localhost/fluxora_test';
const hasExplicitDatabaseUrl = Boolean(DATABASE_URL && DATABASE_URL !== OFFLINE_TEST_DATABASE_URL);

const REPLAY_CURSOR_COLUMNS = {
  id: { data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
  contract_id: { data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
  ledger: { data_type: 'integer', udt_name: 'int4', is_nullable: 'NO' },
  from_block: { data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' },
  to_block: { data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' },
  total_rows: { data_type: 'integer', udt_name: 'int4', is_nullable: 'NO' },
  last_committed_offset: { data_type: 'integer', udt_name: 'int4', is_nullable: 'NO' },
  started_at: {
    data_type: 'timestamp with time zone',
    udt_name: 'timestamptz',
    is_nullable: 'NO',
  },
  completed_at: {
    data_type: 'timestamp with time zone',
    udt_name: 'timestamptz',
    is_nullable: 'YES',
  },
} as const;

describe.skipIf(!hasExplicitDatabaseUrl)('replay_cursors row mapping schema contract (live DB)', () => {
  let client: pg.Client;
  let isConnected = false;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    isConnected = true;
  });

  afterAll(async () => {
    if (isConnected) await client.end();
  });

  it('matches the mapped columns, database types, and nullability in the live schema', async () => {
    const result = await client.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(`
      SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'replay_cursors'
    `);
    const actual = new Map(result.rows.map(({ column_name, data_type, udt_name, is_nullable }) => [
      column_name,
      { data_type, udt_name, is_nullable },
    ]));

    for (const [column, expected] of Object.entries(REPLAY_CURSOR_COLUMNS)) {
      expect(actual.get(column), `mapped column ${column}`).toEqual(expected);
    }
  });

  it('rejects a nullable mapped column dropped from an isolated test schema', async () => {
    await client.query('BEGIN');
    try {
      // LIKE copies the migrated table shape into this connection-local table.
      // Transaction rollback removes it without changing the live schema.
      await client.query('CREATE TEMP TABLE replay_cursors_mapping_drift (LIKE replay_cursors)');
      await client.query(
        'ALTER TABLE pg_temp.replay_cursors_mapping_drift DROP COLUMN completed_at',
      );
      await client.query(
        `INSERT INTO pg_temp.replay_cursors_mapping_drift (
          id, contract_id, ledger, from_block, to_block, total_rows,
          last_committed_offset, started_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          '00000000-0000-0000-0000-000000000001',
          'schema-drift-test',
          1,
          null,
          null,
          0,
          0,
          new Date('2026-01-01T00:00:00.000Z'),
        ],
      );

      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM pg_temp.replay_cursors_mapping_drift',
      );
      expect(result.rows).toHaveLength(1);

      let mappingError: RowMappingError | undefined;
      try {
        rowToReplayCursor(result.rows[0] ?? {});
      } catch (error) {
        if (!(error instanceof RowMappingError)) throw error;
        mappingError = error;
      }

      expect(mappingError).toBeInstanceOf(RowMappingError);
      expect(mappingError?.table).toBe('replay_cursors');
      expect(mappingError?.column).toBe('completed_at');
      expect(mappingError?.received).toBe('undefined');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
