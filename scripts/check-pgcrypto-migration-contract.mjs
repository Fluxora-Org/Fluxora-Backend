#!/usr/bin/env node

/** Validate the renamed migration's dependency contract without executing DDL. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PGCRYPTO_MIGRATION, STREAMS_MIGRATION, assertPgcryptoName } from './check-pgcrypto-order.mjs';

export const REQUIRED_CONTRACT_MARKERS = Object.freeze(["pgm.createExtension('pgcrypto'", "pgm.addColumns('streams'", 'sender_address_hash', 'recipient_address_hash', 'CREATE OR REPLACE FUNCTION decrypt_stream_address', 'pgm.createIndex', 'pgm.dropColumns']);
export class MigrationContractError extends Error { constructor(code, message, details = {}) { super(message); this.name = 'MigrationContractError'; this.code = code; Object.assign(this, details); } }
export function readMigrationSource(migrationsDir = path.resolve('migrations'), file = PGCRYPTO_MIGRATION) {
  const filePath = path.join(migrationsDir, file);
  if (!fs.existsSync(filePath)) throw new MigrationContractError('FILE_MISSING', `Migration source is missing: ${file}`, { file, filePath });
  return fs.readFileSync(filePath, 'utf8');
}
export function migrationDigest(source) { return crypto.createHash('sha256').update(source, 'utf8').digest('hex'); }
export function missingMarkers(source, markers = REQUIRED_CONTRACT_MARKERS) { return markers.filter((marker) => !source.includes(marker)); }
export function assertMigrationContract(source, { file = PGCRYPTO_MIGRATION } = {}) {
  assertPgcryptoName(file);
  const missing = missingMarkers(source);
  if (missing.length) throw new MigrationContractError('CONTRACT_MARKER_MISSING', `Migration contract markers missing: ${missing.join(', ')}`, { missing, file });
  if (!/export async function up\s*\(/.test(source)) throw new MigrationContractError('UP_EXPORT_MISSING', 'Migration must export an async up function.', { file });
  if (!/export async function down\s*\(/.test(source)) throw new MigrationContractError('DOWN_EXPORT_MISSING', 'Migration must export an async down function.', { file });
  if (!/pgm\.createExtension\('pgcrypto', \{ ifNotExists: true \}\)/.test(source)) throw new MigrationContractError('EXTENSION_NOT_IDEMPOTENT', 'pgcrypto extension creation must be idempotent.', { file });
  if (!/DROP FUNCTION IF EXISTS decrypt_stream_address/.test(source)) throw new MigrationContractError('DOWN_NOT_IDEMPOTENT', 'Rollback must use IF EXISTS for the decrypt function.', { file });
  return { file, digest: migrationDigest(source), markers: REQUIRED_CONTRACT_MARKERS.length, dependency: STREAMS_MIGRATION };
}
export function dependencyEvidence(source) {
  const addColumns = source.indexOf("pgm.addColumns('streams'"); const extension = source.indexOf("pgm.createExtension('pgcrypto'"); const indexes = source.indexOf('pgm.createIndex'); const functionDefinition = source.indexOf('CREATE OR REPLACE FUNCTION');
  return { extensionBeforeStreamMutation: extension >= 0 && addColumns >= 0 && extension < addColumns, streamsMutationBeforeIndexes: addColumns >= 0 && indexes >= 0 && addColumns < indexes, functionDefined: functionDefinition >= 0, streamTable: 'streams', dependency: STREAMS_MIGRATION };
}
export function checkContract(migrationsDir = path.resolve('migrations')) {
  const source = readMigrationSource(migrationsDir); const result = assertMigrationContract(source); const evidence = dependencyEvidence(source);
  if (!evidence.extensionBeforeStreamMutation || !evidence.streamsMutationBeforeIndexes || !evidence.functionDefined) throw new MigrationContractError('DEPENDENCY_EVIDENCE', 'Migration source does not preserve the expected dependency sequence.', { evidence });
  return { ...result, evidence };
}
export function formatContract(result) { return [`Migration contract passed for ${result.file}.`, `${result.markers} required markers present; SHA-256 ${result.digest}.`, `Dependency evidence: ${result.dependency} exists before streams mutation/index setup.`].join('\n'); }
export function main(argv = process.argv.slice(2)) { try { console.log(formatContract(checkContract(path.resolve(argv[0] ?? 'migrations')))); return 0; } catch (error) { console.error(`Migration contract check failed: ${error instanceof Error ? error.message : String(error)}`); return 1; } }
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
