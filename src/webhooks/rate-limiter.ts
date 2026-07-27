import { createHash } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { IWebhookRateLimiter, RateLimitConfig, RateLimitResult } from '../redis/webhookRateLimit.js';
import { validateRateLimitConfig } from '../redis/webhookRateLimit.js';
import { updateWebhookBucketFill } from '../metrics/requestProtectionMetrics.js';

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

const STALE_BUCKET_CLEANUP_MS = 60_000;
const MIN_STALE_AGE_MS = 30_000;

export class TokenBucketRateLimiter implements IWebhookRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly cleanupTimer: NodeJS.Timeout | null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupStaleBuckets(), STALE_BUCKET_CLEANUP_MS);
    if (typeof this.cleanupTimer?.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.buckets.clear();
  }

  async checkLimit(consumerUrl: string, config: RateLimitConfig): Promise<RateLimitResult> {
    validateRateLimitConfig(config);
    const key = hashUrl(consumerUrl);
    const now = Date.now();
    const capacity = config.burst > 0 ? config.burst : config.limit;
    const refillRate = config.limit / config.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = now - bucket.lastRefillMs;
    if (elapsed > 0) {
      const refill = elapsed * refillRate;
      bucket.tokens = Math.min(capacity, bucket.tokens + refill);
      bucket.lastRefillMs = now;
    }

    updateWebhookBucketFill(key, bucket.tokens);

    if (bucket.tokens >= 1.0) {
      bucket.tokens -= 1.0;
      return { canAttempt: true, retryAfterMs: null };
    }

    const tokensNeeded = 1.0 - bucket.tokens;
    const retryAfterMs = Math.ceil(tokensNeeded / refillRate);
    return { canAttempt: false, retryAfterMs };
  }

  async recordFailure(_consumerUrl: string, _config: RateLimitConfig): Promise<void> {}

  getBucketLevel(consumerUrl: string, config?: RateLimitConfig): number {
    const key = hashUrl(consumerUrl);
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    if (config) {
      const now = Date.now();
      const capacity = config.burst > 0 ? config.burst : config.limit;
      const refillRate = config.limit / config.windowMs;
      const elapsed = now - bucket.lastRefillMs;
      if (elapsed > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRate);
        bucket.lastRefillMs = now;
      }
    }
    return bucket.tokens;
  }

  private cleanupStaleBuckets(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillMs > MIN_STALE_AGE_MS) {
        this.buckets.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug('Cleaned up stale webhook rate-limiter buckets', undefined, { removed });
    }
  }
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}
