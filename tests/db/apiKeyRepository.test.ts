/**
 * Unit tests for apiKeyRepository (PostgreSQL-backed).
 *
 * All pg pool interactions are mocked — no real database required.
 * Covers: insert, findActiveByPrefix, getById, rotate, revoke, listAll,
 * row mapping (timestamp coercion, null rotated_at), and not-found paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { apiKeyRepository } from '../../src/db/repositories/apiKeyRepository.js';
import type { ApiKeyRecord } from '../../src/db/types.js';

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'key-1',
    name: 'service-a',
    key_hash: 'a'.repeat(64),
    salt: 'b'.repeat(32),
    prefix: 'flx_abcd',
    created_at: new Date('2024-01-01T00:00:00Z'),
    rotated_at: null,
    active: true,
    scopes: ['streams:read', 'streams:write'],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key-1',
    name: 'service-a',
    keyHash: 'a'.repeat(64),
    salt: 'b'.repeat(32),
    prefix: 'flx_abcd',
    createdAt: '2024-01-01T00:00:00.000Z',
    rotatedAt: null,
    active: true,
    scopes: ['streams:read', 'streams:write'],
    ...overrides,
  };
}

describe('apiKeyRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('insert', () => {
    it('inserts all columns and never sends the raw key', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await apiKeyRepository.insert(makeRecord());

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO api_keys');
      expect(params).toEqual([
        'key-1', 'service-a', 'a'.repeat(64), 'b'.repeat(32), 'flx_abcd',
        '2024-01-01T00:00:00.000Z', null, true, ['streams:read', 'streams:write'],
      ]);
    });
  });

  describe('findActiveByPrefix', () => {
    it('filters by prefix and active=true and maps rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      const records = await apiKeyRepository.findActiveByPrefix('flx_abcd');

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE prefix = $1 AND active = true');
      expect(params).toEqual(['flx_abcd']);
      expect(records).toHaveLength(1);
      expect(records[0]!.keyHash).toBe('a'.repeat(64));
    });

    it('returns multiple rows on prefix collision', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ id: 'k1' }), makeRow({ id: 'k2', salt: 'c'.repeat(32) })],
      });
      const records = await apiKeyRepository.findActiveByPrefix('flx_abcd');
      expect(records.map((r) => r.id)).toEqual(['k1', 'k2']);
    });

    it('returns an empty array when no candidates match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await apiKeyRepository.findActiveByPrefix('flx_zzzz')).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns a mapped record when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      const record = await apiKeyRepository.getById('key-1');
      expect(record).toBeDefined();
      expect(record!.id).toBe('key-1');
      expect(record!.rotatedAt).toBeNull();
    });

    it('returns undefined when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await apiKeyRepository.getById('missing')).toBeUndefined();
    });

    it('coerces rotated_at timestamp to ISO string', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ rotated_at: new Date('2024-02-02T00:00:00Z') })],
      });
      const record = await apiKeyRepository.getById('key-1');
      expect(record!.rotatedAt).toBe('2024-02-02T00:00:00.000Z');
    });
  });

  describe('rotate', () => {
    it('updates hash material and returns the updated record', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ key_hash: 'd'.repeat(64), prefix: 'flx_newp', rotated_at: new Date('2024-03-03T00:00:00Z') })],
      });
      const updated = await apiKeyRepository.rotate('key-1', {
        keyHash: 'd'.repeat(64),
        salt: 'e'.repeat(32),
        prefix: 'flx_newp',
        rotatedAt: '2024-03-03T00:00:00.000Z',
        scopes: ['streams:read', 'streams:write'],
      });

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE api_keys');
      expect(sql).toContain('RETURNING');
      expect(params).toEqual(['key-1', 'd'.repeat(64), 'e'.repeat(32), 'flx_newp', '2024-03-03T00:00:00.000Z', ['streams:read', 'streams:write']]);
      expect(updated!.prefix).toBe('flx_newp');
    });

    it('returns undefined when the id does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const updated = await apiKeyRepository.rotate('missing', {
        keyHash: 'x', salt: 'y', prefix: 'flx_zzzz', rotatedAt: 'now',
        scopes: ['streams:read', 'streams:write'],
      });
      expect(updated).toBeUndefined();
    });

    it('persists custom scopes and round-trips through findActiveByPrefix', async () => {
      const customScopes = ['admin:read'];
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ scopes: customScopes })],
      });
      const records = await apiKeyRepository.findActiveByPrefix('flx_abcd');
      expect(records).toHaveLength(1);
      expect(records[0]!.scopes).toEqual(customScopes);
    });

    it('updates scopes on rotate and returns the new value', async () => {
      const newScopes = ['admin:read', 'admin:write'];
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ scopes: newScopes })],
      });
      const updated = await apiKeyRepository.rotate('key-1', {
        keyHash: 'd'.repeat(64),
        salt: 'e'.repeat(32),
        prefix: 'flx_newp',
        rotatedAt: '2024-03-03T00:00:00.000Z',
        scopes: newScopes,
      });
      expect(updated).toBeDefined();
      expect(updated!.scopes).toEqual(newScopes);

      const [, , params] = mockQuery.mock.calls[0]!;
      expect(params[5]).toEqual(newScopes);
    });
  });

  describe('revoke', () => {
    it('sets active=false and returns the row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow({ active: false })] });
      const revoked = await apiKeyRepository.revoke('key-1');
      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('SET active = false');
      expect(revoked!.active).toBe(false);
    });

    it('returns undefined when the id does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await apiKeyRepository.revoke('missing')).toBeUndefined();
    });
  });

  describe('listAll', () => {
    it('returns all mapped records', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ id: 'k1' }), makeRow({ id: 'k2', active: false })],
      });
      const records = await apiKeyRepository.listAll();
      expect(records.map((r) => r.id)).toEqual(['k1', 'k2']);
      expect(records[1]!.active).toBe(false);
    });
  });

  describe('error propagation', () => {
    it('propagates unexpected DB errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      await expect(apiKeyRepository.getById('x')).rejects.toThrow('connection refused');
    });
  });

  // ── rowToRecord edge cases ──────────────────────────────────────────────────
  // These lock down the exact scopes that come back from the DB so a silent
  // field-assignment bug (using the raw column instead of the resolved variable)
  // is immediately caught.

  describe('rowToRecord — scope resolution', () => {
    it('uses the resolved scopes variable, not the raw column (default fallback)', async () => {
      // null scopes in the DB → default ['streams:read', 'streams:write']
      mockQuery.mockResolvedValueOnce({ rows: [makeRow({ scopes: null })] });
      const record = await apiKeyRepository.getById('key-1');
      expect(record!.scopes).toEqual(['streams:read', 'streams:write']);
    });

    it('parses JSON-string scopes returned by some pg drivers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ scopes: '["admin:read","admin:write"]' })],
      });
      const record = await apiKeyRepository.getById('key-1');
      expect(record!.scopes).toEqual(['admin:read', 'admin:write']);
    });

    it('passes through a native array of scopes unchanged', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ scopes: ['streams:read'] })],
      });
      const record = await apiKeyRepository.getById('key-1');
      expect(record!.scopes).toEqual(['streams:read']);
    });

    it('applies the default when scopes is undefined', async () => {
      const rowWithoutScopes = makeRow();
      delete (rowWithoutScopes as any)['scopes'];
      mockQuery.mockResolvedValueOnce({ rows: [rowWithoutScopes] });
      const record = await apiKeyRepository.getById('key-1');
      expect(record!.scopes).toEqual(['streams:read', 'streams:write']);
    });
  });

  // ── findActiveByPrefix — empty-prefix guard ─────────────────────────────────

  describe('findActiveByPrefix — empty / blank prefix guard', () => {
    it('returns [] immediately for an empty string prefix without querying the DB', async () => {
      const result = await apiKeyRepository.findActiveByPrefix('');
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns [] immediately for a whitespace-only prefix without querying the DB', async () => {
      const result = await apiKeyRepository.findActiveByPrefix('   ');
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('still queries the DB for a non-empty prefix', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await apiKeyRepository.findActiveByPrefix('flx_abcd');
      expect(result).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
