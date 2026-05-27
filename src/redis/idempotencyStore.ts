/**
 * Redis-backed idempotency store for POST /api/streams.
 *
 * Stores the full HTTP response (status code + body) keyed by the
 * caller-supplied Idempotency-Key so that replayed requests return the
 * exact same response without re-executing the business logic.
 *
 * Graceful degradation
 * --------------------
 * If Redis is unavailable (get/set throws), the store logs a warning and
 * returns null / silently skips the write.  The route handler treats a null
 * get() as a cache miss and proceeds normally — idempotency is best-effort
 * when the store is down rather than a hard failure.
 *
 * Security notes
 * --------------
 * - Keys are namespaced under `fluxora:idempotency:` to avoid collisions.
 * - The raw Idempotency-Key value is never logged; only its length is.
 * - TTL is enforced by Redis EX so entries are automatically evicted.
 * - The stored value is JSON-serialised; no eval or dynamic code paths.
 *
 * @module redis/idempotencyStore
 */

import type { RedisClient } from './client.js';

export const IDEMPOTENCY_KEY_PREFIX = 'fluxora:idempotency:';

/** Shape stored in Redis for each idempotency entry. */
export interface IdempotentEntry<T = unknown> {
  /** SHA-256 fingerprint of the normalised request body. */
  requestFingerprint: string;
  /** HTTP status code of the original response. */
  statusCode: number;
  /** Full response body as returned to the client. */
  body: T;
}

export interface IdempotencyStore<T = unknown> {
  /**
   * Retrieve a previously stored response.
   * Returns null on cache miss or Redis unavailability.
   */
  get(key: string): Promise<IdempotentEntry<T> | null>;

  /**
   * Persist a response for future replays.
   * Silently no-ops on Redis unavailability.
   */
  set(key: string, entry: IdempotentEntry<T>, ttlSeconds: number): Promise<void>;
}

export class RedisIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  constructor(private readonly client: RedisClient) {}

  private buildKey(key: string): string {
    return `${IDEMPOTENCY_KEY_PREFIX}${key}`;
  }

  async get(key: string): Promise<IdempotentEntry<T> | null> {
    try {
      const raw = await this.client.get(this.buildKey(key));
      if (raw === null) return null;
      return JSON.parse(raw) as IdempotentEntry<T>;
    } catch (err) {
      console.warn('[IdempotencyStore] Redis get failed — degrading to pass-through', {
        keyLength: key.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async set(key: string, entry: IdempotentEntry<T>, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(this.buildKey(key), JSON.stringify(entry), { ex: ttlSeconds });
    } catch (err) {
      console.warn('[IdempotencyStore] Redis set failed — idempotency not persisted', {
        keyLength: key.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * No-op store used when Redis is disabled or unavailable at startup.
 * Every get() is a miss; every set() is a silent no-op.
 * The route handler degrades gracefully: requests are processed normally
 * but duplicate protection is not enforced.
 */
export class NoOpIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  async get(_key: string): Promise<IdempotentEntry<T> | null> {
    return null;
  }
  async set(_key: string, _entry: IdempotentEntry<T>, _ttlSeconds: number): Promise<void> {}
}

/**
 * In-memory idempotency store for tests and local development.
 * Provides full idempotency semantics without requiring Redis.
 * Not suitable for production (state is lost on restart and not shared
 * across instances).
 */
export class InMemoryIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  private readonly store = new Map<string, IdempotentEntry<T>>();

  async get(key: string): Promise<IdempotentEntry<T> | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, entry: IdempotentEntry<T>, _ttlSeconds: number): Promise<void> {
    this.store.set(key, entry);
  }

  clear(): void {
    this.store.clear();
  }
}
