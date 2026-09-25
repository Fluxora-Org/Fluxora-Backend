/**
 * Security test suite for SQL identifier safety and enforcement.
 *
 * Asserts that:
 * 1. sqlIdentifiers.ts quotes valid identifiers and rejects malformed identifiers.
 * 2. Every repository in src/db/repositories is covered by the rule.
 * 3. Direct identifier interpolation is detected and fails validation.
 * 4. sqlIdentifiers.ts is the only path by which identifiers reach SQL.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  quoteIdentifier,
  isValidSqlIdentifier,
  allowlistedSqlIdentifier,
  InvalidSqlIdentifierError,
  MAX_SQL_IDENTIFIER_LENGTH,
  STREAM_CURSOR_SORT_FIELDS,
  STREAM_OFFSET_SORT_FIELDS,
  assertNoDirectIdentifierInterpolation,
  checkRepositoriesForDirectInterpolation,
} from '../../src/db/repositories/sqlIdentifiers.js';
import { sqliPayloads } from './fixtures/sqliPayloads.js';

describe('sqlIdentifiers helper', () => {
  describe('isValidSqlIdentifier', () => {
    it('accepts standard table and column names', () => {
      expect(isValidSqlIdentifier('streams')).toBe(true);
      expect(isValidSqlIdentifier('audit_logs')).toBe(true);
      expect(isValidSqlIdentifier('created_at')).toBe(true);
      expect(isValidSqlIdentifier('contract_events_y2026m07')).toBe(true);
      expect(isValidSqlIdentifier('_internal_id')).toBe(true);
      expect(isValidSqlIdentifier('id')).toBe(true);
    });

    it('accepts identifiers with embedded double quotes', () => {
      expect(isValidSqlIdentifier('weird"name')).toBe(true);
      expect(isValidSqlIdentifier('bad"name')).toBe(true);
    });

    it('rejects empty or whitespace-only strings', () => {
      expect(isValidSqlIdentifier('')).toBe(false);
      expect(isValidSqlIdentifier('   ')).toBe(false);
      expect(isValidSqlIdentifier('\t\n')).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidSqlIdentifier(null)).toBe(false);
      expect(isValidSqlIdentifier(undefined)).toBe(false);
      expect(isValidSqlIdentifier(123)).toBe(false);
      expect(isValidSqlIdentifier({})).toBe(false);
    });

    it('rejects identifiers exceeding 63 bytes in length', () => {
      const valid63 = 'a'.repeat(MAX_SQL_IDENTIFIER_LENGTH);
      const invalid64 = 'a'.repeat(MAX_SQL_IDENTIFIER_LENGTH + 1);
      expect(isValidSqlIdentifier(valid63)).toBe(true);
      expect(isValidSqlIdentifier(invalid64)).toBe(false);
    });

    it('rejects identifiers containing null bytes', () => {
      expect(isValidSqlIdentifier('streams\0')).toBe(false);
      expect(isValidSqlIdentifier('table\0name')).toBe(false);
    });

    it('rejects identifiers containing control characters', () => {
      expect(isValidSqlIdentifier('streams\n')).toBe(false);
      expect(isValidSqlIdentifier('table\rname')).toBe(false);
      expect(isValidSqlIdentifier('table\tname')).toBe(false);
    });

    it('rejects SQL injection payloads', () => {
      for (const payload of sqliPayloads) {
        expect(isValidSqlIdentifier(payload)).toBe(false);
      }
    });
  });

  describe('quoteIdentifier', () => {
    it('quotes valid table and column identifiers in double quotes', () => {
      expect(quoteIdentifier('streams')).toBe('"streams"');
      expect(quoteIdentifier('audit_logs')).toBe('"audit_logs"');
      expect(quoteIdentifier('contract_events_y2026m07')).toBe('"contract_events_y2026m07"');
    });

    it('escapes embedded double quotes by doubling them per SQL standard', () => {
      expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
      expect(quoteIdentifier('bad"name')).toBe('"bad""name"');
      expect(quoteIdentifier('col"""name')).toBe('"col""""""name"');
    });

    it('rejects malformed and adversarial identifiers', () => {
      expect(() => quoteIdentifier('')).toThrow(InvalidSqlIdentifierError);
      expect(() => quoteIdentifier('   ')).toThrow(InvalidSqlIdentifierError);
      expect(() => quoteIdentifier('a'.repeat(64))).toThrow(InvalidSqlIdentifierError);
      expect(() => quoteIdentifier('table\0name')).toThrow(InvalidSqlIdentifierError);
      expect(() => quoteIdentifier('table\nname')).toThrow(InvalidSqlIdentifierError);

      for (const payload of sqliPayloads) {
        expect(() => quoteIdentifier(payload)).toThrow(InvalidSqlIdentifierError);
      }
    });
  });

  describe('allowlistedSqlIdentifier', () => {
    it('returns allowlisted identifier for known keys', () => {
      expect(allowlistedSqlIdentifier('id', STREAM_CURSOR_SORT_FIELDS)).toBe('id');
      expect(allowlistedSqlIdentifier('created_at', STREAM_OFFSET_SORT_FIELDS)).toBe(
        'created_at DESC, id DESC',
      );
    });

    it('rejects unknown or adversarial keys', () => {
      expect(() => allowlistedSqlIdentifier('unknown_col', STREAM_CURSOR_SORT_FIELDS)).toThrow(
        InvalidSqlIdentifierError,
      );
      for (const payload of sqliPayloads) {
        expect(() => allowlistedSqlIdentifier(payload, STREAM_CURSOR_SORT_FIELDS)).toThrow(
          InvalidSqlIdentifierError,
        );
      }
    });
  });
});

describe('SQL identifier interpolation rule enforcement', () => {
  it('covers all repository files and asserts no direct identifier interpolation exists', async () => {
    const reposDir = path.resolve(process.cwd(), 'src/db/repositories');
    const result = await checkRepositoriesForDirectInterpolation(reposDir);

    expect(result.filesChecked.length).toBeGreaterThan(0);
    // Ensure all expected repositories are covered
    const fileBasenames = result.filesChecked.map((f) => path.basename(f));
    expect(fileBasenames).toContain('apiKeyRepository.ts');
    expect(fileBasenames).toContain('auditRepository.ts');
    expect(fileBasenames).toContain('dlqRepository.ts');
    expect(fileBasenames).toContain('streamRepository.ts');
    expect(fileBasenames).toContain('tenantScopedRepository.ts');
    expect(fileBasenames).toContain('webhookSecretRepository.ts');

    // No violations in existing production repositories
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  describe('rule validation on direct interpolation attempts', () => {
    it('fails when direct table name interpolation is added to a SQL query', async () => {
      const codeWithDirectTable = `
        import { getPool, query } from '../pool.js';
        export async function dynamicQuery(tableName: string) {
          const pool = getPool();
          return query(pool, \`SELECT * FROM \${tableName} WHERE id = $1\`, [1]);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithDirectTable);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.snippet).toBe('tableName');
      expect(violations[0]!.message).toContain('Direct SQL identifier interpolation detected');
    });

    it('fails when direct column name interpolation is added to a SELECT list', async () => {
      const codeWithDirectColumn = `
        import { getPool, query } from '../pool.js';
        export async function getColumn(columnName: string) {
          const pool = getPool();
          return query(pool, \`SELECT \${columnName} FROM streams WHERE id = $1\`, [1]);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithDirectColumn);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.snippet).toBe('columnName');
    });

    it('fails when direct ORDER BY sort field interpolation is added', async () => {
      const codeWithDirectOrder = `
        import { getPool, query } from '../pool.js';
        export async function sortStreams(userSort: string) {
          const pool = getPool();
          return query(pool, \`SELECT * FROM streams ORDER BY \${userSort}\`);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithDirectOrder);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.snippet).toBe('userSort');
    });

    it('fails when direct table interpolation is added in UPDATE statement', async () => {
      const codeWithDirectUpdate = `
        import { getPool, query } from '../pool.js';
        export async function updateEntity(targetTable: string) {
          const pool = getPool();
          return query(pool, \`UPDATE \${targetTable} SET updated_at = NOW()\`);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithDirectUpdate);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.snippet).toBe('targetTable');
    });

    it('fails when direct table concatenation with + is added', async () => {
      const codeWithDirectConcat = `
        import { getPool, query } from '../pool.js';
        export async function concatQuery(tableName: string) {
          const pool = getPool();
          return query(pool, 'SELECT * FROM ' + tableName);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithDirectConcat);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.snippet).toBe('tableName');
    });

    it('passes when dynamic identifiers are quoted with quoteIdentifier()', async () => {
      const codeWithQuoteIdentifier = `
        import { getPool, query } from '../pool.js';
        import { quoteIdentifier } from './sqlIdentifiers.js';
        export async function safeQuery(tableName: string, colName: string) {
          const pool = getPool();
          const quotedTable = quoteIdentifier(tableName);
          return query(pool, \`SELECT \${quoteIdentifier(colName)} FROM \${quotedTable} WHERE id = $1\`, [1]);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithQuoteIdentifier);
      expect(violations).toEqual([]);
    });

    it('passes when dynamic identifiers are allowlisted via allowlistedSqlIdentifier()', async () => {
      const codeWithAllowlist = `
        import { getPool, query } from '../pool.js';
        import { allowlistedSqlIdentifier, STREAM_CURSOR_SORT_FIELDS } from './sqlIdentifiers.js';
        export async function safeSort(userSort: string) {
          const pool = getPool();
          const sortField = allowlistedSqlIdentifier(userSort, STREAM_CURSOR_SORT_FIELDS);
          return query(pool, \`SELECT * FROM streams ORDER BY \${sortField}\`);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithAllowlist);
      expect(violations).toEqual([]);
    });

    it('passes parameter placeholder expressions like $${idx}', async () => {
      const codeWithParamIndex = `
        import { getPool, query } from '../pool.js';
        export async function paramQuery(idx: number) {
          const pool = getPool();
          return query(pool, \`SELECT * FROM streams WHERE id = $\${idx}\`, [1]);
        }
      `;
      const violations = await assertNoDirectIdentifierInterpolation(codeWithParamIndex);
      expect(violations).toEqual([]);
    });
  });
});
