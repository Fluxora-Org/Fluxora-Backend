import Redis from 'ioredis';
import { getConfig } from '../config/env.js';
import { warn, info, debug } from '../utils/logger.js';

/**
 * Redis key prefix for JWT revocation entries.
 * Format: jwt:revoked:<jti>
 */
const REVOCATION_PREFIX = 'jwt:revoked';

/**
 * Default TTL for revoked tokens if not specified.
 * Falls back to the JWT expiry window (7 days) to prevent unbounded growth.
 */
const DEFAULT_REVOCATION_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800 seconds

let redis: Redis | null = null;

/**
 * Lazily initialize and return the shared Redis client.
 * Reuses the same connection across calls.
 */
function getRedisClient(): Redis {
  if (redis) return redis;

  const config = getConfig();
  redis = new Redis({
    host: config.redisHost ?? 'localhost',
    port: config.redisPort ?? 6379,
    password: config.redisPassword || undefined,
    db: config.redisDb ?? 0,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      warn('Redis retry', { attempt: times, delayMs: delay });
      return delay;
    },
    maxRetriesPerRequest: 3,
  });

  redis.on('error', (err) => {
    warn('Redis connection error', { error: err.message });
  });

  redis.on('connect', () => {
    info('Redis connected for JWT revocation store');
  });

  return redis;
}

/**
 * Build the Redis key for a given JWT ID (jti).
 */
function buildKey(jti: string): string {
  return `${REVOCATION_PREFIX}:${jti}`;
}

/**
 * Revoke a JWT by its jti claim, storing it in Redis with a TTL.
 *
 * @param jti — The JWT ID (jti) claim to revoke
 * @param ttl — Time-to-live in seconds. Defaults to 7 days.
 * @returns Promise resolving when the revocation is recorded
 *
 * @security
 * - Uses SET with EX (expiry) to prevent unbounded storage growth
 * - Overwrites any existing entry (idempotent — duplicate revocations are safe)
 * - Logs revocation for audit trail
 */
export async function revoke(jti: string, ttl: number = DEFAULT_REVOCATION_TTL_SECONDS): Promise<void> {
  if (!jti || typeof jti !== 'string') {
    throw new TypeError('jti must be a non-empty string');
  }

  if (ttl <= 0) {
    throw new TypeError('ttl must be a positive integer');
  }

  const client = getRedisClient();
  const key = buildKey(jti);

  await client.set(key, '1', 'EX', ttl);
  info('JWT revoked', { jti, ttlSeconds: ttl });
}

/**
 * Check whether a JWT ID (jti) has been revoked.
 *
 * @param jti — The JWT ID (jti) claim to check
 * @returns Promise<true> if revoked, Promise<false> otherwise
 *
 * @security
 * - FAIL-CLOSED: If Redis is unavailable, returns true (treats token as revoked)
 *   to prevent compromised tokens from being accepted during outages.
 * - Uses EXISTS for O(1) lookup performance.
 * - Caches negative results are not needed because Redis TTL handles cleanup.
 */
export async function isRevoked(jti: string): Promise<boolean> {
  if (!jti || typeof jti !== 'string') {
    // Invalid jti — treat as revoked for safety
    warn('isRevoked called with invalid jti', { jti });
    return true;
  }

  const client = getRedisClient();
  const key = buildKey(jti);

  try {
    const exists = await client.exists(key);
    const revoked = exists > 0;
    debug('JWT revocation check', { jti, revoked });
    return revoked;
  } catch (error) {
    warn('Redis unavailable during revocation check — failing closed', {
      jti,
      error: error instanceof Error ? error.message : String(error),
    });
    // FAIL-CLOSED: Treat as revoked to prevent accepting compromised tokens
    // during Redis outage. This is a security trade-off vs. availability.
    return true;
  }
}

/**
 * Gracefully close the Redis connection.
 * Call during application shutdown.
 */
export async function closeRevocationStore(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    info('JWT revocation store Redis connection closed');
  }
}