/**
 * Unit tests for tenantRateLimitOverride service.
 *
 * All pg pool interactions are mocked — no real database required.
 * Covers: getOverride, getOverrideById, createOverride, deleteOverride,
 * listOverrides, expiry filtering, and error handling.
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
  getOverrideById,
  createOverride,
  deleteOverride,
  listOverrides,
} from '../../src/services/tenantRateLimitOverride.service.js';
import { ApiError } from '../../src/errors.js';

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

  // ---------------------------------------------------------------------------
  // getOverride (by keyId)
  // ---------------------------------------------------------------------------
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

    it('returns null for an expired override (DB filters via NOW())', async () => {
      // The service delegates expiry evaluation to the database.  An expired
      // record simply does not appear in the result set.
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

    it('propagates DB errors to the caller', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));
      await expect(getOverride('key-error')).rejects.toThrow('DB connection failed');
    });

    it('uses an expiry-aware WHERE clause', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getOverride('key-1');
      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    });
  });

  // ---------------------------------------------------------------------------
  // getOverrideById (by primary key)
  // ---------------------------------------------------------------------------
  describe('getOverrideById', () => {
    it('returns null when no override exists for the given id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getOverrideById('nonexistent-id');
      expect(result).toBeNull();
    });

    it('returns the override when found and not expired', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      const result = await getOverrideById('override-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('override-1');
      expect(result!.keyId).toBe('key-1');
    });

    it('returns null for an expired override (DB filters via NOW())', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getOverrideById('expired-id');
      expect(result).toBeNull();
    });

    it('queries by id column (not key_id)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getOverrideById('override-xyz');
      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE id = $1');
      expect(params).toEqual(['override-xyz']);
    });

    it('uses an expiry-aware WHERE clause', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getOverrideById('override-1');
      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    });

    it('propagates DB errors to the caller', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB timeout'));
      await expect(getOverrideById('override-1')).rejects.toThrow('DB timeout');
    });
  });

  // ---------------------------------------------------------------------------
  // createOverride
  // ---------------------------------------------------------------------------
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

    it('uses null for expires_at when not provided', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      await createOverride({ keyId: 'key-1', maxRequests: 100, windowMs: 1000 }, 'admin:xyz');
      const [, , params] = mockQuery.mock.calls[0]!;
      // expires_at is the 5th param ($5)
      expect((params as unknown[])[4]).toBeNull();
    });

    it('stores the createdBy audit field', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow({ created_by: 'jwt:GADDR123' })] });
      const result = await createOverride(
        { keyId: 'key-jwt', maxRequests: 500, windowMs: 5000 },
        'jwt:GADDR123',
      );
      expect(result.createdBy).toBe('jwt:GADDR123');
    });
  });

  // ---------------------------------------------------------------------------
  // deleteOverride
  // ---------------------------------------------------------------------------
  describe('deleteOverride', () => {
    it('calls DB delete with correct ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      await deleteOverride('override-1');

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('DELETE FROM tenant_rate_limit_overrides');
      expect(params).toEqual(['override-1']);
    });

    it('returns the deleted record so callers can read stable identifiers', async () => {
      const row = makeRow({ key_id: 'key-audit', id: 'override-del-1' });
      mockQuery.mockResolvedValueOnce({ rows: [row] });
      const deleted = await deleteOverride('override-del-1');
      expect(deleted.id).toBe('override-del-1');
      expect(deleted.keyId).toBe('key-audit');
    });

    it('throws a 404 ApiError when record does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(deleteOverride('nonexistent')).rejects.toThrow('Override not found: nonexistent');
    });

    it('throws an ApiError with statusCode 404', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      try {
        await deleteOverride('nonexistent');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).statusCode).toBe(404);
        expect((err as ApiError).code).toBe('NOT_FOUND');
      }
    });

    it('uses RETURNING clause to avoid an extra round-trip', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      await deleteOverride('override-1');
      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/RETURNING/i);
    });
  });

  // ---------------------------------------------------------------------------
  // listOverrides
  // ---------------------------------------------------------------------------
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

    it('uses an expiry-aware WHERE clause to exclude expired records', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await listOverrides();
      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    });

    it('returns only active records when some are expired', async () => {
      // The database evaluates the expiry filter; the service maps whatever
      // rows are returned.  Here we simulate the DB returning only one active
      // row after filtering out an expired one.
      const activeRow = makeRow({ id: 'active', key_id: 'key-active' });
      mockQuery.mockResolvedValueOnce({ rows: [activeRow] });

      const result = await listOverrides();
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('active');
    });
  });
});
