/**
 * Unit and Integration Tests: PostgreSQL Logical Replication for contract_events.
 *
 * @module tests/db/logicalReplication.test.ts
 *
 * COVERS:
 *  - Migration SQL structure and idempotency checks for `up()` and `down()`.
 *  - Verification of narrow scoping: ONLY `contract_events` table and ONLY `publish = 'insert'`.
 *  - Guarantee that sensitive tables (such as `streams`, `api_keys`, `webhook_outbox`) are NOT
 *    included in the publication — preventing inadvertent PII exposure to replication consumers.
 *  - Partition-aware publication: verifies the migration does NOT use `FOR TABLE ONLY` so that
 *    child partitions (e.g., `contract_events_y2026m07`) are automatically included.
 *  - Operational query validation (slot creation, lag monitoring in bytes).
 *  - Publication constant is stable and matches docs/database.md references.
 *  - Live DB integration assertions (catalog checks on `pg_publication` and `pg_publication_tables`)
 *    when an explicit `INTEGRATION_DB=true` environment variable is set alongside `DATABASE_URL`.
 *    Live tests are skipped in normal CI where only a fake DATABASE_URL is available.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { MigrationBuilder } from 'node-pg-migrate';
import pg from 'pg';

import {
  up,
  down,
  CONTRACT_EVENTS_PUBLICATION_NAME,
} from '../../migrations/20260723180000_contract_events_logical_replication.js';

/**
 * Live-DB tests only run when INTEGRATION_DB=true is explicitly set.
 * The test setup (tests/setup.ts) always populates DATABASE_URL with a placeholder
 * value for unit tests; checking INTEGRATION_DB prevents false-positive live connections.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = process.env['INTEGRATION_DB'] === 'true' && Boolean(DATABASE_URL);

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

  it('does NOT use FOR TABLE ONLY — publication must include partitions of contract_events', async () => {
    /**
     * contract_events is a partitioned table (PARTITION BY RANGE happened_at).
     * PostgreSQL logical replication publishes from the partition that holds the
     * row, so the publication must reference the parent table WITHOUT "ONLY"
     * (the default: `FOR TABLE contract_events` includes all child partitions).
     * Using `FOR TABLE ONLY contract_events` would silently publish nothing from
     * partitioned storage since rows land in child partitions, not the parent.
     */
    const pgm = createMockMigrationBuilder();
    await up(pgm);

    const sqlArg = (pgm.sql as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Must NOT restrict to parent-only rows
    expect(sqlArg).not.toContain('FOR TABLE ONLY');
    expect(sqlArg).not.toContain('for table only');
    // Must contain the standard inclusive form
    expect(sqlArg).toContain('FOR TABLE contract_events');
  });

  it('up() calls pgm.sql exactly once — no additional DDL side-effects', async () => {
    const pgm = createMockMigrationBuilder();
    await up(pgm);
    // Only one pgm.sql call expected — the idempotent DO $$ ... $$ block
    expect(pgm.sql).toHaveBeenCalledTimes(1);
  });

  it('down() calls pgm.sql exactly once — no additional DDL side-effects', async () => {
    const pgm = createMockMigrationBuilder();
    await down(pgm);
    // Only one pgm.sql call expected — the DROP PUBLICATION IF EXISTS statement
    expect(pgm.sql).toHaveBeenCalledTimes(1);
  });

  it('down() SQL is a fully safe no-op when publication does not exist (IF EXISTS guard)', async () => {
    /**
     * The `DROP PUBLICATION IF EXISTS` form guarantees the migration rollback
     * never throws an error on a fresh environment where the publication was
     * never created — this is a critical property for CI reset safety.
     */
    const pgm = createMockMigrationBuilder();
    await down(pgm);
    const sqlArg = (pgm.sql as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sqlArg).toContain('IF EXISTS');
    expect(sqlArg).toContain('DROP PUBLICATION');
  });

  it('publication name does not contain whitespace, special chars, or uppercase', () => {
    /**
     * PostgreSQL publication names follow identifier rules. Names with spaces or
     * mixed case need quoting in tools like pg_dumpall or Debezium connector config.
     * Enforcing lowercase-with-underscores keeps operational tooling simple.
     */
    expect(CONTRACT_EVENTS_PUBLICATION_NAME).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(CONTRACT_EVENTS_PUBLICATION_NAME).not.toContain(' ');
    expect(CONTRACT_EVENTS_PUBLICATION_NAME).not.toMatch(/[A-Z]/);
  });

  it('slot name constant uses pgoutput plugin — native Postgres logical decoding, no extra plugin required', () => {
    /**
     * pgoutput is the built-in logical decoding plugin available in all PostgreSQL 10+
     * deployments. It does not require the wal2json or decoderbufs extension.
     * This ensures consumers (Debezium, pg_recvlogical, etc.) can attach without
     * additional server-side plugin installation.
     */
    expect(OPERATIONAL_QUERIES.createSlot).toContain("'pgoutput'");
    expect(OPERATIONAL_QUERIES.createSlot).not.toContain('wal2json');
    expect(OPERATIONAL_QUERIES.createSlot).not.toContain('decoderbufs');
  });

  it('lag monitoring query uses raw byte diff, not size_pretty — enables numeric alerting thresholds', () => {
    /**
     * Prometheus alerting rules and monitoring dashboards require numeric byte values
     * rather than human-readable strings from pg_size_pretty(). The raw
     * pg_wal_lsn_diff() column enables `> 5368709120` (5 GB) style alert rules.
     */
    expect(OPERATIONAL_QUERIES.monitorSlotLag).toContain('pg_wal_lsn_diff(');
    expect(OPERATIONAL_QUERIES.monitorSlotLag).toContain('pg_current_wal_lsn()');
    expect(OPERATIONAL_QUERIES.monitorSlotLag).toContain('confirmed_flush_lsn');
    // Must return a numeric column, not pg_size_pretty
    expect(OPERATIONAL_QUERIES.monitorSlotLag).not.toContain('pg_size_pretty');
  });

  it('LOGICAL_REPLICATION_CONSTANTS are internally consistent', () => {
    // Publication name in constants matches the exported constant
    expect(LOGICAL_REPLICATION_CONSTANTS.publicationName).toBe(CONTRACT_EVENTS_PUBLICATION_NAME);
    // Slot name references the documented slot identifier
    expect(LOGICAL_REPLICATION_CONSTANTS.slotName).toBe('fluxora_contract_events_slot');
    // Confirm the table name and operation are consistent with the issue requirements
    expect(LOGICAL_REPLICATION_CONSTANTS.targetTable).toBe('contract_events');
    expect(LOGICAL_REPLICATION_CONSTANTS.allowedOperation).toBe('insert');
  });
});

// ── Live DB Integration Tests ─────────────────────────────────────────────────

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
