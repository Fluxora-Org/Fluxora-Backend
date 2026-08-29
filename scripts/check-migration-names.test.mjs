import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_MIGRATION,
  MigrationNameError,
  checkDirectory,
  formatResult,
  migrationFiles,
  migrationPrefix,
  migrationStem,
  readBaseline,
  validateMigrationNames,
} from './check-migration-names.mjs';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(files, baseline = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-migration-'));
  temporary.push(directory);
  for (const file of files) fs.writeFileSync(path.join(directory, file), 'export function up() {}\n');
  const baselinePath = path.join(directory, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify(baseline));
  return { directory, baselinePath };
}

describe('migration name policy', () => {
  it('recognizes runner files and ignores helpers', () => {
    expect(migrationFiles(['README.md', 'run.ts', '1000000000000_initial_schema.ts', 'legacy.ts']))
      .toEqual(['1000000000000_initial_schema.ts']);
  });

  it('extracts stable stems and prefixes', () => {
    const file = '1774715131962_streams-table.ts';
    expect(migrationStem(file)).toBe('1774715131962_streams-table');
    expect(migrationPrefix(file)).toBe('1774715131962');
  });

  it('requires exactly 13 digits for new files', () => {
    expect(CANONICAL_MIGRATION.test('1774716000000_add-guard.ts')).toBe(true);
    expect(CANONICAL_MIGRATION.test('177471600000_add-guard.ts')).toBe(false);
    expect(CANONICAL_MIGRATION.test('20260827000000_add-guard.ts')).toBe(false);
    expect(CANONICAL_MIGRATION.test('1774716000000_Add-guard.ts')).toBe(false);
    expect(CANONICAL_MIGRATION.test('1774716000000_add-guard.sql')).toBe(false);
  });

  it('accepts a frozen baseline even when its historical format is old', () => {
    const files = ['20260601_enable_pgcrypto_encrypt_addresses.ts'];
    const result = validateMigrationNames(files, ['20260601_enable_pgcrypto_encrypt_addresses']);
    expect(result).toMatchObject({ baseline: 1, checked: 0 });
  });

  it('accepts a new canonical file next to a frozen baseline', () => {
    const files = [
      '20260601_enable_pgcrypto_encrypt_addresses.ts',
      '1774716000000_add-guard.ts',
    ];
    const result = validateMigrationNames(files, ['20260601_enable_pgcrypto_encrypt_addresses']);
    expect(result.checked).toBe(1);
    expect(result.prefixes).toEqual(['1774716000000']);
  });

  it('rejects a duplicate among new files', () => {
    expect(() => validateMigrationNames([
      '1774716000000_first.ts',
      '1774716000000_second.ts',
    ])).toThrow(MigrationNameError);
    try { validateMigrationNames(['1774716000000_first.ts', '1774716000000_second.ts']); } catch (error) {
      expect(error.code).toBe('DUPLICATE_PREFIX');
      expect(error.collisions).toEqual(['1774716000000']);
    }
  });

  it('rejects a new file colliding with a frozen prefix', () => {
    expect(() => validateMigrationNames(
      ['1774716000000_new.ts'],
      ['1774716000000_applied'],
    )).toThrow(/1774716000000/);
  });

  it.each([
    '20260827000000_wrong-width.ts',
    '1774716000000_Uppercase.ts',
    '1774716000000_bad_name.sql',
    '1774716000000_.ts',
    '1774716000000_bad space.ts',
  ])('rejects non-canonical new name %s', (file) => {
    expect(() => validateMigrationNames([file])).toThrow(MigrationNameError);
    expect(() => validateMigrationNames([file])).toThrow(/Non-canonical/);
  });

  it('rejects a missing baseline file rather than silently forgetting history', () => {
    expect(() => validateMigrationNames(
      ['1774716000000_new.ts'],
      ['1774715000000_missing'],
    )).toThrow(/disappeared/);
  });

  it('rejects duplicate entries in the baseline', () => {
    expect(() => readBaselineFromJson(['a', 'a'])).toThrow('Baseline contains duplicates');
  });

  it('checks a real temporary directory and reports the counts', () => {
    const { directory, baselinePath } = fixture(
      ['1000000000000_initial.ts', '1774716000000_new.ts', 'README.md'],
      ['1000000000000_initial'],
    );
    const result = checkDirectory({ migrationsDir: directory, baselinePath });
    expect(formatResult(result)).toContain('1 new file(s)');
    expect(formatResult(result)).toContain('1 frozen baseline file(s)');
  });

  it('excludes non-runner helper files from the directory check', () => {
    const { directory, baselinePath } = fixture(
      ['1000000000000_initial.ts', 'README.md', 'not-a-migration.ts'],
      ['1000000000000_initial'],
    );
    expect(checkDirectory({ migrationsDir: directory, baselinePath }).checked).toBe(0);
  });

  it('keeps output deterministic for sorted input', () => {
    const result = validateMigrationNames([
      '1774716000001_second.ts',
      '1774716000000_first.ts',
    ]);
    expect(result.prefixes).toEqual(['1774716000000', '1774716000001']);
  });

  it('does not mutate the caller arrays', () => {
    const files = ['1774716000001_second.ts', '1774716000000_first.ts'];
    const baseline = [];
    validateMigrationNames(files, baseline);
    expect(files).toEqual(['1774716000001_second.ts', '1774716000000_first.ts']);
    expect(baseline).toEqual([]);
  });

  it('returns the frozen names for audit logging', () => {
    const result = validateMigrationNames(
      ['20260601_old.ts', '1774716000000_new.ts'],
      ['20260601_old'],
    );
    expect(result.legacy).toEqual(['20260601_old.ts']);
  });

  describe('boundary cases for the canonical format', () => {
    it.each([
      '0000000000000_zero.ts',
      '9999999999999_max.ts',
      '1774716000000_a.ts',
      '1774716000000_a1.ts',
      '1774716000000_a-b.ts',
      '1774716000000_a.mjs',
      '1774716000000_a.cjs',
    ])('accepts valid candidate %s', (file) => {
      expect(validateMigrationNames([file]).checked).toBe(1);
    });

    it.each([
      '1774716000000-underscore.ts',
      '1774716000000_a..ts',
      '1774716000000_a/.ts',
      '1774716000000_a.ts.bak',
      '1774716000000_a.json',
      '1774716000000_á.ts',
      '1774716000000_A.ts',
      '1774716000000_a B.ts',
      '1774716000000_.ts',
    ])('rejects invalid candidate %s', (file) => {
      expect(() => validateMigrationNames([file])).toThrow(MigrationNameError);
    });

    it('detects collisions regardless of extension', () => {
      expect(() => validateMigrationNames([
        '1774716000000_first.ts',
        '1774716000000_second.js',
      ])).toThrow(/collision/);
    });

    it('detects three-way collisions and reports one stable prefix', () => {
      expect(() => validateMigrationNames([
        '1774716000000_a.ts',
        '1774716000000_b.ts',
        '1774716000000_c.ts',
      ])).toThrow('1774716000000');
    });

    it('allows multiple historical files with one frozen prefix', () => {
      const files = [
        '20260624000000_a.ts',
        '20260624000000_b.ts',
        '20260624000000_c.ts',
      ];
      expect(validateMigrationNames(files, [
        '20260624000000_a',
        '20260624000000_b',
        '20260624000000_c',
      ]).checked).toBe(0);
    });

    it('rejects a new file against a frozen prefix even when the slug differs', () => {
      expect(() => validateMigrationNames(
        ['1774716000000_new_feature.ts'],
        ['1774716000000_old_feature'],
      )).toThrow(MigrationNameError);
    });

    it('rejects a baseline that is not JSON array data', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-baseline-object-'));
      temporary.push(directory);
      const file = path.join(directory, 'baseline.json');
      fs.writeFileSync(file, JSON.stringify({ name: 'not-an-array' }));
      expect(() => readBaseline(file)).toThrow('must be an array');
    });

    it('stringifies baseline entries consistently', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-baseline-values-'));
      temporary.push(directory);
      const file = path.join(directory, 'baseline.json');
      fs.writeFileSync(file, JSON.stringify([123, 'abc']));
      expect(readBaseline(file)).toEqual(['123', 'abc']);
    });

    it('preserves the baseline order in the reported count', () => {
      const result = validateMigrationNames(
        ['1774715000000_old-a.ts', '1774715000001_old-b.ts', '1774716000001_new.ts', '1774716000000_old.ts'],
        ['1774715000000_old-a', '1774715000001_old-b'],
      );
      expect(result.baseline).toBe(2);
      expect(result.checked).toBe(2);
    });

    it('handles an empty migration directory', () => {
      const { directory, baselinePath } = fixture([], []);
      expect(checkDirectory({ migrationsDir: directory, baselinePath })).toMatchObject({
        baseline: 0,
        checked: 0,
      });
    });

    it('does not treat legacy directory names as candidates in a listing', () => {
      expect(migrationFiles([
        '1774716000000_live.ts',
        'legacy/001_old.ts',
        'legacy.ts',
      ])).toEqual(['1774716000000_live.ts']);
    });

    it('keeps error details available to CI reporters', () => {
      try {
        validateMigrationNames(['1774716000000_a.ts', '1774716000000_b.ts']);
        throw new Error('expected validation failure');
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationNameError);
        expect(error.code).toBe('DUPLICATE_PREFIX');
        expect(error.collisions).toEqual(['1774716000000']);
      }
    });
  });
});

function readBaselineFromJson(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-baseline-'));
  temporary.push(directory);
  const file = path.join(directory, 'baseline.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return readBaseline(file);
}
