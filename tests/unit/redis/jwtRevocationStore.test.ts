import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { revoke, isRevoked, closeRevocationStore, JwtRevocationError } from '../../../src/redis/jwtRevocationStore.js';

// ── Mocks ──

const mockRedis = {
  set: vi.fn<[string, string, { ex?: number } | undefined], Promise<void>>(),
  exists: vi.fn<[string], Promise<boolean>>(),
  close: vi.fn<[], Promise<void>>(),
};

const mockCreateRedisClient = vi.fn().mockResolvedValue(mockRedis);

vi.mock('../../../src/redis/client.js', () => ({
  createRedisClient: (...args: unknown[]) => mockCreateRedisClient(...args),
}));

vi.mock('../../../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({
    redisUrl: 'redis://localhost:6379',
    redisEnabled: true,
    redisMode: 'standalone' as const,
    redisSentinelHosts: undefined,
    redisSentinelName: undefined,
    redisClusterNodes: undefined,
  })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// ── Helpers ──

beforeEach(() => {
  vi.clearAllMocks();
  // Default: client created successfully
  mockCreateRedisClient.mockResolvedValue(mockRedis);
});

afterEach(async () => {
  await closeRevocationStore();
});

// ── Tests ──

describe('revoke', () => {
  it('stores jti in Redis with SET and EX', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    const result = await revoke('jti-123', 3600);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-123',
      '1',
      { ex: 3600 },
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('uses default TTL when not provided', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    await revoke('jti-456');

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-456',
      '1',
      { ex: 604800 }, // 7 days
    );
  });

  it('is idempotent — duplicate revocations overwrite safely', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    await revoke('jti-789', 3600);
    await revoke('jti-789', 7200);

    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    expect(mockRedis.set).toHaveBeenLastCalledWith(
      'jwt:revoked:jti-789',
      '1',
      { ex: 7200 },
    );
  });

  it('derives TTL from exp when caller TTL is longer than remaining token lifetime', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    const result = await revoke('jti-long-ttl', {
      ttl: 7200,
      exp: 1_700_003_600,
      nowSeconds: 1_700_000_000,
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-long-ttl',
      '1',
      { ex: 3600 },
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('derives TTL from exp when caller TTL is shorter than remaining token lifetime', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    const result = await revoke('jti-short-ttl', {
      ttl: 60,
      exp: 1_700_003_600,
      nowSeconds: 1_700_000_000,
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-short-ttl',
      '1',
      { ex: 3600 },
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('derives TTL from exp when caller TTL equals remaining token lifetime', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    const result = await revoke('jti-equal-ttl', {
      ttl: 3600,
      exp: 1_700_003_600,
      nowSeconds: 1_700_000_000,
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-equal-ttl',
      '1',
      { ex: 3600 },
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('treats already-expired tokens as revocation no-ops', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    const result = await revoke('jti-expired', {
      ttl: 3600,
      exp: 1_699_999_990,
      nowSeconds: 1_700_000_000,
    });

    expect(result).toEqual({ revoked: false, ttlSeconds: 0 });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  // ── TTL boundary / resolveRevocationTtl edge-case tests ─────────────────────

  it('skips Redis write when exp is far in the past (never passes non-positive EX)', async () => {
    // exp is 1 hour before now — token long since expired.
    const nowSeconds = 1_700_000_000;
    const result = await revoke('jti-far-past', {
      exp: nowSeconds - 3600,
      nowSeconds,
    });

    expect(result).toEqual({ revoked: false, ttlSeconds: 0 });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('skips Redis write when exp equals now (exp == now yields TTL 0, treated as expired)', async () => {
    // When exp == nowSeconds, ceil(exp - now) == 0 which is non-positive.
    // The revocation should be skipped rather than passing EX 0 to Redis.
    const nowSeconds = 1_700_000_000;
    const result = await revoke('jti-exp-now', {
      exp: nowSeconds,
      nowSeconds,
    });

    expect(result).toEqual({ revoked: false, ttlSeconds: 0 });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('stores with TTL=1 when exp is exactly 1 second in the future', async () => {
    mockRedis.set.mockResolvedValue(undefined);
    const nowSeconds = 1_700_000_000;

    const result = await revoke('jti-one-sec', {
      exp: nowSeconds + 1,
      nowSeconds,
    });

    expect(result).toEqual({ revoked: true, ttlSeconds: 1 });
    expect(mockRedis.set).toHaveBeenCalledWith('jwt:revoked:jti-one-sec', '1', { ex: 1 });
  });

  it('stores with correct TTL when exp is far in the future', async () => {
    mockRedis.set.mockResolvedValue(undefined);
    const nowSeconds = 1_700_000_000;
    const exp = nowSeconds + 86400; // 24 hours from now

    const result = await revoke('jti-far-future', { exp, nowSeconds });

    expect(result).toEqual({ revoked: true, ttlSeconds: 86400 });
    expect(mockRedis.set).toHaveBeenCalledWith('jwt:revoked:jti-far-future', '1', { ex: 86400 });
  });

  it('rounds up fractional remaining seconds so a token with <1 s left still gets TTL=1', async () => {
    // exp is an integer (like a real JWT exp claim), but nowSeconds can be
    // fractional (e.g. from Date.now() / 1000). When exp - nowSeconds = 0.4,
    // ceil(0.4) = 1 — must not be treated as expired.
    mockRedis.set.mockResolvedValue(undefined);
    const nowSeconds = 1_700_000_000.4;

    const result = await revoke('jti-half-sec', {
      exp: 1_700_000_001,
      nowSeconds,
    });

    expect(result).toEqual({ revoked: true, ttlSeconds: 1 });
    expect(mockRedis.set).toHaveBeenCalledWith('jwt:revoked:jti-half-sec', '1', { ex: 1 });
  });

  it('rejects empty jti', async () => {
    await expect(revoke('', 3600)).rejects.toThrow('jti must be a non-empty string');
  });

  it('rejects non-string jti', async () => {
    await expect(revoke(123 as any, 3600)).rejects.toThrow('jti must be a non-empty string');
  });

  it('rejects zero TTL', async () => {
    await expect(revoke('jti-000', 0)).rejects.toThrow('ttl must be a positive integer');
  });

  it('rejects negative TTL', async () => {
    await expect(revoke('jti-000', -1)).rejects.toThrow('ttl must be a positive integer');
  });

  it('rejects exp-aware revocation when exp is missing', async () => {
    await expect(revoke('jti-missing-exp', { ttl: 3600 } as unknown as { exp: number })).rejects.toThrow(
      'exp must be a positive integer',
    );
  });

  it('rejects TTL less than current time (effectively expired)', async () => {
    // TTL of 1 second is technically valid but practically useless
    mockRedis.set.mockResolvedValue(undefined);
    await revoke('jti-short', 1);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-short',
      '1',
      { ex: 1 },
    );
  });

  it('throws a typed JwtRevocationError when Redis SET fails during revocation', async () => {
    mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(revoke('jti-fail', 3600)).rejects.toThrow(JwtRevocationError);
    await expect(revoke('jti-fail', 3600)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws a typed JwtRevocationError when Redis connection times out during revocation', async () => {
    mockRedis.set.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(revoke('jti-timeout', 3600)).rejects.toThrow(JwtRevocationError);
    await expect(revoke('jti-timeout', 3600)).rejects.toThrow('ETIMEDOUT');
  });

  it('logs a warning when Redis SET fails during revocation', async () => {
    mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const { warn } = await import('../../../src/utils/logger.js');

    await expect(revoke('jti-log', 3600)).rejects.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'Failed to revoke JWT — Redis error',
      expect.objectContaining({ jti: 'jti-log', error: 'ECONNREFUSED' }),
    );
  });
});

describe('isRevoked', () => {
  it('returns true for revoked jti', async () => {
    mockRedis.exists.mockResolvedValue(true);

    const result = await isRevoked('jti-revoked');

    expect(result).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith('jwt:revoked:jti-revoked');
  });

  it('returns false for non-revoked jti', async () => {
    mockRedis.exists.mockResolvedValue(false);

    const result = await isRevoked('jti-active');

    expect(result).toBe(false);
  });

  it('returns true for invalid jti (safety guard)', async () => {
    const result = await isRevoked('');
    expect(result).toBe(true);
  });

  it('returns true when Redis is unavailable (fail-closed)', async () => {
    mockRedis.exists.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await isRevoked('jti-check');

    expect(result).toBe(true);
  });

  it('returns true when Redis times out (fail-closed)', async () => {
    mockRedis.exists.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await isRevoked('jti-timeout');

    expect(result).toBe(true);
  });
});

describe('closeRevocationStore', () => {
  it('closes Redis connection', async () => {
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.close.mockResolvedValue(undefined);
    await revoke('jti-1', 3600); // Initialize client
    await closeRevocationStore();
    expect(mockRedis.close).toHaveBeenCalled();
  });

  it('is safe to call multiple times', async () => {
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.close.mockResolvedValue(undefined);
    await revoke('jti-1', 3600); // Initialize client
    await closeRevocationStore();
    await closeRevocationStore(); // Second call should not throw
    expect(mockRedis.close).toHaveBeenCalledTimes(1);
  });
});

describe('startup configuration', () => {
  it('creates the Redis client with config derived from getConfig()', async () => {
    mockRedis.set.mockResolvedValue(undefined);

    await revoke('jti-config-check', 3600);

    expect(mockCreateRedisClient).toHaveBeenCalledWith({
      url: 'redis://localhost:6379',
      enabled: true,
      mode: 'standalone',
      sentinelHosts: undefined,
      sentinelName: undefined,
      clusterNodes: undefined,
    });
  });

  it('only creates the Redis client once across multiple calls', async () => {
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.exists.mockResolvedValue(false);

    await revoke('jti-1', 3600);
    await isRevoked('jti-2');
    await revoke('jti-3', 7200);

    expect(mockCreateRedisClient).toHaveBeenCalledTimes(1);
  });
});
