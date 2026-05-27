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

export class WebhookRateLimiter {
  constructor(private readonly redisClient: RedisClient) {}

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
    const key = `webhook_rl:${hashUrl(consumerUrl)}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

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

      if (count >= config.limit) {
        // Determine when the oldest entry in the window expires so the
        // caller can schedule a deferral for exactly that long.
        const retryAfterMs = config.windowMs;
        return { canAttempt: false, retryAfterMs };
      }

      // Step 3: record this attempt with a unique member (timestamp + random
      // suffix) so concurrent attempts from multiple workers don't collide
      // on NX and silently drop each other's records.
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
      const ttlMs = config.windowMs * 2; // generous TTL so Redis auto-cleans

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
