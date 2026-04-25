/**
 * Database migration runner and startup guard.
 *
 * Uses node-pg-migrate to apply migrations to PostgreSQL.
 * Provides checkPendingMigrations() for fail-fast startup validation.
 *
 * @module db/migrate
 */

import { runner } from 'node-pg-migrate';
import fs from 'fs';
import pg from 'pg';
import { info, error as logError } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

/**
 * Derive the migration name that node-pg-migrate stores in pgmigrations
 * from a filename (strips the file extension).
 */
function migrationNameFromFile(filename: string): string {
  return filename.replace(/\.(js|ts|mjs|cjs)$/, '');
}

/**
 * Read migration filenames from disk and return their canonical names.
 */
function getMigrationNamesOnDisk(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /\.(js|ts|mjs|cjs)$/.test(f))
    .sort()
    .map(migrationNameFromFile);
}

/**
 * Query the pgmigrations table for applied migration names.
 * Returns an empty array if the table does not yet exist (fresh DB).
 */
async function getAppliedMigrationNames(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
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
 * Startup migration guard — fail fast if any migrations are pending.
 *
 * Compares migration files on disk against the pgmigrations table.
 * Throws PendingMigrationsError if unapplied migrations are found so
 * the server never starts against a stale schema.
 *
 * @throws {Error} When DATABASE_URL is not set.
 * @throws {PendingMigrationsError} When unapplied migrations exist.
 */
export async function checkPendingMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  info('Checking for pending migrations...');

  const onDisk = getMigrationNamesOnDisk();

  // No migration files on disk — nothing to check.
  if (onDisk.length === 0) {
    info('No migration files found — schema check skipped');
    return;
  }

  const applied = await getAppliedMigrationNames(databaseUrl);
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
 * Run all pending migrations
 */
export async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for migrations');
  }

  try {
    info('Running database migrations...');

    await runner({
      databaseUrl,
      dir: MIGRATIONS_DIR,
      direction: 'up',
      migrationsTable: MIGRATIONS_TABLE,
      count: Infinity,
      logger: {
        info: (msg: string) => info(msg),
        warn: (msg: string) => info(msg), // Mapping warn to info for cleaner logs
        error: (msg: string) => logError(msg),
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
