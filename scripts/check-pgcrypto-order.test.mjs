import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationOrderError, PGCRYPTO_MIGRATION, PGCRYPTO_PREFIX, STREAMS_MIGRATION, assertMigrationOrder, assertNoOldPgcryptoName, assertPgcryptoName, checkDirectory, diagnostic, orderedMigrationFiles } from './check-pgcrypto-order.mjs';

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function directory(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-pgcrypto-'));
  temporary.push(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
}

const validFiles = ['1000000000000_initial_schema.ts', STREAMS_MIGRATION, '1774715200000_audit-and-webhook-outbox.ts', PGCRYPTO_MIGRATION];

describe('pgcrypto migration dependency order', () => {
  it('uses a 13-digit prefix after streams', () => {
    expect(PGCRYPTO_PREFIX).toBeGreaterThan(1774715131962);
    expect(PGCRYPTO_MIGRATION).toMatch(/^\d{13}_enable_pgcrypto_encrypt_addresses\.ts$/);
    expect(assertPgcryptoName()).toBe(true);
  });
  it('sorts numeric prefixes before suffixes', () => {
    const ordered = orderedMigrationFiles([PGCRYPTO_MIGRATION, STREAMS_MIGRATION, '1774715131962_z-last.ts', '1774715131962_a-first.ts']);
    expect(ordered.indexOf(PGCRYPTO_MIGRATION)).toBeGreaterThan(ordered.indexOf(STREAMS_MIGRATION));
    expect(ordered.indexOf('1774715131962_a-first.ts')).toBeLessThan(ordered.indexOf('1774715131962_z-last.ts'));
  });
  it('passes the complete fixture', () => {
    const result = assertMigrationOrder(validFiles);
    expect(result.pgcryptoIndex).toBeGreaterThan(result.streamsIndex);
    expect(diagnostic(result)).toContain('passed');
  });
  it('checks a directory without PostgreSQL', () => expect(checkDirectory(directory(validFiles)).pgcryptoIndex).toBe(3));
  it('rejects the old eight-digit name', () => expect(() => assertPgcryptoName('20260601_enable_pgcrypto_encrypt_addresses.ts')).toThrow(/Unexpected/));
  it('rejects a 14-digit replacement', () => expect(() => assertPgcryptoName('20260827000000_enable_pgcrypto_encrypt_addresses.ts')).toThrow(/Unexpected/));
  it('rejects a prefix before streams', () => expect(() => assertPgcryptoName('1000000000001_enable_pgcrypto_encrypt_addresses.ts')).toThrow(/sort after/));
  it('rejects a different slug', () => expect(() => assertPgcryptoName('1787788800000_enable_pgcrypto.ts')).toThrow(/Unexpected/));
  it('rejects an old name in a directory', () => expect(() => assertNoOldPgcryptoName([...validFiles, '20260601_enable_pgcrypto_encrypt_addresses.ts'])).toThrow(/Old unparseable/));
  it('reports old names as structured details', () => {
    try { assertNoOldPgcryptoName(['20260601_enable_pgcrypto_encrypt_addresses.ts']); } catch (error) {
      expect(error).toBeInstanceOf(MigrationOrderError); expect(error.code).toBe('OLD_NAME_PRESENT'); expect(error.old).toHaveLength(1);
    }
  });
  it('rejects missing streams', () => expect(() => assertMigrationOrder([PGCRYPTO_MIGRATION])).toThrow(/Dependency migration is missing/));
  it('rejects missing pgcrypto', () => expect(() => assertMigrationOrder([STREAMS_MIGRATION])).toThrow(/Target migration is missing/));
  it('ignores helpers and non-migration files', () => expect(orderedMigrationFiles([...validFiles, 'README.md', 'run.ts', 'legacy/001_old.ts'])).toEqual(validFiles));
  it('keeps the chosen timestamp in diagnostics', () => expect(diagnostic(assertMigrationOrder(validFiles))).toContain(String(PGCRYPTO_PREFIX)));
  it.each(['1787788800000_enable_pgcrypto_encrypt_addresses.js', '1787788800000_enable_pgcrypto_encrypt_addresses.mjs'])('requires the actual TypeScript file, not %s', (name) => expect(() => assertPgcryptoName(name)).toThrow(MigrationOrderError));
  it('does not mutate file lists', () => { const files = [...validFiles]; assertMigrationOrder(files); expect(files).toEqual(validFiles); });
  it('accepts later unrelated migrations', () => expect(assertMigrationOrder([...validFiles, '1787788800001_next_change.ts']).ordered.at(-1)).toBe('1787788800001_next_change.ts'));
  it('rejects a custom target placed before the dependency', () => expect(() => assertMigrationOrder([STREAMS_MIGRATION, '1774715000000_enable_pgcrypto_encrypt_addresses.ts'], { pgcrypto: '1774715000000_enable_pgcrypto_encrypt_addresses.ts' })).toThrow(/sort after/));
  it('rejects a directory containing the old target even if the new target exists', () => expect(() => checkDirectory(directory([...validFiles, '20260601_enable_pgcrypto_encrypt_addresses.ts']))).toThrow(MigrationOrderError));
  it('returns indexes suitable for ordered-list evidence', () => { const result = assertMigrationOrder(validFiles); expect(result.ordered[result.streamsIndex]).toBe(STREAMS_MIGRATION); expect(result.ordered[result.pgcryptoIndex]).toBe(PGCRYPTO_MIGRATION); });
  it('allows unrelated nonnumeric files beside migrations', () => expect(orderedMigrationFiles(['README', '.gitkeep', ...validFiles])).toHaveLength(validFiles.length));
  it.each(['1787788800000_Enable_pgcrypto_encrypt_addresses.ts', '1787788800000_enable-pgcrypto-encrypt-addresses.ts', '1787788800000_enable_pgcrypto_encrypt_addresses.sql'])('rejects a name variation %s', (name) => expect(() => assertPgcryptoName(name)).toThrow(MigrationOrderError));
  it('distinguishes missing target from invalid target name', () => { try { assertMigrationOrder([STREAMS_MIGRATION], { pgcrypto: 'bad.ts' }); } catch (error) { expect(error.code).toBe('PGCRYPTO_NAME'); } });
  it('uses stable numeric ordering when names have long prefixes', () => expect(orderedMigrationFiles(['9999999999999_late.ts', '1000000000000_early.ts'])[0]).toBe('1000000000000_early.ts'));
  it('detects the old stem even when an unexpected extension is used', () => expect(() => assertNoOldPgcryptoName(['20260601_enable_pgcrypto_encrypt_addresses.sql'])).toThrow(MigrationOrderError));
  it('includes the dependency distance in diagnostics', () => expect(diagnostic(assertMigrationOrder(validFiles))).toContain('2 step(s)'));
  it('rejects a duplicate target entry as order ambiguity', () => expect(() => assertMigrationOrder([...validFiles, PGCRYPTO_MIGRATION])).toThrow(MigrationOrderError));
});
