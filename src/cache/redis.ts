/**
 * Redis cache client for Fluxora Backend.
 *
 * Provides a thin, testable wrapper around a Redis connection.
 * The client degrades gracefully when Redis is unavailable — callers
 * receive null on cache misses and errors are logged rather than thrown,
 * so the service continues to function without caching.
 *
 * Trust boundaries
 * ----------------
 * - Internal only: never exposed to public clients.
 * - Cache keys are namespaced to prevent collisions.
 *
 * Failure modes
 * -------------
 * - Redis unavailable  → get() returns null, set/del are no-ops; service continues
 * - Serialization error → logged, null returned
 * - Connection timeout  → logged, null returned
 *
 * @module cache/redis
 */

import { logger } from '../lib/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClientInstance = any;

export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  delPattern(pattern: string): Promise<void>;
  ping(): Promise<boolean>;
  quit(): Promise<void>;
}

/**
 * Namespace prefix for all Fluxora cache keys.
 */
export const CACHE_NS = 'fluxora:';

/**
 * TTL constants (seconds).
 */
export const TTL = {
  /** Individual stream — short TTL so mutations propagate quickly. */
  STREAM: 30,
  /** Stream list — slightly longer; invalidated on write. */
  STREAM_LIST: 60,
  /** Health check result — very short. */
  HEALTH: 5,
} as const;

/**
 * Cache key builders — centralised so tests and callers share the same keys.
 */
export const CacheKey = {
  stream: (id: string) => `${CACHE_NS}stream:${id}`,
  streamList: () => `${CACHE_NS}streams:list`,
} as const;

/**
 * Production Redis cache client backed by `redis` npm package.
 */
export class RedisCacheClient implements CacheClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: RedisClientInstance;
  private connected = false;

  constructor(url: string) {
    // Use a lazy-loaded client — actual connection happens in connect()
    // We store the URL and create the client lazily to avoid import issues
    this._url = url;
    this.client = null;
  }

  private _url: string;

  private async ensureClient(): Promise<RedisClientInstance> {
    if (this.client === null) {
      // Dynamic import for ESM/CJS compatibility
      const redis = await import('redis');
      this.client = redis.createClient({ url: this._url });

      this.client.on('error', (err: Error) => {
        logger.error('Redis client error', undefined, { error: err.message });
      });

      this.client.on('connect', () => {
        this.connected = true;
        logger.info('Redis connected');
      });

      this.client.on('end', () => {
        this.connected = false;
        logger.warn('Redis connection closed');
      });
    }
    return this.client;
  }

  async connect(): Promise<void> {
    const client = await this.ensureClient();
    await client.connect();
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.connected) return null;
    try {
      const client = await this.ensureClient();
      const raw = await client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.error('Redis get error', undefined, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.connected) return;
    try {
      const client = await this.ensureClient();
      await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (err) {
      logger.error('Redis set error', undefined, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async del(key: string): Promise<void> {
    if (!this.connected) return;
    try {
      const client = await this.ensureClient();
      await client.del(key);
    } catch (err) {
      logger.error('Redis del error', undefined, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async delPattern(pattern: string): Promise<void> {
    if (!this.connected) return;
    try {
      const client = await this.ensureClient();
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        await client.del(keys);
      }
    } catch (err) {
      logger.error('Redis delPattern error', undefined, {
        pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async ping(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const client = await this.ensureClient();
      const result = await client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async quit(): Promise<void> {
    if (this.connected) {
      const client = await this.ensureClient();
      await client.quit();
    }
  }
}

/**
 * No-op cache client used when Redis is disabled or unavailable.
 * All reads return null; writes are silently dropped.
 */
export class NullCacheClient implements CacheClient {
  async get<T>(_key: string): Promise<T | null> { return null; }
  async set(_key: string, _value: unknown, _ttl: number): Promise<void> { /* no-op */ }
  async del(_key: string): Promise<void> { /* no-op */ }
  async delPattern(_pattern: string): Promise<void> { /* no-op */ }
  async ping(): Promise<boolean> { return false; }
  async quit(): Promise<void> { /* no-op */ }
}

/**
 * In-memory cache client for testing.
 * Supports TTL expiry and pattern deletion.
 */
export class InMemoryCacheClient implements CacheClient {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delPattern(pattern: string): Promise<void> {
    // Convert glob pattern to regex: replace * with .*
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const key of this.store.keys()) {
      if (regex.test(key)) this.store.delete(key);
    }
  }

  async ping(): Promise<boolean> { return true; }
  async quit(): Promise<void> { this.store.clear(); }

  /** Test helper: inspect raw store size. */
  size(): number { return this.store.size; }

  /** Test helper: clear all entries. */
  clear(): void { this.store.clear(); }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let cacheInstance: CacheClient | null = null;

export function setCacheClient(client: CacheClient): void {
  cacheInstance = client;
}

export function getCacheClient(): CacheClient {
  if (!cacheInstance) {
    // Degrade gracefully — return no-op client rather than crashing
    return new NullCacheClient();
  }
  return cacheInstance;
}

export function resetCacheClient(): void {
  cacheInstance = null;
}
