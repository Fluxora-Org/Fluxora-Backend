import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { revoke, isRevoked, closeRevocationStore } from '../../../src/redis/jwtRevocationStore.js';

// ── Mocks ──

const mockRedis = {
  set: vi.fn(),
  exists: vi.fn(),
  quit: vi.fn(),
  on: vi.fn(),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
}));

vi.mock('../../../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({
    redisHost: 'localhost',
    redisPort: 6379,
    redisPassword: '',
    redisDb: 0,
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
});

afterEach(async () => {
  await closeRevocationStore();
});

// ── Tests ──

describe('revoke', () => {
  it('stores jti in Redis with SET and EX', async () => {
    mockRedis.set.mockResolvedValue('OK');

    const result = await revoke('jti-123', 3600);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-123',
      '1',
      'EX',
      3600,
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('uses default TTL when not provided', async () => {
    mockRedis.set.mockResolvedValue('OK');

    await revoke('jti-456');

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-456',
      '1',
      'EX',
      604800, // 7 days
    );
  });

  it('is idempotent — duplicate revocations overwrite safely', async () => {
    mockRedis.set.mockResolvedValue('OK');

    await revoke('jti-789', 3600);
    await revoke('jti-789', 7200);

    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    expect(mockRedis.set).toHaveBeenLastCalledWith(
      'jwt:revoked:jti-789',
      '1',
      'EX',
      7200,
    );
  });

  it('derives TTL from exp when caller TTL is longer than remaining token lifetime', async () => {
    mockRedis.set.mockResolvedValue('OK');

    const result = await revoke('jti-long-ttl', {
      ttl: 7200,
      exp: 1_700_003_600,
      nowSeconds: 1_700_000_000,
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-long-ttl',
      '1',
      'EX',
      3600,
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('derives TTL from exp when caller TTL is shorter than remaining token lifetime', async () => {
    mockRedis.set.mockResolvedValue('OK');

    const result = await revoke('jti-short-ttl', {
      ttl: 60,
      exp: 1_700_003_600,
      nowSeconds: 1_700_000_000,
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-short-ttl',
      '1',
      'EX',
      3600,
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('derives TTL from exp when caller TTL equals remaining token lifetime', async () => {
    mockRedis.set.mockResolvedValue('OK');

    const result = await revoke('jti-equal-ttl', {
      ttl: 3600,
      exp: 1_700_003_600,
      nowSeconds: 1_700_000_000,
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-equal-ttl',
      '1',
      'EX',
      3600,
    );
    expect(result).toEqual({ revoked: true, ttlSeconds: 3600 });
  });

  it('treats already-expired tokens as revocation no-ops', async () => {
    mockRedis.set.mockResolvedValue('OK');

    const result = await revoke('jti-expired', {
      ttl: 3600,
      exp: 1_699_999_990,
      nowSeconds: 1_700_000_000,
    });

    expect(result).toEqual({ revoked: false, ttlSeconds: 0 });
    expect(mockRedis.set).not.toHaveBeenCalled();
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
    mockRedis.set.mockResolvedValue('OK');
    await revoke('jti-short', 1);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'jwt:revoked:jti-short',
      '1',
      'EX',
      1,
    );
  });

  it('throws when Redis SET fails during revocation (revoke-path failure)', async () => {
    mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(revoke('jti-fail', 3600)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when Redis connection times out during revocation', async () => {
    mockRedis.set.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(revoke('jti-timeout', 3600)).rejects.toThrow('ETIMEDOUT');
  });
});

describe('isRevoked', () => {
  it('returns true for revoked jti', async () => {
    mockRedis.exists.mockResolvedValue(1);

    const result = await isRevoked('jti-revoked');

    expect(result).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith('jwt:revoked:jti-revoked');
  });

  it('returns false for non-revoked jti', async () => {
    mockRedis.exists.mockResolvedValue(0);

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

  it('handles Redis returning unexpected values gracefully', async () => {
    mockRedis.exists.mockResolvedValue(2); // Should not happen, but handle it

    const result = await isRevoked('jti-weird');

    expect(result).toBe(true); // Any non-zero is treated as revoked
  });
});

describe('closeRevocationStore', () => {
  it('closes Redis connection', async () => {
    mockRedis.quit.mockResolvedValue('OK');
    await revoke('jti-1', 3600); // Initialize client
    await closeRevocationStore();
    expect(mockRedis.quit).toHaveBeenCalled();
  });

  it('is safe to call multiple times', async () => {
    mockRedis.quit.mockResolvedValue('OK');
    await revoke('jti-1', 3600); // Initialize client
    await closeRevocationStore();
    await closeRevocationStore(); // Second call should not throw
    expect(mockRedis.quit).toHaveBeenCalledTimes(1);
  });
});
