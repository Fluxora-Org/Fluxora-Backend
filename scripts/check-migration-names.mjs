#!/usr/bin/env node

/**
 * Migration naming policy.
 *
 * Two migration sets are governed here:
 *
 *  1. The timestamped runner set in `migrations/` (node-pg-migrate). Existing
 *     names are a compatibility boundary: pgmigrations stores the filename
 *     stem, so renaming an applied file can make a production database attempt
 *     the same DDL again. `migration-baseline.json` records those names. The
 *     baseline is frozen, while every new migration must have one unique,
 *     parseable, 13-digit millisecond prefix.
 *
 *  2. The feature-level contracts in `src/db/migrations/`. These carry a
 *     three-digit ordinal that defines the applied order, so two files sharing
 *     an ordinal make the order depend on filename sorting instead of intent.
 *     Every ordinal must be unique, every name canonical, and every
 *     renumbering recorded in `contract-ledger.json` so an environment that
 *     applied a migration under its old name is never asked to re-run it.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const CANONICAL_MIGRATION = /^\d{13}_[a-z0-9][a-z0-9-]*\.(?:js|ts|mjs|cjs)$/;
export const PREFIX = /^(\d{13})_/;
export const MIGRATION_FILE = /^(\d+)_.*\.(?:js|ts|mjs|cjs)$/;

/** Canonical feature-level contract: three-digit ordinal, snake_case slug. */
export const CANONICAL_CONTRACT = /^(\d{3})_[a-z0-9][a-z0-9_]*\.ts$/;
export const CONTRACT_FILE = /^(\d+)_.*\.ts$/;

/** Default locations of the two governed sets, relative to the repo root. */
export const DEFAULT_CONTRACT_DIR = 'src/db/migrations';
export const DEFAULT_CONTRACT_LEDGER = 'src/db/migrations/contract-ledger.json';

export class MigrationNameError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationNameError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function migrationFiles(entries) {
  return entries
    .filter((entry) => MIGRATION_FILE.test(entry))
    .sort();
}

export function migrationStem(file) {
  return file.replace(/\.(?:js|ts|mjs|cjs)$/, '');
}

export function migrationPrefix(file) {
  const match = /^(\d+)_/.exec(file);
  return match?.[1];
}

/** Ordinal of a feature-level contract file, without the trailing `_slug`. */
export function contractOrdinal(file) {
  return migrationPrefix(file);
}

export function contractFiles(entries) {
  return entries.filter((entry) => CONTRACT_FILE.test(entry)).sort();
}

function duplicate(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Validate a directory listing. Baseline names are accepted verbatim and are
 * never silently normalized. New names are checked against all old prefixes,
 * making an accidental collision fail before a migration is merged.
 */
export function validateMigrationNames(files, baselineNames = []) {
  const sorted = [...files].sort();
  const baseline = new Set(baselineNames);
  const baselinePrefixes = new Set(baselineNames.map(migrationPrefix).filter(Boolean));
  const currentNames = sorted.map(migrationStem);
  const missingBaseline = [...baseline].filter((name) => !currentNames.includes(name));
  if (missingBaseline.length) {
    throw new MigrationNameError(
      `Baseline migration(s) disappeared: ${missingBaseline.join(', ')}`,
      'BASELINE_MISSING',
      { missingBaseline },
    );
  }

  const candidates = sorted.filter((file) => !baseline.has(migrationStem(file)));
  const invalid = candidates.filter((file) => !CANONICAL_MIGRATION.test(file));
  if (invalid.length) {
    throw new MigrationNameError(
      `Non-canonical migration filename(s): ${invalid.join(', ')}`,
      'NON_CANONICAL',
      { invalid },
    );
  }

  const candidatePrefixes = candidates.map(migrationPrefix);
  const collisions = duplicate(candidatePrefixes);
  const baselineCollisions = candidatePrefixes.filter((prefix) => baselinePrefixes.has(prefix));
  const allCollisions = [...new Set([...collisions, ...baselineCollisions])];
  if (allCollisions.length) {
    throw new MigrationNameError(
      `Migration prefix collision(s): ${allCollisions.join(', ')}`,
      'DUPLICATE_PREFIX',
      { collisions: allCollisions },
    );
  }

  return {
    baseline: baselineNames.length,
    checked: candidates.length,
    prefixes: candidatePrefixes,
    legacy: sorted.filter((file) => baseline.has(migrationStem(file))),
  };
}

export function readBaseline(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new MigrationNameError('Migration baseline must be an array.', 'BASELINE_INVALID');
  }
  const names = parsed.map(String);
  const duplicates = duplicate(names);
  if (duplicates.length) {
    throw new MigrationNameError(`Baseline contains duplicates: ${duplicates.join(', ')}`, 'BASELINE_DUPLICATE');
  }
  return names;
}

export function checkDirectory({ migrationsDir, baselinePath }) {
  const entries = fs.readdirSync(migrationsDir);
  const files = migrationFiles(entries);
  const baseline = readBaseline(baselinePath);
  return validateMigrationNames(files, baseline);
}

/**
 * Validate the feature-level contracts in `src/db/migrations`.
 *
 * The ordinal in the filename *is* the applied order, so this rejects
 * non-canonical names, duplicate ordinals, and a ledger that disagrees with
 * what is on disk (a rename whose old stem is still present, or whose new stem
 * never landed).
 *
 * @param files       Contract filenames (any order; sorted here).
 * @param ledger      Parsed `contract-ledger.json` contents (default: no renames).
 */
export function validateContractMigrations(files, ledger = {}) {
  const sorted = [...files].sort();

  const invalid = sorted.filter((file) => !CANONICAL_CONTRACT.test(file));
  if (invalid.length) {
    throw new MigrationNameError(
      `Non-canonical contract migration filename(s): ${invalid.join(', ')}`,
      'CONTRACT_NON_CANONICAL',
      { invalid },
    );
  }

  const ordinals = sorted.map(contractOrdinal);
  const collisions = duplicate(ordinals);
  if (collisions.length) {
    const owners = collisions.map(
      (ordinal) => `${ordinal} (${sorted.filter((f) => contractOrdinal(f) === ordinal).join(', ')})`
    );
    throw new MigrationNameError(
      `Duplicate contract migration ordinal(s): ${owners.join('; ')}`,
      'DUPLICATE_ORDINAL',
      { collisions },
    );
  }

  const stems = new Set(sorted.map(migrationStem));
  const renames = Array.isArray(ledger.renames) ? ledger.renames : [];
  if (!Array.isArray(ledger.renames) && ledger.renames !== undefined) {
    throw new MigrationNameError('Contract ledger `renames` must be an array.', 'LEDGER_INVALID');
  }

  for (const rename of renames) {
    const from = rename?.from;
    const to = rename?.to;
    if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
      throw new MigrationNameError(
        'Contract ledger entries need string `from` and `to` stems.',
        'LEDGER_INVALID',
        { rename },
      );
    }
    if (stems.has(from)) {
      throw new MigrationNameError(
        `Renamed contract migration is still on disk under its old stem: ${from}`,
        'RENAME_SOURCE_PRESENT',
        { from, to },
      );
    }
    if (!stems.has(to)) {
      throw new MigrationNameError(
        `Contract ledger names a target that is not on disk: ${to}`,
        'RENAME_TARGET_MISSING',
        { from, to },
      );
    }
  }

  return {
    contracts: sorted.length,
    order: sorted,
    ordinals,
    renames: renames.length,
  };
}

export function readContractLedger(filePath) {
  if (!fs.existsSync(filePath)) return { renames: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MigrationNameError('Contract ledger must be a JSON object.', 'LEDGER_INVALID');
  }
  return parsed;
}

export function checkContractDirectory({ contractDir, ledgerPath }) {
  const entries = fs.existsSync(contractDir) ? fs.readdirSync(contractDir) : [];
  const files = contractFiles(entries);
  const ledger = ledgerPath ? readContractLedger(ledgerPath) : { renames: [] };
  return validateContractMigrations(files, ledger);
}

export function formatContractResult(result) {
  return [
    `Contract migration check passed: ${result.contracts} file(s) with unique ordinals.`,
    `Applied order: ${result.order.join(' → ') || '(none)'}.`,
    `${result.renames} recorded rename(s); already-applied environments keep their recorded name.`,
  ].join('\n');
}

export function formatResult(result) {
  return [
    `Migration naming check passed: ${result.checked} new file(s), ${result.baseline} frozen baseline file(s).`,
    'Legacy and already-applied names are frozen; only new files require the canonical policy.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const migrationsDir = path.resolve(argv[0] ?? 'migrations');
  const baselinePath = path.resolve(argv[1] ?? path.join(migrationsDir, 'migration-baseline.json'));
  const contractDir = path.resolve(argv[2] ?? DEFAULT_CONTRACT_DIR);
  const contractLedgerPath = path.resolve(argv[3] ?? DEFAULT_CONTRACT_LEDGER);
  try {
    const result = checkDirectory({ migrationsDir, baselinePath });
    console.log(formatResult(result));
    const contracts = checkContractDirectory({
      contractDir,
      ledgerPath: contractLedgerPath,
    });
    console.log(formatContractResult(contracts));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration naming check failed: ${message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
