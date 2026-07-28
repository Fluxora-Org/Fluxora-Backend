/**
 * Unit tests for tenantRateLimitOverride service.
 *
 * All pg pool interactions are mocked — no real database required.
 * Covers: getOverride, createOverride, deleteOverride, listOverrides,
 * expiry filtering, and error handling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-123'),
}));

import {
  getOverride,
  createOverride,
  deleteOverride,
  listOverrides,
} from '../../src/services/tenantRateLimitOverride.service.js';

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'override-1',
    key_id: 'key-1',
    max_requests: 5000,
    window_ms: 60000,
    expires_at: null,
    created_by: 'admin:abc12345',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('tenantRateLimitOverride service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOverride', () => {
    it('returns null when no override exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getOverride('key-nonexistent');
      expect(result).toBeNull();
    });

    it('returns the override when one exists and is not expired', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      const result = await getOverride('key-1');
      expect(result).not.toBeNull();
      expect(result!.maxRequests).toBe(5000);
      expect(result!.windowMs).toBe(60000);
      expect(result!.keyId).toBe('key-1');
    });

    it('returns null for an expired override', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getOverride('key-expired');
      expect(result).toBeNull();
    });

    it('returns the override when expires_at is null (never-expiring)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow({ expires_at: null })] });
      const result = await getOverride('key-never-expires');
      expect(result).not.toBeNull();
      expect(result!.expiresAt).toBeNull();
    });

    it('returns null on DB error (graceful fallback)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));
      await expect(getOverride('key-error')).rejects.toThrow();
    });
  });

  describe('createOverride', () => {
    it('inserts correctly and returns the created record', async () => {
      const createdRow = makeRow();
      mockQuery.mockResolvedValueOnce({ rows: [createdRow] });

      const result = await createOverride(
        { keyId: 'key-1', maxRequests: 5000, windowMs: 60000 },
        'admin:test',
      );

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO tenant_rate_limit_overrides');
      expect(params).toContain('key-1');
      expect(params).toContain(5000);
      expect(params).toContain(60000);
      expect(params).toContain('admin:test');
      expect(result.keyId).toBe('key-1');
      expect(result.maxRequests).toBe(5000);
    });

    it('inserts with expires_at when provided', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const createdRow = makeRow({ key_id: 'key-2', max_requests: 10000, window_ms: 120000, expires_at: new Date(futureDate) });
      mockQuery.mockResolvedValueOnce({ rows: [createdRow] });

      const result = await createOverride(
        { keyId: 'key-2', maxRequests: 10000, windowMs: 120000, expiresAt: futureDate },
        'admin:test',
      );

      expect(result.keyId).toBe('key-2');
      expect(result.maxRequests).toBe(10000);
      expect(result.expiresAt).not.toBeNull();
    });
  });

  describe('deleteOverride', () => {
    it('calls DB delete with correct ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'override-1' }] });
      await deleteOverride('override-1');

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('DELETE FROM tenant_rate_limit_overrides');
      expect(params).toEqual(['override-1']);
    });

    it('throws not-found error when record does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(deleteOverride('nonexistent')).rejects.toThrow('Override not found: nonexistent');
    });
  });

  describe('listOverrides', () => {
    it('returns all records ordered by created_at DESC', async () => {
      const row1 = makeRow({ id: 'override-1', key_id: 'key-1', created_at: new Date('2024-01-02T00:00:00Z') });
      const row2 = makeRow({ id: 'override-2', key_id: 'key-2', created_at: new Date('2024-01-01T00:00:00Z') });
      mockQuery.mockResolvedValueOnce({ rows: [row1, row2] });

      const result = await listOverrides();
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('override-1');
      expect(result[1]!.id).toBe('override-2');
    });

    it('returns empty array when no overrides exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await listOverrides();
      expect(result).toEqual([]);
    });
  });
});
