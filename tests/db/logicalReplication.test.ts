/**
 * Unit and Integration Tests: PostgreSQL Logical Replication for contract_events.
 *
 * @module tests/db/logicalReplication.test.ts
 *
 * COVERS:
 *  - Migration SQL structure and idempotency checks for `up()` and `down()`.
 *  - Verification of narrow scoping: ONLY `contract_events` table and ONLY `publish = 'insert'`.
 *  - Guarantee that sensitive tables (such as `streams` or `api_keys`) are NOT included in the publication.
 *  - Operational query validation (slot creation, lag monitoring in bytes).
 *  - Live DB integration assertions (catalog checks on `pg_publication` and `pg_publication_tables`) when `DATABASE_URL` is available.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { MigrationBuilder } from 'node-pg-migrate';
import pg from 'pg';

import {
  up,
  down,
  CONTRACT_EVENTS_PUBLICATION_NAME,
} from '../../migrations/20260723180000_contract_events_logical_replication.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

/** Expected SQL commands and parameters for logical replication operations */
export const LOGICAL_REPLICATION_CONSTANTS = {
  publicationName: 'fluxora_contract_events_pub',
  slotName: 'fluxora_contract_events_slot',
  targetTable: 'contract_events',
  allowedOperation: 'insert',
} as const;

/** Operational SQL queries documented in database.md for slot setup and lag monitoring */
export const OPERATIONAL_QUERIES = {
  checkWalLevel: `SHOW wal_level;`,
  createSlot: `SELECT pg_create_logical_replication_slot('fluxora_contract_events_slot', 'pgoutput');`,
  dropSlot: `SELECT pg_drop_replication_slot('fluxora_contract_events_slot');`,
  monitorSlotLag: `SELECT slot_name, plugin, active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes FROM pg_replication_slots WHERE slot_name = 'fluxora_contract_events_slot';`,
} as const;

/** Helper mock for node-pg-migrate MigrationBuilder */
function createMockMigrationBuilder(): MigrationBuilder {
  const sqlFn = vi.fn();
  return {
    sql: sqlFn,
  } as unknown as MigrationBuilder;
}

// ── Offline Contract Tests ─────────────────────────────────────────────────────

describe('Postgres Logical Replication (Offline Contract Tests)', () => {
  it('uses the expected publication name constant', () => {
    expect(CONTRACT_EVENTS_PUBLICATION_NAME).toBe('fluxora_contract_events_pub');
    expect(CONTRACT_EVENTS_PUBLICATION_NAME).toBe(LOGICAL_REPLICATION_CONSTANTS.publicationName);
  });

  it('executes idempotent CREATE PUBLICATION in up() migration', async () => {
    const pgm = createMockMigrationBuilder();
    await up(pgm);

    expect(pgm.sql).toHaveBeenCalledTimes(1);
    const sqlArg = (pgm.sql as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    // Must check publication existence before creation for idempotency
    expect(sqlArg).toContain('IF NOT EXISTS');
    expect(sqlArg).toContain(`SELECT 1 FROM pg_publication WHERE pubname = '${CONTRACT_EVENTS_PUBLICATION_NAME}'`);
    expect(sqlArg).toContain(`CREATE PUBLICATION ${CONTRACT_EVENTS_PUBLICATION_NAME}`);
  });

  it('strictly scopes publication to contract_events table in up() migration', async () => {
    const pgm = createMockMigrationBuilder();
    await up(pgm);

    const sqlArg = (pgm.sql as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sqlArg).toContain(`FOR TABLE ${LOGICAL_REPLICATION_CONSTANTS.targetTable}`);

    // Must NOT contain sensitive tables like streams or api_keys
    expect(sqlArg).not.toContain('streams');
    expect(sqlArg).not.toContain('api_keys');
    expect(sqlArg).not.toContain('webhook_outbox');
  });

  it('strictly scopes publish parameters to insert ONLY in up() migration', async () => {
    const pgm = createMockMigrationBuilder();
    await up(pgm);

    const sqlArg = (pgm.sql as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sqlArg).toContain("WITH (publish = 'insert')");
    expect(sqlArg).not.toContain('update');
    expect(sqlArg).not.toContain('delete');
    expect(sqlArg).not.toContain('truncate');
  });

  it('executes safe DROP PUBLICATION IF EXISTS in down() migration', async () => {
    const pgm = createMockMigrationBuilder();
    await down(pgm);

    expect(pgm.sql).toHaveBeenCalledTimes(1);
    const sqlArg = (pgm.sql as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sqlArg).toBe(`DROP PUBLICATION IF EXISTS ${CONTRACT_EVENTS_PUBLICATION_NAME};`);
  });

  it('documents valid operational SQL queries for slot attachment and monitoring', () => {
    expect(OPERATIONAL_QUERIES.checkWalLevel).toContain('wal_level');
    expect(OPERATIONAL_QUERIES.createSlot).toContain(LOGICAL_REPLICATION_CONSTANTS.slotName);
    expect(OPERATIONAL_QUERIES.createSlot).toContain('pgoutput');
    expect(OPERATIONAL_QUERIES.dropSlot).toContain(LOGICAL_REPLICATION_CONSTANTS.slotName);
    expect(OPERATIONAL_QUERIES.monitorSlotLag).toContain('pg_replication_slots');
    expect(OPERATIONAL_QUERIES.monitorSlotLag).toContain('confirmed_flush_lsn');
  });
});

// ── Live DB Integration Tests ─────────────────────────────────────────────────

// Keep-gated and intentionally excluded from issue #1248; tracked as live-DB coverage.
describe.skipIf(!isLiveDb)('Postgres Logical Replication (Live DB Integration Tests)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();

    // Ensure contract_events table exists before applying publication migration
    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'contract_events'
       ) AS exists`,
    );

    if (!tableCheck.rows[0]?.exists) {
      throw new Error('contract_events table not found — run base migrations before replication tests');
    }

    // Apply the logical replication up migration
    const pgm = {
      sql: async (query: string) => {
        await client.query(query);
      },
    } as unknown as MigrationBuilder;

    await up(pgm);
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  it('verifies that fluxora_contract_events_pub exists in pg_publication catalog', async () => {
    const res = await client.query<{
      pubname: string;
      pubinsert: boolean;
      pubupdate: boolean;
      pubdelete: boolean;
      pubtruncate: boolean;
    }>(
      `SELECT pubname, pubinsert, pubupdate, pubdelete, pubtruncate
       FROM pg_publication
       WHERE pubname = $1`,
      [CONTRACT_EVENTS_PUBLICATION_NAME],
    );

    expect(res.rows).toHaveLength(1);
    const pub = res.rows[0];
    expect(pub?.pubname).toBe(CONTRACT_EVENTS_PUBLICATION_NAME);
    expect(pub?.pubinsert).toBe(true);
    expect(pub?.pubupdate).toBe(false);
    expect(pub?.pubdelete).toBe(false);
    expect(pub?.pubtruncate).toBe(false);
  });

  it('verifies that fluxora_contract_events_pub is attached solely to contract_events', async () => {
    const res = await client.query<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename
       FROM pg_publication_tables
       WHERE pubname = $1`,
      [CONTRACT_EVENTS_PUBLICATION_NAME],
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.tablename).toBe('contract_events');
  });

  it('verifies rollback and re-apply of the logical replication migration', async () => {
    const pgm = {
      sql: async (query: string) => {
        await client.query(query);
      },
    } as unknown as MigrationBuilder;

    // Test down()
    await down(pgm);
    const checkDown = await client.query(
      `SELECT 1 FROM pg_publication WHERE pubname = $1`,
      [CONTRACT_EVENTS_PUBLICATION_NAME],
    );
    expect(checkDown.rows).toHaveLength(0);

    // Re-apply up() to leave database in clean state
    await up(pgm);
    const checkReUp = await client.query(
      `SELECT 1 FROM pg_publication WHERE pubname = $1`,
      [CONTRACT_EVENTS_PUBLICATION_NAME],
    );
    expect(checkReUp.rows).toHaveLength(1);
  });
});
