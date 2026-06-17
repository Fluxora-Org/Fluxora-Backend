/**
 * Redis sliding-window rate limiter.
 *
 * Uses a sorted-set approach: each request is stored as a member with its
 * timestamp as the score. On every check we:
 *   1. Remove members outside the window (ZREMRANGEBYSCORE)
 *   2. Count remaining members (ZCARD)
 *   3. If under limit, add the new request (ZADD) and return allowed
 *   4. Set key expiry to the window length (EXPIRE)
 *
 * This module exposes a pure in-process store that implements the same
 * interface as a real Redis client so that:
 *   - unit/property tests can run without a Redis server
 *   - production code can swap in ioredis by providing a RedisStore adapter
 */

export interface RedisStore {
  /** Remove members with score in [min, max] */
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  /** Count members in the set */
  zcard(key: string): Promise<number>;
  /** Add a member with a score; NX = only if not exists */
  zadd(key: string, score: number, member: string): Promise<number>;
  /** Set TTL in seconds */
  expire(key: string, seconds: number): Promise<number>;
  /** Retrieve all members with scores (for introspection/testing) */
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
}

/**
 * In-memory implementation of RedisStore for testing and local development.
 * Not thread-safe; for test use only.
 */
export class InMemoryRedisStore implements RedisStore {
  // key → sorted list of { score, member }
  private sets = new Map<string, Array<{ score: number; member: string }>>();
  private expiries = new Map<string, number>();

  private getSet(key: string): Array<{ score: number; member: string }> {
    const now = Date.now();
    if (this.expiries.has(key) && now > (this.expiries.get(key) ?? 0)) {
      this.sets.delete(key);
      this.expiries.delete(key);
    }
    if (!this.sets.has(key)) {
      this.sets.set(key, []);
    }
    return this.sets.get(key)!;
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const set = this.getSet(key);
    const before = set.length;
    const filtered = set.filter((e) => e.score < min || e.score > max);
    this.sets.set(key, filtered);
    return before - filtered.length;
  }

  async zcard(key: string): Promise<number> {
    return this.getSet(key).length;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.getSet(key);
    const existing = set.findIndex((e) => e.member === member);
    if (existing !== -1) {
      return 0;
    }
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score);
    return 1;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expiries.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return this.getSet(key)
      .filter((e) => e.score >= min && e.score <= max)
      .map((e) => e.member);
  }

  /** Test helper: force expiry of a key */
  _forceExpire(key: string): void {
    this.expiries.set(key, Date.now() - 1);
  }
}

export interface SlidingWindowResult {
  allowed: boolean;
  count: number;
  remaining: number;
  limit: number;
  resetAfterMs: number;
}

/**
 * Check and record a request against the sliding window.
 *
 * @param store     - Redis-compatible store
 * @param key       - unique key for the caller (e.g. "rl:ip:1.2.3.4")
 * @param limit     - max allowed requests per window
 * @param windowMs  - window duration in milliseconds
 * @param now       - current timestamp in ms (injectable for testing)
 */
export async function slidingWindowCheck(
  store: RedisStore,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): Promise<SlidingWindowResult> {
  const windowStart = now - windowMs;

  // Purge requests that have left the window
  await store.zremrangebyscore(key, 0, windowStart);

  const count = await store.zcard(key);

  if (count >= limit) {
    return {
      allowed: false,
      count,
      remaining: 0,
      limit,
      resetAfterMs: windowMs,
    };
  }

  // Record this request with a unique member so concurrent requests don't collide
  const member = `${now}-${Math.random().toString(36).slice(2, 9)}`;
  await store.zadd(key, now, member);
  await store.expire(key, Math.ceil(windowMs / 1000));

  const newCount = count + 1;
  return {
    allowed: true,
    count: newCount,
    remaining: limit - newCount,
    limit,
    resetAfterMs: windowMs,
  };
}
