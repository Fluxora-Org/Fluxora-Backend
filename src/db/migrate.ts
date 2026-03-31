/**
 * Database migration runner
 *
 * Uses node-pg-migrate to apply migrations to PostgreSQL.
 *
 * @module db/migrate
 */

import { runner } from 'node-pg-migrate';
import { info, error as logError } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      dir: path.join(__dirname, '../../migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
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
