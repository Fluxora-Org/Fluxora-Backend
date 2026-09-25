#!/usr/bin/env node

/**
 * Migration naming policy for node-pg-migrate.
 *
 * Existing names are a compatibility boundary: pgmigrations stores the
 * filename stem, so renaming an applied file can make a production database
 * attempt the same DDL again. `migration-baseline.json` records those names.
 * The baseline is frozen, while every new migration must have one unique,
 * parseable, 13-digit millisecond prefix.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const CANONICAL_MIGRATION = /^\d{13}_[a-z0-9][a-z0-9-]*\.(?:js|ts|mjs|cjs)$/;
export const PREFIX = /^(\d{13})_/;
export const MIGRATION_FILE = /^(\d+)_.*\.(?:js|ts|mjs|cjs)$/;

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

export function formatResult(result) {
  return [
    `Migration naming check passed: ${result.checked} new file(s), ${result.baseline} frozen baseline file(s).`,
    'Legacy and already-applied names are frozen; only new files require the canonical policy.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const migrationsDir = path.resolve(argv[0] ?? 'migrations');
  const baselinePath = path.resolve(argv[1] ?? path.join(migrationsDir, 'migration-baseline.json'));
  try {
    const result = checkDirectory({ migrationsDir, baselinePath });
    console.log(formatResult(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration naming check failed: ${message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
