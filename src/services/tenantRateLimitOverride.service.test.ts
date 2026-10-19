/**
 * Unit tests for tenantRateLimitOverride.service.
 *
 * The pg pool is replaced with an in-memory spy, so every test is deterministic
 * and requires neither a database nor network access. Dates are fixed values:
 * expiry evaluation lives in SQL (NOW()), never in application wall-clock code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  query: vi.fn(),
  createId: vi.fn(),
}));

vi.mock('../db/pool.js', () => ({
  getPool: mocks.getPool,
  query: mocks.query,
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: mocks.createId,
}));

import {
  assertOverrideWithinCeiling,
  createOverride,
  deleteOverride,
  getOverride,
  getOverrideById,
  listOverrides,
} from './tenantRateLimitOverride.service.js';
import { ApiError, ApiErrorCode } from '../errors.js';
import {
  MAX_WINDOW_MS,
  resetRuntimeRateLimitConfig,
  setRuntimeRateLimitConfig,
} from '../config/rateLimits.js';

const fakePool = { name: 'fake-pool' };

const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const FIXED_UPDATED_AT = new Date('2026-01-01T01:00:00.000Z');
const FIXED_EXPIRES_AT = new Date('2026-01-02T03:04:05.000Z');

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'override-1',
    key_id: 'tenant-key-1',
    max_requests: 250,
    window_ms: 60_000,
    expires_at: FIXED_EXPIRES_AT,
    created_by: 'admin:abcdefgh',
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_UPDATED_AT,
    ...overrides,
  };
}

function result(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[] } {
  return { rows };
}

const originalApiKeyMax = process.env.RATE_LIMIT_APIKEY_MAX;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPool.mockReturnValue(fakePool);
  mocks.createId.mockReturnValue('generated-override-id');
  process.env.RATE_LIMIT_APIKEY_MAX = '500';
  resetRuntimeRateLimitConfig();
});

afterEach(() => {
  resetRuntimeRateLimitConfig();
  if (originalApiKeyMax === undefined) {
    delete process.env.RATE_LIMIT_APIKEY_MAX;
  } else {
    process.env.RATE_LIMIT_APIKEY_MAX = originalApiKeyMax;
  }
});

describe('getOverride', () => {
  it('returns a mapped override for an active key', async () => {
    mocks.query.mockResolvedValueOnce(result([makeRow()]));

    const override = await getOverride('tenant-key-1');

    expect(override).toEqual({
      id: 'override-1',
      keyId: 'tenant-key-1',
      maxRequests: 250,
      windowMs: 60_000,
      expiresAt: FIXED_EXPIRES_AT.toISOString(),
      createdBy: 'admin:abcdefgh',
      createdAt: FIXED_CREATED_AT.toISOString(),
      updatedAt: FIXED_UPDATED_AT.toISOString(),
    });
    expect(mocks.getPool).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      fakePool,
      expect.stringMatching(/FROM tenant_rate_limit_overrides/i),
      ['tenant-key-1'],
    );
  });

  it('filters expiry in SQL so the database clock decides', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await getOverride('tenant-key-1');

    const [, sql] = mocks.query.mock.calls[0]!;
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    expect(sql).toMatch(/WHERE key_id = \$1/i);
  });

  it('maps a never-expiring override to expiresAt null', async () => {
    mocks.query.mockResolvedValueOnce(result([makeRow({ expires_at: null })]));

    const override = await getOverride('tenant-key-1');

    expect(override?.expiresAt).toBeNull();
  });

  it('returns null when no row matches (missing or expired)', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await expect(getOverride('tenant-key-1')).resolves.toBeNull();
  });

  it('accepts an empty key id as a boundary and forwards it unchanged', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await expect(getOverride('')).resolves.toBeNull();

    expect(mocks.query.mock.calls[0]![2]).toEqual(['']);
  });

  it('propagates store errors', async () => {
    mocks.query.mockRejectedValueOnce(new Error('connection reset'));

    await expect(getOverride('tenant-key-1')).rejects.toThrow('connection reset');
  });
});

describe('getOverrideById', () => {
  it('returns a mapped override and queries by primary key', async () => {
    mocks.query.mockResolvedValueOnce(result([makeRow()]));

    const override = await getOverrideById('override-1');

    expect(override?.id).toBe('override-1');
    expect(override?.keyId).toBe('tenant-key-1');
    expect(mocks.query).toHaveBeenCalledWith(
      fakePool,
      expect.stringMatching(/WHERE id = \$1/i),
      ['override-1'],
    );
  });

  it('applies the same server-side expiry filter as getOverride', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await getOverrideById('override-1');

    const [, sql] = mocks.query.mock.calls[0]!;
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
  });

  it('returns null for a missing or expired id', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await expect(getOverrideById('override-1')).resolves.toBeNull();
  });

  it('accepts an empty id as a boundary and forwards it unchanged', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await expect(getOverrideById('')).resolves.toBeNull();

    expect(mocks.query.mock.calls[0]![2]).toEqual(['']);
  });

  it('propagates store errors', async () => {
    mocks.query.mockRejectedValueOnce(new Error('statement timeout'));

    await expect(getOverrideById('override-1')).rejects.toThrow('statement timeout');
  });
});

describe('assertOverrideWithinCeiling', () => {
  const ceiling = { maxRequests: 500, windowMs: MAX_WINDOW_MS };

  it('allows values strictly below the ceiling', () => {
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 499, windowMs: MAX_WINDOW_MS - 1 }, ceiling),
    ).not.toThrow();
  });

  it('allows maxRequests and windowMs exactly at the ceiling', () => {
    expect(() =>
      assertOverrideWithinCeiling(
        { maxRequests: ceiling.maxRequests, windowMs: ceiling.windowMs },
        ceiling,
      ),
    ).not.toThrow();
  });

  it('refuses maxRequests one above the ceiling with a 422 and details', () => {
    try {
      assertOverrideWithinCeiling({ maxRequests: 501, windowMs: 60_000 }, ceiling);
      expect.fail('expected assertOverrideWithinCeiling to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.statusCode).toBe(422);
      expect(apiError.code).toBe(ApiErrorCode.UNPROCESSABLE_ENTITY);
      expect(apiError.message).toBe(
        'maxRequests 501 exceeds the global ceiling of 500',
      );
      expect(apiError.details).toEqual({ maxRequests: 501, ceiling: 500 });
    }
  });

  it('refuses windowMs one above the maximum with a 422 and details', () => {
    try {
      assertOverrideWithinCeiling(
        { maxRequests: 100, windowMs: MAX_WINDOW_MS + 1 },
        ceiling,
      );
      expect.fail('expected assertOverrideWithinCeiling to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.statusCode).toBe(422);
      expect(apiError.code).toBe(ApiErrorCode.UNPROCESSABLE_ENTITY);
      expect(apiError.message).toBe(
        `windowMs ${MAX_WINDOW_MS + 1} exceeds the maximum allowed window of ${MAX_WINDOW_MS}`,
      );
      expect(apiError.details).toEqual({ windowMs: MAX_WINDOW_MS + 1, ceiling: MAX_WINDOW_MS });
    }
  });

  it('reports the maxRequests breach first when both dimensions exceed', () => {
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 501, windowMs: MAX_WINDOW_MS + 1 }, ceiling),
    ).toThrow(/maxRequests 501 exceeds/);
  });

  it('treats zero as a boundary within the ceiling (route validates positivity)', () => {
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 0, windowMs: 0 }, ceiling),
    ).not.toThrow();
  });

  it('handles a zero ceiling without accepting one above it', () => {
    const zeroCeiling = { maxRequests: 0, windowMs: 0 };

    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 0, windowMs: 0 }, zeroCeiling),
    ).not.toThrow();
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 1, windowMs: 0 }, zeroCeiling),
    ).toThrow(/exceeds the global ceiling of 0/);
  });

  it('resolves the live global ceiling by default from the runtime env', () => {
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 500, windowMs: MAX_WINDOW_MS }),
    ).not.toThrow();
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 501, windowMs: MAX_WINDOW_MS }),
    ).toThrow(/exceeds the global ceiling of 500/);
  });

  it('tracks a hot-reloaded runtime ceiling instead of the env seed', () => {
    setRuntimeRateLimitConfig({ apiKey: { max: 300, windowMs: 60_000, enabled: true } });

    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 300, windowMs: 60_000 }),
    ).not.toThrow();
    expect(() =>
      assertOverrideWithinCeiling({ maxRequests: 301, windowMs: 60_000 }),
    ).toThrow(/exceeds the global ceiling of 300/);
  });
});

describe('createOverride', () => {
  it('inserts a row and returns the mapped created override', async () => {
    mocks.query.mockResolvedValueOnce(
      result([makeRow({ id: 'generated-override-id', max_requests: 250 })]),
    );

    const created = await createOverride(
      { keyId: 'tenant-key-1', maxRequests: 250, windowMs: 60_000 },
      'admin:abcdefgh',
    );

    expect(created.id).toBe('generated-override-id');
    expect(created.keyId).toBe('tenant-key-1');
    expect(created.maxRequests).toBe(250);
    expect(mocks.createId).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      fakePool,
      expect.stringMatching(/INSERT INTO tenant_rate_limit_overrides/i),
      ['generated-override-id', 'tenant-key-1', 250, 60_000, null, 'admin:abcdefgh'],
    );
  });

  it('persists an explicit expiresAt value', async () => {
    const expiresAt = '2026-02-01T00:00:00.000Z';
    mocks.query.mockResolvedValueOnce(
      result([makeRow({ expires_at: new Date(expiresAt), created_by: 'jwt:GADMIN' })]),
    );

    const created = await createOverride(
      { keyId: 'tenant-key-1', maxRequests: 250, windowMs: 60_000, expiresAt },
      'jwt:GADMIN',
    );

    expect(mocks.query.mock.calls[0]![2]![4]).toBe(expiresAt);
    expect(mocks.query.mock.calls[0]![2]![5]).toBe('jwt:GADMIN');
    expect(created.expiresAt).toBe(expiresAt);
    expect(created.createdBy).toBe('jwt:GADMIN');
  });

  it('stores null when expiresAt is omitted', async () => {
    mocks.query.mockResolvedValueOnce(result([makeRow({ expires_at: null })]));

    await createOverride(
      { keyId: 'tenant-key-1', maxRequests: 250, windowMs: 60_000 },
      'admin:abcdefgh',
    );

    expect(mocks.query.mock.calls[0]![2]![4]).toBeNull();
  });

  it('accepts values exactly at the ceiling boundary', async () => {
    mocks.query.mockResolvedValueOnce(
      result([makeRow({ max_requests: 500, window_ms: MAX_WINDOW_MS })]),
    );

    const created = await createOverride(
      { keyId: 'tenant-key-1', maxRequests: 500, windowMs: MAX_WINDOW_MS },
      'admin:abcdefgh',
    );

    expect(created.maxRequests).toBe(500);
    expect(created.windowMs).toBe(MAX_WINDOW_MS);
  });

  it('refuses an above-ceiling maxRequests before touching the store', async () => {
    await expect(
      createOverride(
        { keyId: 'tenant-key-1', maxRequests: 501, windowMs: 60_000 },
        'admin:abcdefgh',
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: ApiErrorCode.UNPROCESSABLE_ENTITY });

    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses a window above the maximum before touching the store', async () => {
    await expect(
      createOverride(
        { keyId: 'tenant-key-1', maxRequests: 100, windowMs: MAX_WINDOW_MS + 1 },
        'admin:abcdefgh',
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: ApiErrorCode.UNPROCESSABLE_ENTITY });

    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('propagates store errors after the ceiling check passes', async () => {
    mocks.query.mockRejectedValueOnce(new Error('unique violation'));

    await expect(
      createOverride(
        { keyId: 'tenant-key-1', maxRequests: 100, windowMs: 60_000 },
        'admin:abcdefgh',
      ),
    ).rejects.toThrow('unique violation');
  });
});

describe('deleteOverride', () => {
  it('deletes by id and returns the deleted row for audit callers', async () => {
    mocks.query.mockResolvedValueOnce(result([makeRow({ key_id: 'audit-key' })]));

    const deleted = await deleteOverride('override-1');

    expect(deleted.id).toBe('override-1');
    expect(deleted.keyId).toBe('audit-key');
    expect(mocks.query).toHaveBeenCalledWith(
      fakePool,
      expect.stringMatching(/DELETE FROM tenant_rate_limit_overrides WHERE id = \$1 RETURNING/i),
      ['override-1'],
    );
  });

  it('throws a 404 ApiError when the id does not exist', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    try {
      await deleteOverride('missing-override');
      expect.fail('expected deleteOverride to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.statusCode).toBe(404);
      expect(apiError.code).toBe('NOT_FOUND');
      expect(apiError.message).toBe('Override not found: missing-override');
    }
  });

  it('treats an empty id as a boundary and reports not found', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await expect(deleteOverride('')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Override not found: ',
    });
    expect(mocks.query.mock.calls[0]![2]).toEqual(['']);
  });

  it('propagates store errors', async () => {
    mocks.query.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(deleteOverride('override-1')).rejects.toThrow('deadlock detected');
  });
});

describe('listOverrides', () => {
  it('returns all mapped active rows in store order', async () => {
    mocks.query.mockResolvedValueOnce(
      result([
        makeRow({ id: 'override-2', key_id: 'key-2', max_requests: 20 }),
        makeRow({ id: 'override-1', key_id: 'key-1', max_requests: 10 }),
      ]),
    );

    const overrides = await listOverrides();

    expect(overrides).toHaveLength(2);
    expect(overrides.map((o) => o.id)).toEqual(['override-2', 'override-1']);
    expect(overrides[0]!.keyId).toBe('key-2');
    expect(overrides[1]!.maxRequests).toBe(10);
  });

  it('filters expired rows in SQL and orders newest first', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await listOverrides();

    const [pool, sql, params] = mocks.query.mock.calls[0]!;
    expect(pool).toBe(fakePool);
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    expect(params).toBeUndefined();
  });

  it('returns an empty array when no active overrides exist', async () => {
    mocks.query.mockResolvedValueOnce(result([]));

    await expect(listOverrides()).resolves.toEqual([]);
  });

  it('propagates store errors', async () => {
    mocks.query.mockRejectedValueOnce(new Error('read replica unavailable'));

    await expect(listOverrides()).rejects.toThrow('read replica unavailable');
  });
});
