import { getConfig } from '../config/env.js';
import { warn, info, debug } from '../utils/logger.js';
import { createRedisClient, type RedisClient } from './client.js';

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

let redis: RedisClient | null = null;
let initPromise: Promise<RedisClient> | null = null;

export class JwtRevocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtRevocationError';
  }
}

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
 * Reuses the same connection across calls and is safe for concurrent callers.
 *
 * Uses the shared {@link createRedisClient} factory so the connection is
 * tracked for graceful shutdown via {@link quitAllRedisClients} and benefits
 * from the same standalone/sentinel/cluster mode support, retry strategy, and
 * structured logging as every other Redis-backed subsystem.
 */
async function getRedisClient(): Promise<RedisClient> {
  if (redis) return redis;

  if (!initPromise) {
    const config = getConfig();
    initPromise = createRedisClient({
      url: config.redisUrl,
      enabled: config.redisEnabled,
      mode: config.redisMode,
      sentinelHosts: config.redisSentinelHosts,
      sentinelName: config.redisSentinelName,
      clusterNodes: config.redisClusterNodes,
    });
  }

  redis = await initPromise;
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
 * @throws {TypeError} If jti is empty or non-string.
 * @throws {TypeError} If TTL is not a positive integer.
 * @throws {JwtRevocationError} If the Redis write fails — logs the failure and
 *   re-throws with the underlying Redis error message so callers can surface a
 *   clear 503 to the operator.
 *
 * @security
 * - FAIL-LOUD: Redis write failures during revoke() throw a typed
 *   JwtRevocationError rather than silently swallowing the error. An operator
 *   attempting to revoke a compromised token during an incident deserves a
 *   clear, actionable failure if that revocation did not actually take effect.
 * - Uses SET with EX (expiry) to prevent unbounded storage growth.
 * - Overwrites any existing entry (idempotent — duplicate revocations are safe).
 * - Never passes a zero/negative TTL to Redis (resolveRevocationTtl returns
 *   null for already-expired tokens, and revoke() short-circuits on null).
 * - Logs revocation for audit trail.
 * - On Redis error (connection failed, timeout): logs via structured logger and
 *   throws JwtRevocationError with the underlying error message preserved.
 *   This is intentionally the opposite of isRevoked()'s fail-closed strategy:
 *   failing open (returning success for a write that didn't happen) would be
 *   worse than failing loud for a security-critical admin action.
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

  const client = await getRedisClient();
  const key = buildKey(jti);

  try {
    await client.set(key, '1', { ex: ttl });
    info('JWT revoked', { jti, ttlSeconds: ttl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn('Failed to revoke JWT — Redis error', { jti, error: message });
    throw new JwtRevocationError(`Failed to revoke JWT: ${message}`);
  }

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

  const client = await getRedisClient();
  const key = buildKey(jti);

  try {
    const revoked = await client.exists(key);
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
    await redis.close();
    redis = null;
    initPromise = null;
    info('JWT revocation store Redis connection closed');
  }
}
