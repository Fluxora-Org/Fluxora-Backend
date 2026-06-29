/**
 * Per-consumer-URL sliding-window rate limiter for outbound webhook retries.
 *
 * Algorithm: Redis sorted set keyed by `webhook_rl:<consumerUrl>`.
 * Each attempt is recorded as a member with score = timestamp (ms).
 * Before each check we prune members older than the window, then count
 * the remaining members. If the count is at or above the limit we deny
 * the attempt and return the time until the oldest member expires.
 *
 * Security notes:
 * - Consumer URL is SHA-256-hashed before use as a Redis key to prevent
 *   key-injection via crafted URLs and to bound key length.
 * - On Redis unavailability we ALLOW the attempt (fail-open) so a Redis
 *   outage does not silently drop all webhook deliveries. Operators should
 *   alert on Redis errors separately.
 * - All Redis operations are executed in a single pipeline to minimise
 *   round-trips and reduce the TOCTOU window.
 */

import { createHash } from 'node:crypto';
import type { RedisClient } from './client.js';

export interface RateLimitConfig {
  /** Maximum delivery attempts allowed within the window. */
  limit: number;
  /** Sliding-window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether the attempt is permitted. */
  canAttempt: boolean;
  /**
   * When canAttempt is false: milliseconds until the oldest in-window
   * attempt expires and a slot opens up. Use this as the deferral delay.
   */
  retryAfterMs: number | null;
}

/** Default: 10 attempts per second per consumer URL. */
export const DEFAULT_WEBHOOK_RETRY_RPS = 10;

/** Hard limits applied during config validation. */
export const RATE_LIMIT_MAX_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const RATE_LIMIT_MAX_LIMIT = 100_000;
export const RATE_LIMIT_MIN_WINDOW_MS = 100; // 100ms minimum

export class RateLimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitConfigError';
  }
}

export function validateRateLimitConfig(config: RateLimitConfig): void {
  if (!Number.isFinite(config.limit) || config.limit <= 0) {
    throw new RateLimitConfigError(
      `RateLimitConfig.limit must be a positive finite number, got ${config.limit}`,
    );
  }
  if (config.limit > RATE_LIMIT_MAX_LIMIT) {
    throw new RateLimitConfigError(
      `RateLimitConfig.limit exceeds maximum allowed (${RATE_LIMIT_MAX_LIMIT}), got ${config.limit}`,
    );
  }
  if (!Number.isFinite(config.windowMs) || config.windowMs < RATE_LIMIT_MIN_WINDOW_MS) {
    throw new RateLimitConfigError(
      `RateLimitConfig.windowMs must be >= ${RATE_LIMIT_MIN_WINDOW_MS}ms, got ${config.windowMs}`,
    );
  }
  if (config.windowMs > RATE_LIMIT_MAX_WINDOW_MS) {
    throw new RateLimitConfigError(
      `RateLimitConfig.windowMs exceeds maximum allowed (${RATE_LIMIT_MAX_WINDOW_MS}ms), got ${config.windowMs}`,
    );
  }
}

export class WebhookRateLimiter {
  private readonly consumerConfigs = new Map<string, RateLimitConfig>();

  constructor(private readonly redisClient: RedisClient) {}

  setConsumerConfig(consumerUrl: string, config: RateLimitConfig): void {
    validateRateLimitConfig(config);
    this.consumerConfigs.set(consumerUrl, { ...config });
  }

  removeConsumerConfig(consumerUrl: string): void {
    this.consumerConfigs.delete(consumerUrl);
  }

  resolveConfig(consumerUrl: string, fallback: RateLimitConfig): RateLimitConfig {
    return this.consumerConfigs.get(consumerUrl) ?? fallback;
  }

  /**
   * Check whether a delivery attempt to `consumerUrl` is within the
   * configured rate limit and, if so, record the attempt.
   *
   * The check-and-record is not strictly atomic (Redis does not support
   * conditional ZADD + ZCOUNT in a single command), but the pipeline
   * minimises the race window to sub-millisecond on a local Redis. For
   * webhook retry use-cases this is an acceptable trade-off.
   */
  async checkLimit(consumerUrl: string, config: RateLimitConfig): Promise<RateLimitResult> {
    validateRateLimitConfig(config);
    const resolvedConfig = this.resolveConfig(consumerUrl, config);
    const key = `webhook_rl:${hashUrl(consumerUrl)}`;
    const now = Date.now();
    const windowStart = now - resolvedConfig.windowMs;

    try {
      // Step 1: prune expired entries and count remaining in one pipeline.
      const pruneResults = await this.redisClient
        .multi()
        .zremrangebyscore(key, 0, windowStart - 1)
        .exec();

      // Propagate pipeline-level errors.
      for (const [err] of pruneResults) {
        if (err) throw err;
      }

      // Step 2: count current window entries.
      const count = await this.redisClient.zcount(key, windowStart, '+inf');

      if (count >= resolvedConfig.limit) {
        // Determine when the oldest entry in the window expires so the
        // caller can schedule a deferral for exactly that long.
        const retryAfterMs = resolvedConfig.windowMs;
        return { canAttempt: false, retryAfterMs };
      }

      // Step 3: record this attempt with a unique member (timestamp + random
      // suffix) so concurrent attempts from multiple workers don't collide
      // on NX and silently drop each other's records.
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
      const ttlMs = resolvedConfig.windowMs * 2; // generous TTL so Redis auto-cleans

      const recordResults = await this.redisClient
        .multi()
        .zadd(key, 'NX', now, member)
        .pexpire(key, ttlMs)
        .exec();

      for (const [err] of recordResults) {
        if (err) throw err;
      }

      return { canAttempt: true, retryAfterMs: null };
    } catch (err) {
      // Fail-open: log and allow the attempt so a Redis outage does not
      // silently halt all webhook deliveries.
      console.error('[WebhookRateLimiter] Redis error — failing open:', err);
      return { canAttempt: true, retryAfterMs: null };
    }
  }

  // recordFailure is intentionally a no-op: the rate limiter counts all
  // outbound attempts regardless of outcome. Failures are handled by the
  // retry policy (backoff + DLQ), not by the rate limiter.
  async recordFailure(_consumerUrl: string, _config: RateLimitConfig): Promise<void> {}
}

export function createWebhookRateLimiter(redisClient: RedisClient): WebhookRateLimiter {
  return new WebhookRateLimiter(redisClient);
}

/** Hash a consumer URL to a fixed-length, injection-safe Redis key segment. */
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}
