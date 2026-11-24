/**
 * Database migration runner and startup guard.
 *
 * Uses node-pg-migrate to apply migrations to PostgreSQL.
 * Provides checkPendingMigrations() for fail-fast startup validation.
 *
 * This module must stay independent of `src/config/env.ts` (directly or via
 * `config/runtime-env.ts` / `lib/logger.ts`): that module validates every
 * application secret on import, and the migration job only needs
 * DATABASE_URL. Settings come from {@link loadMigrationEnv} instead.
 *
 * @module db/migrate
 */

import { runner } from 'node-pg-migrate';
import fs from 'fs';
import pg from 'pg';
import path from 'path';
import {
  loadMigrationEnv,
  migrationLogger,
  type MigrationEnv,
} from './migration-env.js';

const { info, error: logError } = migrationLogger;


const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const MIGRATIONS_TABLE = 'pgmigrations';

/**
 * Thrown when the database has unapplied migrations at startup.
 * The server refuses to start until migrations are applied.
 */
export class PendingMigrationsError extends Error {
  constructor(public readonly pending: string[]) {
    super(
      `Database has ${pending.length} pending migration(s). ` +
        `Run migrations before starting the server.\n` +
        `Pending: ${pending.join(', ')}`,
    );
    this.name = 'PendingMigrationsError';
  }
}

/** pg client settings derived from the migration environment. */
function clientConfig(env: MigrationEnv): pg.ClientConfig {
  return {
    connectionString: env.databaseUrl,
    ssl: env.ssl,
    ...(env.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: env.connectionTimeoutMillis }
      : {}),
  };
}

/**
 * Derive the migration name that node-pg-migrate stores in pgmigrations
 * from a filename (strips the file extension).
 */
function migrationNameFromFile(filename: string): string {
  return filename.replace(/\.(js|ts|mjs|cjs)$/, '');
}

/**
 * Read migration filenames from disk and return their canonical names.
 *
 * Only files whose names begin with one or more digits (node-pg-migrate's
 * timestamp-prefix convention) are included.  This naturally excludes helper
 * files in the migrations/ directory such as the `run.ts` tombstone.
 */
function getMigrationNamesOnDisk(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.(js|ts|mjs|cjs)$/.test(f))
    .sort()
    .map(migrationNameFromFile);
}

/**
 * Query the pgmigrations table for applied migration names.
 * Returns an empty array if the table does not yet exist (fresh DB).
 */
async function getAppliedMigrationNames(env: MigrationEnv): Promise<string[]> {
  const client = new pg.Client(clientConfig(env));
  await client.connect();
  try {
    // Check whether the migrations table exists before querying it.
    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = $1
       ) AS exists`,
      [MIGRATIONS_TABLE],
    );
    if (!tableCheck.rows[0]?.exists) {
      return [];
    }
    const result = await client.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
    );
    return result.rows.map((r) => r.name);
  } finally {
    await client.end();
  }
}

/**
 * Return the latest applied migration name, or null if no migrations have been
 * applied (fresh database or missing migrations table).
 *
 * Migration names are timestamp-prefixed strings that sort lexicographically,
 * so the last entry in `ORDER BY name` is the most recent.
 *
 * @param databaseUrl - PostgreSQL connection string.
 * @returns The latest migration name, or null.
 */
export async function getLatestAppliedMigration(
  databaseUrl: string,
): Promise<string | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = $1
       ) AS exists`,
      [MIGRATIONS_TABLE],
    );
    if (!tableCheck.rows[0]?.exists) {
      return null;
    }
    const result = await client.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name DESC LIMIT 1`,
    );
    return result.rows[0]?.name ?? null;
  } finally {
    await client.end();
  }
}

/**
 * Startup migration guard — fail fast if any migrations are pending.
 *
 * Compares migration files on disk against the pgmigrations table.
 * Throws PendingMigrationsError if unapplied migrations are found so
 * the server never starts against a stale schema.
 *
 * @throws {MigrationEnvError} When DATABASE_URL is missing or invalid.
 * @throws {PendingMigrationsError} When unapplied migrations exist.
 */
export async function checkPendingMigrations(): Promise<void> {
  const env = loadMigrationEnv();

  info('Checking for pending migrations...');

  const onDisk = getMigrationNamesOnDisk();

  // No migration files on disk — nothing to check.
  if (onDisk.length === 0) {
    info('No migration files found — schema check skipped');
    return;
  }

  const applied = await getAppliedMigrationNames(env);
  const appliedSet = new Set(applied);
  const pending = onDisk.filter((name) => !appliedSet.has(name));

  if (pending.length > 0) {
    const err = new PendingMigrationsError(pending);
    logError(err.message);
    throw err;
  }

  info(`All ${onDisk.length} migration(s) applied — schema is up to date`);
}

/**
 * Run all pending migrations.
 *
 * @throws {MigrationEnvError} When DATABASE_URL is missing or invalid.
 */
export async function migrate(): Promise<void> {
  const env = loadMigrationEnv();

  try {
    info('Running database migrations...');

    await runner({
      databaseUrl: clientConfig(env),
      dir: MIGRATIONS_DIR,
      // Keep the checked-in migration baseline beside the migration files for
      // naming-policy validation, but never ask node-pg-migrate to load JSON
      // as an executable migration.
      ignorePattern: '.*\\.json$',
      direction: 'up',
      migrationsTable: MIGRATIONS_TABLE,
      count: Infinity,
      logger: {
        info: (msg: string) => info(msg),
        warn: (msg: string) => info(msg), // Mapping warn to info for cleaner logs
        error: (msg: string) => {
          // node-pg-migrate 7.x only recognizes 13- or 17-digit numeric
          // prefixes, while this repository intentionally uses 14-digit UTC
          // prefixes for several historical migrations. It still sorts them
          // numerically, so downgrade this known compatibility diagnostic to
          // informational output instead of making a successful migration look
          // failed.
          if (msg.startsWith("Can't determine timestamp for ")) {
            info(msg);
            return;
          }
          logError(msg);
        },
      },
    });

    info('Migrations completed successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logError(`Migration failure: ${message}`);
    throw err;
  }
}

/**
 * Initialize migrations as part of setup
 */
export async function initializeMigrations(): Promise<void> {
  await migrate();
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Run `pnpm run migrate` → `tsx src/db/migrate.ts`
// The fileURLToPath / process.argv comparison works for both ESM and tsx.
const isMain =
  process.argv[1] === __filename ||
  process.argv[1]?.endsWith('migrate.ts') ||
  process.argv[1]?.endsWith('migrate.js');

export const MIGRATE_USAGE = `Usage: pnpm run migrate [--help]

Applies all pending migrations in ./migrations (direction: up).

Environment:
  DATABASE_URL            PostgreSQL connection string (required)
  DB_CONNECTION_TIMEOUT   Connection timeout in ms, 1000-60000 (optional)
  DATABASE_SSL            true | false | no-verify (optional, default false)

No application secrets (Stellar, JWT, indexer) are needed.`;

if (isMain && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  try {
    // Validate the environment so `--help` doubles as a configuration check.
    loadMigrationEnv();
    process.stdout.write(`${MIGRATE_USAGE}
`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${MIGRATE_USAGE}
`);
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (isMain) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
