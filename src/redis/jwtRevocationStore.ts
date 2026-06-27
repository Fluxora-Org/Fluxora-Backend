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

export interface JwtRevocationOptions {
  ttl?: number;
  exp: number;
  nowSeconds?: number;
}

export interface JwtRevocationResult {
  revoked: boolean;
  ttlSeconds: number;
}

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

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

/**
 * Compute the Redis TTL (in whole seconds) for a revocation entry.
 *
 * When the caller supplies a raw `JwtRevocationOptions` object the TTL is
 * derived exclusively from the token's own `exp` claim so that:
 *  - A revocation entry is **never** kept alive longer than the token itself.
 *  - A revocation entry is **never** created for a token that has already
 *    expired — such tokens are already refused by JWT signature verification
 *    and there is nothing to protect against.
 *
 * Return semantics
 * ----------------
 * - Returns a **positive integer** (≥ 1) when the token still has remaining
 *   lifetime and should be written to Redis.
 * - Returns **`null`** when the token is already expired (`exp ≤ now`).
 *   Callers **must not** pass a non-positive value to Redis `SET … EX`; the
 *   `null` return is the explicit, safe signal to skip the write entirely.
 *
 * @param input - Either a raw TTL number, a `JwtRevocationOptions` object, or
 *   `undefined` (falls back to `DEFAULT_REVOCATION_TTL_SECONDS`).
 * @returns Positive integer TTL in seconds, or `null` if the token is already
 *   expired and no Redis write should be performed.
 *
 * @security
 *   The function must never return 0 or a negative number: Redis `SET … EX 0`
 *   is an error in some versions, and a negative EX is rejected outright.
 *   Allowing a zero/negative value to reach Redis would silently drop the
 *   revocation record, weakening the guarantee that a revoked-but-not-yet-
 *   expired token stays revoked for its remaining lifetime.
 */
function resolveRevocationTtl(input: number | JwtRevocationOptions | undefined): number | null {
  if (typeof input === 'number' || input === undefined) {
    const ttl = input ?? DEFAULT_REVOCATION_TTL_SECONDS;
    assertPositiveInteger(ttl, 'ttl');
    return ttl;
  }

  const { ttl, exp, nowSeconds = Date.now() / 1000 } = input;
  assertPositiveInteger(exp, 'exp');
  if (ttl !== undefined) {
    assertPositiveInteger(ttl, 'ttl');
  }

  // Compute remaining lifetime, rounding up to the next whole second so that
  // a token with 0.5 s remaining gets a TTL of 1 rather than being treated as
  // already expired.  If the result is ≤ 0 the token has already expired; we
  // return null so the caller can skip the Redis write entirely without ever
  // risking a zero/negative EX argument.
  const remaining = Math.ceil(exp - nowSeconds);
  if (remaining <= 0) {
    return null;
  }
  return remaining;
}

/**
 * Revoke a JWT by its jti claim, storing it in Redis with a TTL.
 *
 * When an `exp` claim is provided, the Redis TTL is derived from the token's
 * remaining lifetime (`ceil(exp - now)`). Caller TTLs are accepted for input
 * validation, but the JWT expiry remains authoritative so a revoked token
 * cannot become accepted again before natural expiry, and Redis does not store
 * revocations past token expiry.
 *
 * Already-expired tokens are treated as no-ops: their JWT verification already
 * fails (`exp` in the past), so there is no active session to protect; skipping
 * the Redis write avoids a zero/negative EX argument that would either be
 * rejected by Redis or immediately evict the record.
 *
 * The numeric TTL overload is kept for legacy callers that cannot supply `exp`.
 * New JWT revocation flows should pass `{ exp, ttl }`.
 *
 * @param jti — The JWT ID (jti) claim to revoke
 * @param options — Time-to-live in seconds or a JwtRevocationOptions object.
 *   Defaults to 7 days when omitted.
 * @returns Promise resolving when the revocation is recorded (or skipped for
 *   already-expired tokens).
 *
 * @security
 * - Uses SET with EX (expiry) to prevent unbounded storage growth
 * - Overwrites any existing entry (idempotent — duplicate revocations are safe)
 * - Never passes a zero/negative TTL to Redis (resolveRevocationTtl returns
 *   null for already-expired tokens, and revoke() short-circuits on null)
 * - Logs revocation for audit trail
 * - On Redis error (connection failed, timeout): throws the error
 *   (caller must handle retry/fallback logic — see isRevoked for fail-closed behavior)
 */
export async function revoke(
  jti: string,
  options?: number | JwtRevocationOptions,
): Promise<JwtRevocationResult> {
  if (!jti || typeof jti !== 'string') {
    throw new TypeError('jti must be a non-empty string');
  }

  const ttl = resolveRevocationTtl(options);

  if (ttl === null) {
    // Token is already expired — no active session remains, and passing a
    // zero/negative EX to Redis would silently drop the record.  Skipping is
    // the correct fail-safe behaviour here.
    info('JWT revocation skipped for expired token', { jti });
    return { revoked: false, ttlSeconds: 0 };
  }

  const client = getRedisClient();
  const key = buildKey(jti);

  await client.set(key, '1', 'EX', ttl);
  info('JWT revoked', { jti, ttlSeconds: ttl });
  return { revoked: true, ttlSeconds: ttl };
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
