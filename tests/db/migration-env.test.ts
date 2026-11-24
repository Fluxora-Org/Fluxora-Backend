/**
 * The migration entry point must start with only DATABASE_URL set and must
 * not require application secrets (Stellar, JWT, indexer). See issue #1887.
 */
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadMigrationEnv,
  MigrationEnvError,
  migrationLogger,
} from '../../src/db/migration-env.js';
import { checkPendingMigrations, migrate } from '../../src/db/migrate.js';

const DATABASE_URL = 'postgresql://u:p@localhost:5432/x';

describe('loadMigrationEnv', () => {
  it('accepts an environment with only DATABASE_URL', () => {
    expect(loadMigrationEnv({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      connectionTimeoutMillis: undefined,
      ssl: false,
    });
  });

  it('ignores application secrets it does not need', () => {
    const env = loadMigrationEnv({
      DATABASE_URL,
      JWT_SECRET: '',
      STELLAR_CONTRACT_ADDRESS: 'not-validated-here',
    });
    expect(env.databaseUrl).toBe(DATABASE_URL);
  });

  it('accepts the postgres:// scheme', () => {
    expect(loadMigrationEnv({ DATABASE_URL: 'postgres://u@h/db' }).databaseUrl).toBe(
      'postgres://u@h/db',
    );
  });

  it.each([undefined, '', '   '])('rejects a missing DATABASE_URL (%j)', (value) => {
    expect(() => loadMigrationEnv({ DATABASE_URL: value })).toThrowError(
      /DATABASE_URL environment variable is required/,
    );
  });

  it('rejects a malformed DATABASE_URL without echoing it', () => {
    let caught: unknown;
    try {
      loadMigrationEnv({ DATABASE_URL: 'not a url secretpw' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationEnvError);
    expect((caught as Error).message).toBe('DATABASE_URL must be a valid URL');
    expect((caught as Error).message).not.toContain('secretpw');
  });

  it('rejects non-postgres schemes', () => {
    expect(() => loadMigrationEnv({ DATABASE_URL: 'mysql://u@h/db' })).toThrowError(
      /postgres:\/\/ or postgresql:\/\//,
    );
  });

  it('parses DB_CONNECTION_TIMEOUT and treats blank as unset', () => {
    expect(
      loadMigrationEnv({ DATABASE_URL, DB_CONNECTION_TIMEOUT: '7000' }).connectionTimeoutMillis,
    ).toBe(7000);
    expect(
      loadMigrationEnv({ DATABASE_URL, DB_CONNECTION_TIMEOUT: ' ' }).connectionTimeoutMillis,
    ).toBeUndefined();
  });

  it.each(['abc', '999', '60001', '1500.5'])(
    'rejects an invalid DB_CONNECTION_TIMEOUT (%s)',
    (value) => {
      expect(() =>
        loadMigrationEnv({ DATABASE_URL, DB_CONNECTION_TIMEOUT: value }),
      ).toThrowError(MigrationEnvError);
    },
  );

  it.each([
    ['true', { rejectUnauthorized: true }],
    ['1', { rejectUnauthorized: true }],
    ['no-verify', { rejectUnauthorized: false }],
    ['false', false],
    ['0', false],
    ['', false],
  ] as const)('parses DATABASE_SSL=%j', (value, expected) => {
    expect(loadMigrationEnv({ DATABASE_URL, DATABASE_SSL: value }).ssl).toEqual(expected);
  });

  it('rejects an unknown DATABASE_SSL value', () => {
    expect(() => loadMigrationEnv({ DATABASE_URL, DATABASE_SSL: 'maybe' })).toThrowError(
      /DATABASE_SSL must be one of/,
    );
  });
});

describe('migrationLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes single-line JSON to stdout for info and stderr for error', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    migrationLogger.info('hello');
    migrationLogger.error('boom');

    const infoRecord = JSON.parse(String(out.mock.calls[0][0]));
    const errorRecord = JSON.parse(String(err.mock.calls[0][0]));
    expect(infoRecord).toMatchObject({ level: 'info', message: 'hello' });
    expect(errorRecord).toMatchObject({ level: 'error', message: 'boom' });
    expect(typeof infoRecord.timestamp).toBe('string');
  });
});

describe('migrate() / checkPendingMigrations() without DATABASE_URL', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it('migrate() fails with a clear MigrationEnvError', async () => {
    delete process.env.DATABASE_URL;
    await expect(migrate()).rejects.toThrowError(MigrationEnvError);
    await expect(migrate()).rejects.toThrowError(/DATABASE_URL environment variable is required/);
  });

  it('checkPendingMigrations() fails with a clear MigrationEnvError', async () => {
    delete process.env.DATABASE_URL;
    await expect(checkPendingMigrations()).rejects.toThrowError(MigrationEnvError);
  });
});

describe('migrate CLI entry point (separate process)', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const tsxCli = createRequire(path.join(repoRoot, 'package.json')).resolve('tsx/cli');

  /**
   * Run `tsx src/db/migrate.ts --help` with a deliberately minimal
   * environment: no Stellar, JWT or indexer variables at all.
   */
  function runHelp(extraEnv: Record<string, string>) {
    const baseEnv: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      const value = process.env[key];
      if (value !== undefined) baseEnv[key] = value;
    }
    return spawnSync(process.execPath, [tsxCli, 'src/db/migrate.ts', '--help'], {
      cwd: repoRoot,
      env: { ...baseEnv, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  it('starts with only DATABASE_URL set', () => {
    const result = runHelp({ DATABASE_URL });

    expect(result.stderr).not.toMatch(/STELLAR_CONTRACT_ADDRESS|JWT_SECRET|INDEXER_WORKER_TOKEN/);
    expect(result.stdout).toContain('Usage: pnpm run migrate');
    expect(result.status).toBe(0);
  }, 60_000);

  it('still reports a clear error when DATABASE_URL is missing', () => {
    const result = runHelp({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL environment variable is required');
    expect(result.stderr).not.toMatch(/STELLAR_CONTRACT_ADDRESS|JWT_SECRET|INDEXER_WORKER_TOKEN/);
  }, 60_000);
});
