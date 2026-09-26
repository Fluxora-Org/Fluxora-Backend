import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationAtomicityError,
  analyzeMigration,
  checkDirectory,
  checkReRunnable,
  checkSqlStatement,
  extractFunctionBody,
  findPgmCalls,
  formatResult,
  migrationFiles,
  migrationStem,
  readManifest,
  stripJsComments,
  unwrapSqlLiteral,
} from './check-migration-atomicity.mjs';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(files, manifest = { nonTransactional: [] }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-atomicity-'));
  temporary.push(directory);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), body);
  }
  const manifestPath = path.join(directory, 'atomicity-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { directory, manifestPath };
}

const TRANSACTIONAL = `
export async function up(pgm) {
  pgm.createTable('widgets', { id: 'serial' }, { ifNotExists: false });
}
export async function down(pgm) {
  pgm.dropTable('widgets');
}
`;

const NON_TX_SAFE = `
export async function up(pgm) {
  pgm.noTransaction();
  pgm.createIndex('widgets', ['status', 'id'], { name: 'idx_widgets_status_id', concurrently: true, ifNotExists: true });
  pgm.sql(\`
    -- build without blocking writes
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_widgets_url ON widgets (url);
    DROP INDEX CONCURRENTLY IF EXISTS idx_widgets_old;
  \`);
}
`;

describe('migration atomicity source analysis', () => {
  it('filters runner files out of directory listings', () => {
    expect(
      migrationFiles(['README.md', 'atomicity-manifest.json', '1000000000000_x.ts', 'run.ts'])
    ).toEqual(['1000000000000_x.ts']);
  });

  it('extracts migration stems', () => {
    expect(migrationStem('20260624000000_streams_created_at_id_tiebreaker_index.ts')).toBe(
      '20260624000000_streams_created_at_id_tiebreaker_index'
    );
  });

  it('keeps string and template contents while dropping comments', () => {
    const source = `
      // http://example.com is not a comment start
      const url = 'https://example.com/path';
      /* block
         comment */
      pgm.sql(\`-- keep me
        CREATE INDEX IF NOT EXISTS x ON y (z);
      \`);
    `;
    const stripped = stripJsComments(source);
    expect(stripped).not.toContain('block');
    expect(stripped).toContain('https://example.com/path');
    expect(stripped).toContain('CREATE INDEX IF NOT EXISTS x ON y (z);');
    expect(stripped).toContain('-- keep me');
  });

  it('extracts a function body without stopping at braces inside strings', () => {
    const body = extractFunctionBody(
      'export function up(pgm) { const s = "a{b}c"; return s; }',
      'up'
    );
    expect(body).toContain('a{b}c');
    expect(body).toContain('return s;');
  });

  it('returns null for a missing function', () => {
    expect(extractFunctionBody('export async function down() {}', 'up')).toBeNull();
  });

  it('finds pgm method calls with balanced arguments', () => {
    const calls = findPgmCalls(
      `pgm.createIndex('t', ['a', 'b'], { name: 'i', ifNotExists: true });`,
      'createIndex'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('ifNotExists: true');
  });

  it('unwraps template literals and quoted SQL', () => {
    expect(unwrapSqlLiteral('`CREATE TABLE x (id int)`')).toBe('CREATE TABLE x (id int)');
    expect(unwrapSqlLiteral("'DROP TABLE x'")).toBe('DROP TABLE x');
  });

  it('classifies a default migration as transactional', () => {
    const analysis = analyzeMigration(TRANSACTIONAL);
    expect(analysis.nonTransactional).toBe(false);
    expect(analysis.problems).toEqual([]);
  });

  it('classifies a noTransaction migration as explicitly non-transactional', () => {
    const analysis = analyzeMigration(NON_TX_SAFE);
    expect(analysis.nonTransactional).toBe(true);
    expect(analysis.upNoTransaction).toBe(true);
    expect(analysis.problems).toEqual([]);
  });

  it('flags an unguarded createIndex outside a transaction', () => {
    const analysis = analyzeMigration(`
      export async function up(pgm) {
        pgm.noTransaction();
        pgm.createIndex('widgets', 'status');
      }
    `);
    expect(analysis.problems.join(' ')).toContain('ifNotExists');
  });

  it('flags an unguarded dropIndex outside a transaction', () => {
    const problems = checkReRunnable(`pgm.noTransaction(); pgm.dropIndex('widgets', 'status');`);
    expect(problems.join(' ')).toContain('ifExists');
  });

  it('flags a non-idempotent SQL statement outside a transaction', () => {
    const problems = checkReRunnable('pgm.sql(`CREATE INDEX idx ON t (c);`);');
    expect(problems.join(' ')).toContain('IF NOT EXISTS');
  });

  it('flags data mutations outside a transaction', () => {
    const problems = checkReRunnable(`pgm.sql(\`UPDATE widgets SET status = 'ok';\`);`);
    expect(problems.join(' ')).toContain('not idempotent');
  });

  it('accepts guarded DDL statements', () => {
    expect(checkSqlStatement('CREATE TABLE IF NOT EXISTS t (id int)')).toEqual([]);
    expect(checkSqlStatement('DROP INDEX CONCURRENTLY IF EXISTS i')).toEqual([]);
    expect(checkSqlStatement('ALTER TABLE t ADD COLUMN IF NOT EXISTS c int')).toEqual([]);
    expect(checkSqlStatement('CREATE EXTENSION IF NOT EXISTS pgcrypto')).toEqual([]);
  });

  it('rejects unguarded DDL statements', () => {
    expect(checkSqlStatement('CREATE TABLE t (id int)').join(' ')).toContain('IF NOT EXISTS');
    expect(checkSqlStatement('DROP TABLE t').join(' ')).toContain('IF EXISTS');
    expect(checkSqlStatement('ALTER TABLE t ADD COLUMN c int').join(' ')).toContain(
      'IF NOT EXISTS'
    );
  });
});

describe('atomicity manifest', () => {
  it('rejects a missing manifest', () => {
    expect(() => readManifest(path.join(os.tmpdir(), 'nope-atomicity.json'))).toThrow(
      MigrationAtomicityError
    );
  });

  it('rejects an entry without a reason', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-manifest-'));
    temporary.push(directory);
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ nonTransactional: [{ name: 'x' }] }));
    expect(() => readManifest(file)).toThrow(/reason/);
  });

  it('rejects duplicate names', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-manifest-'));
    temporary.push(directory);
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        nonTransactional: [
          { name: 'x', reason: 'a valid reason here' },
          { name: 'x', reason: 'another valid reason' },
        ],
      })
    );
    expect(() => readManifest(file)).toThrow(/duplicates/);
  });
});

describe('checkDirectory', () => {
  it('passes a transactional migration with an empty manifest', () => {
    const { directory, manifestPath } = fixture({ '1000000000000_ok.ts': TRANSACTIONAL });
    const result = checkDirectory({ migrationsDir: directory, manifestPath });
    expect(result.transactional).toEqual(['1000000000000_ok']);
    expect(result.nonTransactional).toEqual([]);
  });

  it('passes a manifested, re-runnable non-transactional migration', () => {
    const { directory, manifestPath } = fixture(
      { '1000000000001_idx.ts': NON_TX_SAFE },
      {
        nonTransactional: [
          { name: '1000000000001_idx', reason: 'CONCURRENTLY requires no transaction' },
        ],
      }
    );
    const result = checkDirectory({ migrationsDir: directory, manifestPath });
    expect(result.nonTransactional).toEqual(['1000000000001_idx']);
    expect(formatResult(result)).toContain('1 explicitly non-transactional');
  });

  it('rejects an unlisted non-transactional migration', () => {
    const { directory, manifestPath } = fixture({ '1000000000001_idx.ts': NON_TX_SAFE });
    expect(() => checkDirectory({ migrationsDir: directory, manifestPath })).toThrow(
      /without an atomicity manifest entry/
    );
  });

  it('rejects a manifested migration that is not re-runnable', () => {
    const { directory, manifestPath } = fixture(
      {
        '1000000000001_idx.ts': `
          export async function up(pgm) {
            pgm.noTransaction();
            pgm.createIndex('widgets', 'status');
          }
        `,
      },
      {
        nonTransactional: [
          { name: '1000000000001_idx', reason: 'CONCURRENTLY requires no transaction' },
        ],
      }
    );
    expect(() => checkDirectory({ migrationsDir: directory, manifestPath })).toThrow(
      /not safely re-runnable/
    );
  });

  it('rejects a stale manifest entry', () => {
    const { directory, manifestPath } = fixture(
      { '1000000000000_ok.ts': TRANSACTIONAL },
      {
        nonTransactional: [
          { name: '1000000000009_gone', reason: 'this migration no longer exists' },
        ],
      }
    );
    expect(() => checkDirectory({ migrationsDir: directory, manifestPath })).toThrow(
      /unknown migration/
    );
  });
});
