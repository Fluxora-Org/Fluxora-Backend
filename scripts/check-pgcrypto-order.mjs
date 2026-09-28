#!/usr/bin/env node

/** Verify the dependency-critical placement of the pgcrypto address migration. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const STREAMS_MIGRATION = '1774715131962_streams-table.ts';
export const PGCRYPTO_MIGRATION = '1787788800000_enable_pgcrypto_encrypt_addresses.ts';
export const PGCRYPTO_PREFIX = 1787788800000;

export class MigrationOrderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrationOrderError';
    this.code = code;
    Object.assign(this, details);
  }
}

function prefix(file) {
  const match = /^(\d+)_/.exec(file);
  return match ? Number(match[1]) : null;
}

export function orderedMigrationFiles(files) {
  return [...files]
    .filter((file) => /^\d+_.*\.(?:ts|js|mjs|cjs)$/.test(file))
    .sort((left, right) => (prefix(left) ?? Infinity) - (prefix(right) ?? Infinity) || left.localeCompare(right));
}

export function assertPgcryptoName(name = PGCRYPTO_MIGRATION) {
  if (!/^\d{13}_enable_pgcrypto_encrypt_addresses\.ts$/.test(name)) {
    throw new MigrationOrderError('PGCRYPTO_NAME', `Unexpected pgcrypto migration name: ${name}`, { name });
  }
  if ((prefix(name) ?? 0) <= (prefix(STREAMS_MIGRATION) ?? Infinity)) {
    throw new MigrationOrderError('PGCRYPTO_BEFORE_DEPENDENCY', `${name} must sort after ${STREAMS_MIGRATION}.`, { name, dependency: STREAMS_MIGRATION });
  }
  return true;
}

export function assertMigrationOrder(files, { streams = STREAMS_MIGRATION, pgcrypto = PGCRYPTO_MIGRATION } = {}) {
  assertPgcryptoName(pgcrypto);
  const ordered = orderedMigrationFiles(files);
  const streamsIndex = ordered.indexOf(streams);
  const pgcryptoIndex = ordered.indexOf(pgcrypto);
  if (streamsIndex === -1) throw new MigrationOrderError('STREAMS_MISSING', `Dependency migration is missing: ${streams}`, { streams });
  if (pgcryptoIndex === -1) throw new MigrationOrderError('PGCRYPTO_MISSING', `Target migration is missing: ${pgcrypto}`, { pgcrypto });
  if (ordered.filter((file) => file === pgcrypto).length !== 1) throw new MigrationOrderError('PGCRYPTO_DUPLICATE', `Target migration appears more than once: ${pgcrypto}`, { pgcrypto });
  if (pgcryptoIndex <= streamsIndex) throw new MigrationOrderError('ORDER_INVALID', `${pgcrypto} is ordered before ${streams}; streams must exist first.`, { streamsIndex, pgcryptoIndex });
  return { ordered, streamsIndex, pgcryptoIndex };
}

export function assertNoOldPgcryptoName(files) {
  const old = files.filter((file) => /^20260601_enable_pgcrypto_encrypt_addresses\./.test(file));
  if (old.length) throw new MigrationOrderError('OLD_NAME_PRESENT', `Old unparseable pgcrypto name remains: ${old.join(', ')}`, { old });
  return true;
}

export function checkDirectory(directory = path.resolve('migrations')) {
  const files = fs.readdirSync(directory);
  assertNoOldPgcryptoName(files);
  return assertMigrationOrder(files);
}

export function diagnostic(result) {
  return [
    `pgcrypto migration order passed: ${result.pgcryptoIndex - result.streamsIndex} step(s) after streams-table.`,
    `streams-table index=${result.streamsIndex}; pgcrypto index=${result.pgcryptoIndex}.`,
    `Chosen prefix ${PGCRYPTO_PREFIX} is a 13-digit millisecond timestamp after the dependency.`,
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  try {
    console.log(diagnostic(checkDirectory(path.resolve(argv[0] ?? 'migrations'))));
    return 0;
  } catch (error) {
    console.error(`pgcrypto migration order failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
