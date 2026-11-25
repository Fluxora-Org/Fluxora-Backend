/**
 * Minimal environment loader for the database migration entry point.
 *
 * `src/config/env.ts` validates the full application schema when it is first
 * imported, so anything that transitively imports it (including
 * `config/runtime-env.ts` and `lib/logger.ts`) fails unless Stellar, JWT and
 * indexer secrets are present. Migrations only need a database connection, so
 * `src/db/migrate.ts` reads its settings through this module instead and must
 * not import the application config or anything that depends on it.
 *
 * Only these variables are read:
 *   DATABASE_URL            required; PostgreSQL connection string
 *   DB_CONNECTION_TIMEOUT   optional; ms to wait for a connection (1000-60000)
 *   DATABASE_SSL            optional; "true"/"1" enables TLS,
 *                           "no-verify" enables TLS without certificate checks
 *
 * @module db/migration-env
 */

/** Raised when the migration environment is missing or invalid. */
export class MigrationEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationEnvError';
  }
}

export type MigrationSsl = false | { rejectUnauthorized: boolean };

export interface MigrationEnv {
  databaseUrl: string;
  /** undefined when DB_CONNECTION_TIMEOUT is unset (driver default applies). */
  connectionTimeoutMillis?: number;
  ssl: MigrationSsl;
}

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

function parseDatabaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new MigrationEnvError(
      'DATABASE_URL environment variable is required for migrations ' +
        '(e.g. postgresql://user:password@localhost:5432/fluxora)',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Never echo the value: it usually embeds a password.
    throw new MigrationEnvError('DATABASE_URL must be a valid URL');
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new MigrationEnvError(
      `DATABASE_URL must use the postgres:// or postgresql:// scheme (got "${url.protocol}")`,
    );
  }

  return value;
}

function parseConnectionTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000 || value > 60000) {
    throw new MigrationEnvError(
      'DB_CONNECTION_TIMEOUT must be an integer between 1000 and 60000',
    );
  }
  return value;
}

function parseSsl(raw: string | undefined): MigrationSsl {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return { rejectUnauthorized: true };
  if (value === 'no-verify') return { rejectUnauthorized: false };
  throw new MigrationEnvError(
    'DATABASE_SSL must be one of: true, false, 1, 0, no-verify',
  );
}

/**
 * Parse the settings needed to run migrations. Unrelated variables (Stellar,
 * JWT, indexer, ...) are ignored rather than required.
 *
 * @throws {MigrationEnvError} When DATABASE_URL is missing or any setting is invalid.
 */
export function loadMigrationEnv(env: NodeJS.ProcessEnv = process.env): MigrationEnv {
  return {
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL),
    connectionTimeoutMillis: parseConnectionTimeout(env.DB_CONNECTION_TIMEOUT),
    ssl: parseSsl(env.DATABASE_SSL),
  };
}

type LogLevel = 'info' | 'error';

function write(level: LogLevel, message: string): void {
  // Same single-line JSON shape as src/lib/logger.ts, without pulling in its
  // config-dependent imports.
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message });
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

/** Structured logger used by the migration runner. */
export const migrationLogger = {
  info: (message: string): void => write('info', message),
  error: (message: string): void => write('error', message),
};
