/**
 * Runtime proof of the migration atomicity contract (issue #1425).
 *
 * The offline policy gate lives in `scripts/check-migration-atomicity.mjs`.
 * This suite exercises the same contract against a real PostgreSQL server by
 * running node-pg-migrate over a throwaway migrations directory:
 *
 *  1. A transactional migration that fails halfway must leave both the schema
 *     and the `pgmigrations` ledger at the previous, known version — the two
 *     cannot disagree because both the DDL and the ledger insert roll back
 *     together. Re-running after the fix succeeds.
 *  2. A migration that opts out via `pgm.noTransaction()` has no wrapper to
 *     roll back, so the ledger can briefly disagree with the schema. The
 *     manifest in `migrations/atomicity-manifest.json` identifies those
 *     migrations and the checker requires their DDL to be replayable, so the
 *     suite asserts the partial state is present, unrecorded, and re-runnable.
 *
 * The PostgreSQL round trip is opt-in because the default test setup provides a
 * DATABASE_URL even when no database is running:
 *
 *   MIGRATION_ATOMICITY_DATABASE_URL=postgresql://... \
 *     pnpm test -- tests/db/migrations.atomicity.test.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migration, runner } from 'node-pg-migrate';
import type { MigrationBuilder, RunnerOption } from 'node-pg-migrate';
import pg from 'pg';

const databaseUrl = process.env['MIGRATION_ATOMICITY_DATABASE_URL'];

const LEDGER_TABLE = 'atomicity_pgmigrations';
const TX_PROBE_TABLE = 'atomicity_tx_probe';
const NTX_PROBE_TABLE = 'atomicity_ntx_probe';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function writeMigration(directory: string, name: string, source: string): void {
  fs.writeFileSync(path.join(directory, `${name}.js`), source);
}

describe('migration atomicity runtime contract', () => {
  it('is opt-in via MIGRATION_ATOMICITY_DATABASE_URL', () => {
    // Always runs so the guard itself is visible in CI logs.
    expect(typeof databaseUrl === 'string' || databaseUrl === undefined).toBe(true);
  });
});

/**
 * Offline proof of the mechanism the live suite relies on: `Migration._apply`
 * queues `BEGIN;`/`COMMIT;` around the action and appends the ledger insert as
 * the final step, so a rejected step prevents the COMMIT and the ledger write.
 * `pgm.noTransaction()` removes that wrapper.
 */
describe('migration transaction wrapping (offline)', () => {
  interface RecordedQuery {
    sql: string;
    failOn?: string;
  }

  function recordingDb(queries: RecordedQuery[]) {
    const db = {
      async query(sql: string) {
        queries.push({ sql });
        if (!sql.startsWith('BEGIN') && !sql.startsWith('COMMIT') && sql.includes('BOOM')) {
          throw new Error('injected mid-migration failure');
        }
        return { rows: [], rowCount: 0 };
      },
      async select() {
        return [];
      },
      async column() {
        return [];
      },
    };
    return db as never;
  }

  const options = {
    migrationsTable: 'pgmigrations',
    dir: '.',
    direction: 'up',
    schema: 'public',
  } as unknown as RunnerOption;

  function migration(up: (pgm: MigrationBuilder) => void, queries: RecordedQuery[]) {
    return new Migration(
      recordingDb(queries),
      path.join('/migrations', '1000000000000_atomicity_probe.js'),
      { up },
      options,
      undefined,
      silentLogger
    );
  }

  it('wraps a transactional migration and records the version inside the transaction', async () => {
    const queries: RecordedQuery[] = [];
    await migration((pgm) => {
      pgm.sql('CREATE TABLE atomicity_probe (id integer)');
    }, queries).apply('up');

    expect(queries.map((entry) => entry.sql)).toEqual([
      'BEGIN;',
      'CREATE TABLE atomicity_probe (id integer);',
      'INSERT INTO "public"."pgmigrations" (name, run_on) VALUES (\'1000000000000_atomicity_probe\', NOW());',
      'COMMIT;',
    ]);
  });

  it('skips COMMIT and the ledger insert when a transactional step fails', async () => {
    const queries: RecordedQuery[] = [];
    const probe = migration((pgm) => {
      pgm.sql('CREATE TABLE atomicity_probe (id integer)');
      pgm.sql('BOOM');
    }, queries);

    await expect(probe.apply('up')).rejects.toThrow('injected mid-migration failure');

    const sql = queries.map((entry) => entry.sql);
    expect(sql).toContain('BEGIN;');
    expect(sql).not.toContain('COMMIT;');
    expect(sql.some((entry) => entry.startsWith('INSERT INTO'))).toBe(false);
  });

  it('omits the transaction wrapper when noTransaction is requested', async () => {
    const queries: RecordedQuery[] = [];
    await migration((pgm) => {
      pgm.noTransaction();
      pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_atomicity ON atomicity_probe (id)');
    }, queries).apply('up');

    const sql = queries.map((entry) => entry.sql);
    expect(sql).not.toContain('BEGIN;');
    expect(sql).not.toContain('COMMIT;');
    expect(sql.some((entry) => entry.startsWith('INSERT INTO'))).toBe(true);
  });
});

describe.skipIf(!databaseUrl)('migration atomicity (live PostgreSQL)', () => {
  let migrationsDir: string;
  let client: pg.Client;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-atomicity-runner-'));
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await reset();
  });

  afterAll(async () => {
    try {
      if (client) {
        await reset();
      }
    } finally {
      await client?.end();
      if (migrationsDir) {
        fs.rmSync(migrationsDir, { recursive: true, force: true });
      }
    }
  });

  async function reset(): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS ${NTX_PROBE_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${TX_PROBE_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${LEDGER_TABLE} CASCADE`);
  }

  async function apply(): Promise<void> {
    await runner({
      databaseUrl,
      dir: migrationsDir,
      migrationsTable: LEDGER_TABLE,
      direction: 'up',
      count: Infinity,
      logger: silentLogger,
    });
  }

  async function recordedNames(): Promise<string[]> {
    const result = await client.query<{ name: string }>(
      `SELECT name FROM ${LEDGER_TABLE} ORDER BY name`
    );
    return result.rows.map((row) => row.name);
  }

  async function tableExists(name: string): Promise<boolean> {
    const result = await client.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [name]
    );
    return result.rows[0]?.present === true;
  }

  it('rolls a transactional failure back with the ledger and re-runs cleanly', async () => {
    await reset();
    const name = '1000000000000_atomicity_tx_probe';

    writeMigration(
      migrationsDir,
      name,
      `
        module.exports.up = (pgm) => {
          pgm.createTable('${TX_PROBE_TABLE}', { id: 'serial' });
          // Fail after the DDL has been issued but before the ledger insert.
          pgm.sql('SELECT 1/0');
        };
        module.exports.down = (pgm) => {
          pgm.dropTable('${TX_PROBE_TABLE}', { ifExists: true });
        };
      `
    );

    await expect(apply()).rejects.toThrow();

    // The schema and the applied-version record agree: neither advanced.
    expect(await recordedNames()).not.toContain(name);
    expect(await tableExists(TX_PROBE_TABLE)).toBe(false);

    // Re-running the corrected migration succeeds and records the version.
    writeMigration(
      migrationsDir,
      name,
      `
        module.exports.up = (pgm) => {
          pgm.createTable('${TX_PROBE_TABLE}', { id: 'serial' });
        };
        module.exports.down = (pgm) => {
          pgm.dropTable('${TX_PROBE_TABLE}', { ifExists: true });
        };
      `
    );

    await apply();

    expect(await recordedNames()).toContain(name);
    expect(await tableExists(TX_PROBE_TABLE)).toBe(true);
  });

  it('leaves an unrecorded but re-runnable partial state for a non-transactional failure', async () => {
    await reset();
    const name = '1000000000001_atomicity_ntx_probe';

    writeMigration(
      migrationsDir,
      name,
      `
        module.exports.up = (pgm) => {
          pgm.noTransaction();
          pgm.sql('CREATE TABLE IF NOT EXISTS ${NTX_PROBE_TABLE} (id integer);');
          // Fail after the guarded DDL autocommitted.
          pgm.sql('SELECT 1/0');
        };
        module.exports.down = (pgm) => {
          pgm.sql('DROP TABLE IF EXISTS ${NTX_PROBE_TABLE};');
        };
      `
    );

    await expect(apply()).rejects.toThrow();

    // No transaction means no rollback and no ledger row. The manifest marks
    // this migration and the DDL is IF NOT EXISTS, so it is replayable.
    expect(await recordedNames()).not.toContain(name);
    expect(await tableExists(NTX_PROBE_TABLE)).toBe(true);

    writeMigration(
      migrationsDir,
      name,
      `
        module.exports.up = (pgm) => {
          pgm.noTransaction();
          pgm.sql('CREATE TABLE IF NOT EXISTS ${NTX_PROBE_TABLE} (id integer);');
        };
        module.exports.down = (pgm) => {
          pgm.sql('DROP TABLE IF EXISTS ${NTX_PROBE_TABLE};');
        };
      `
    );

    await apply();

    // After the replay, the ledger and the schema agree again.
    expect(await recordedNames()).toContain(name);
    expect(await tableExists(NTX_PROBE_TABLE)).toBe(true);
  });
});
