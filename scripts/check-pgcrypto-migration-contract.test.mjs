import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationContractError, REQUIRED_CONTRACT_MARKERS, assertMigrationContract, checkContract, dependencyEvidence, formatContract, migrationDigest, missingMarkers, readMigrationSource } from './check-pgcrypto-migration-contract.mjs';
import { PGCRYPTO_MIGRATION } from './check-pgcrypto-order.mjs';
const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function tempFile(source, name = PGCRYPTO_MIGRATION) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-contract-')); temporary.push(directory); fs.writeFileSync(path.join(directory, name), source); return directory; }
const validSource = `
import { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
 pgm.createExtension('pgcrypto', { ifNotExists: true });
 pgm.addColumns('streams', { sender_address_hash: { type: 'text' }, recipient_address_hash: { type: 'text' } });
 pgm.createIndex('streams', 'sender_address_hash');
 pgm.sql('CREATE OR REPLACE FUNCTION decrypt_stream_address(value text) RETURNS text AS $$ SELECT value $$ LANGUAGE sql');
}
export async function down(pgm: MigrationBuilder): Promise<void> {
 pgm.dropColumns('streams', ['recipient_address_hash', 'sender_address_hash']);
 pgm.sql('DROP FUNCTION IF EXISTS decrypt_stream_address(text)');
}
`;
describe('pgcrypto migration contract', () => {
  it('has a stable marker inventory', () => expect(REQUIRED_CONTRACT_MARKERS).toHaveLength(7));
  it('detects all required markers in valid source', () => expect(missingMarkers(validSource)).toEqual([]));
  it('returns a stable digest', () => { expect(migrationDigest(validSource)).toMatch(/^[a-f0-9]{64}$/); expect(migrationDigest(validSource)).toBe(migrationDigest(validSource)); expect(migrationDigest(`${validSource}\n`)).not.toBe(migrationDigest(validSource)); });
  it('accepts valid source and reports evidence', () => { const result = assertMigrationContract(validSource); expect(result.markers).toBe(7); expect(result.dependency).toContain('streams-table'); expect(result.digest).toHaveLength(64); });
  it.each(REQUIRED_CONTRACT_MARKERS)('reports missing marker %s', (marker) => expect(missingMarkers(validSource.replaceAll(marker, ''))).toContain(marker));
  it('rejects old filename', () => expect(() => assertMigrationContract(validSource, { file: '20260601_enable_pgcrypto_encrypt_addresses.ts' })).toThrow(/Unexpected/));
  it('rejects source without up', () => expect(() => assertMigrationContract(validSource.replace('export async function up', 'function up'))).toThrow(/up function/));
  it('rejects source without down', () => expect(() => assertMigrationContract(validSource.replace('export async function down', 'function down'))).toThrow(/down function/));
  it('rejects non-idempotent extension creation', () => expect(() => assertMigrationContract(validSource.replace('{ ifNotExists: true }', '{}'))).toThrow(/idempotent/));
  it('rejects non-idempotent function rollback', () => expect(() => assertMigrationContract(validSource.replace('DROP FUNCTION IF EXISTS', 'DROP FUNCTION'))).toThrow(/IF EXISTS/));
  it('reports source ordering evidence', () => expect(dependencyEvidence(validSource)).toMatchObject({ extensionBeforeStreamMutation: true, streamsMutationBeforeIndexes: true, functionDefined: true }));
  it('reports absent sequence evidence', () => expect(dependencyEvidence('nothing')).toMatchObject({ extensionBeforeStreamMutation: false, streamsMutationBeforeIndexes: false, functionDefined: false }));
  it('rejects source without stream mutation', () => expect(() => assertMigrationContract(validSource.replace("pgm.addColumns('streams'", "pgm.addColumns('other'"))).toThrow(/markers missing/));
  it('rejects source without indexes', () => expect(() => assertMigrationContract(validSource.replaceAll('pgm.createIndex', 'pgm.makeIndex'))).toThrow(/markers missing/));
  it('rejects source without decrypt function', () => expect(() => assertMigrationContract(validSource.replace('CREATE OR REPLACE FUNCTION decrypt_stream_address', 'CREATE FUNCTION other'))).toThrow(/markers missing/));
  it('reads a temporary migration file', () => expect(readMigrationSource(tempFile(validSource))).toBe(validSource));
  it('reports missing files with a stable code', () => { try { readMigrationSource(tempFile('', 'other.ts'), PGCRYPTO_MIGRATION); } catch (error) { expect(error.code).toBe('FILE_MISSING'); } });
  it('runs the complete fixture check', () => expect(formatContract(checkContract(tempFile(validSource)))).toContain('contract passed'));
  it('includes digest in operator output', () => { const result = assertMigrationContract(validSource); expect(formatContract(result)).toContain(result.digest); });
  it('does not mutate source while reading evidence', () => { const source = `${validSource}`; dependencyEvidence(source); expect(source).toBe(validSource); });
  it('supports a custom marker list', () => expect(missingMarkers(validSource, ['pgm.addColumns', 'not-present'])).toEqual(['not-present']));
  it('rejects a JavaScript target variation', () => expect(() => assertMigrationContract(validSource, { file: '1787788800000_enable_pgcrypto_encrypt_addresses.js' })).toThrow(/Unexpected/));
  it('keeps evidence tied to streams', () => expect(dependencyEvidence(validSource).streamTable).toBe('streams'));
  it('requires both address hash fields', () => expect(missingMarkers(validSource.replaceAll('recipient_address_hash', 'recipient_hash'))).toContain('recipient_address_hash'));
  it('requires rollback cleanup', () => expect(missingMarkers(validSource.replace('pgm.dropColumns', 'pgm.dropColumn'))).toContain('pgm.dropColumns'));
  it('uses the expected filename by default', () => expect(assertMigrationContract(validSource).file).toBe(PGCRYPTO_MIGRATION));
  it('reports all missing markers together', () => { const error = (() => { try { assertMigrationContract('export async function up() {}'); } catch (value) { return value; } })(); expect(error).toBeInstanceOf(MigrationContractError); expect(error.missing.length).toBe(7); });
  it('keeps the contract error code stable for malformed source content', () => { try { assertMigrationContract('bad'); } catch (error) { expect(error.code).toBe('CONTRACT_MARKER_MISSING'); } });
});
