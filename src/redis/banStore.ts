/**
 * Redis-backed abuse ban store for WebSocket connection limiter.
 *
 * Provides durable, cluster-wide IP bans with TTL expiry.
 * Uses a read-through in-memory cache for performance.
 * Gracefully degrades to local in-memory enforcement on Redis failure.
 *
 * Security & Resilience
 * - Fail-safe: Redis outage never disables banning (falls back to local cache).
 * - TTL keys ensure automatic expiry without manual cleanup.
 * - Audit logging on ban creation and expiry.
 * - Keys prefixed to avoid collisions.
 *
 * @module redis/banStore
 */

import type { RedisClient } from './client.js';
import { logger } from '../lib/logger.js';

export const BAN_KEY_PREFIX = 'fluxora:ws:ban:';

/** Sanitise IP for use in Redis key (replace unsafe chars). */
export function sanitiseIp(ip: string): string {
  return ip.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 256) || 'unknown';
}

function buildKey(ip: string): string {
  return `${BAN_KEY_PREFIX}${sanitiseIp(ip)}`;
}

/** Result of a ban check. */
export interface BanCheckResult {
  banned: boolean;
  /** Expiry timestamp (ms since epoch) if banned. */
  expiry?: number;
}

/** Options for ban creation. */
export interface BanOptions {
  /** Ban duration in seconds (TTL). */
  ttlSeconds: number;
  /** IP address to ban. */
  ip: string;
}

/** Interface for ban storage backends. */
export interface BanStore {
  /**
   * Check if an IP is currently banned.
   * Returns { banned: true, expiry } if active ban exists.
   */
  isBanned(ip: string): Promise<BanCheckResult>;

  /**
   * Record a ban for the given IP with TTL.
   * Emits audit log entry.
   */
  ban(options: BanOptions): Promise<void>;

  /**
   * Remove a ban (used on expiry or manual unban).
   */
  unban(ip: string): Promise<void>;

  /**
   * Release resources.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryBanStore — fallback / local cache
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of BanStore.
 * Used as local read-through cache and fallback when Redis unavailable.
 */
export class InMemoryBanStore implements BanStore {
  private readonly bans = new Map<string, number>(); // ip -> expiryMs

  async isBanned(ip: string): Promise<BanCheckResult> {
    const expiry = this.bans.get(ip);
    if (!expiry) return { banned: false };

    const now = Date.now();
    if (now < expiry) {
      return { banned: true, expiry };
    }
    // Expired — clean up
    this.bans.delete(ip);
    return { banned: false };
  }

  async ban(options: BanOptions): Promise<void> {
    const { ip, ttlSeconds } = options;
    const expiry = Date.now() + ttlSeconds * 1000;
    this.bans.set(ip, expiry);
    logger.warn('IP banned for WebSocket abuse (local)', undefined, {
      ip,
      ttlSeconds,
      expiry: new Date(expiry).toISOString(),
      source: 'in-memory',
    });
  }

  async unban(ip: string): Promise<void> {
    this.bans.delete(ip);
  }

  async close(): Promise<void> {
    this.bans.clear();
  }

  /** Test helper */
  _getBanExpiry(ip: string): number | undefined {
    return this.bans.get(ip);
  }
}

// ---------------------------------------------------------------------------
// RedisBanStore — durable cluster-wide store
// ---------------------------------------------------------------------------

/**
 * Redis implementation using SET key value EX ttlSeconds.
 * Keys are automatically expired by Redis.
 */
export class RedisBanStore implements BanStore {
  constructor(
    private readonly client: RedisClient,
    private readonly onError?: (err: unknown, op: string) => void,
  ) {}

  async isBanned(ip: string): Promise<BanCheckResult> {
    const key = buildKey(ip);
    try {
      const value = await this.client.get(key);
      if (value === null) return { banned: false };

      // Value is stored as expiry timestamp string
      const expiry = parseInt(value, 10);
      if (Number.isNaN(expiry) || Date.now() >= expiry) {
        await this.client.del(key);
        return { banned: false };
      }
      return { banned: true, expiry };
    } catch (err) {
      this.onError?.(err, 'isBanned');
      throw err;
    }
  }

  async ban(options: BanOptions): Promise<void> {
    const { ip, ttlSeconds } = options;
    const key = buildKey(ip);
    const expiry = Date.now() + ttlSeconds * 1000;

    try {
      await this.client.set(key, expiry.toString(), { ex: ttlSeconds });
      logger.warn('IP banned for WebSocket abuse (redis)', undefined, {
        ip,
        ttlSeconds,
        expiry: new Date(expiry).toISOString(),
        source: 'redis',
        key,
      });
    } catch (err) {
      this.onError?.(err, 'ban');
      throw err;
    }
  }

  async unban(ip: string): Promise<void> {
    const key = buildKey(ip);
    try {
      await this.client.del(key);
    } catch (err) {
      this.onError?.(err, 'unban');
      throw err;
    }
  }

  async close(): Promise<void> {
    // Client lifecycle managed externally
  }
}

// ---------------------------------------------------------------------------
// HybridBanStore — resilient wrapper
// ---------------------------------------------------------------------------

/**
 * Hybrid implementation: prefers RedisBanStore, falls back to InMemoryBanStore on error.
 * Maintains a local read-through cache for fast checks.
 * Ensures banning is never disabled by Redis outage.
 */
export class HybridBanStore implements BanStore {
  usingFallback = false;
  private readonly localCache = new InMemoryBanStore();

  constructor(
    private readonly primary: BanStore,
    private readonly fallback: BanStore = new InMemoryBanStore(),
    private readonly onError?: (err: unknown, op: string) => void,
  ) {}

  async isBanned(ip: string): Promise<BanCheckResult> {
    // Always check local cache first (read-through)
    const cached = await this.localCache.isBanned(ip);
    if (cached.banned) {
      return cached;
    }

    try {
      const result = await this.primary.isBanned(ip);
      if (result.banned) {
        // Populate local cache
        if (result.expiry) {
          await this.localCache.ban({ ip, ttlSeconds: Math.ceil((result.expiry - Date.now()) / 1000) });
        }
      }
      return result;
    } catch (err) {
      this.onError?.(err, 'isBanned');
      this.usingFallback = true;
      return this.fallback.isBanned(ip);
    }
  }

  async ban(options: BanOptions): Promise<void> {
    // Always record in local cache
    await this.localCache.ban(options);

    try {
      await this.primary.ban(options);
      this.usingFallback = false;
    } catch (err) {
      this.onError?.(err, 'ban');
      this.usingFallback = true;
      // Local cache already has it — fail safe
      await this.fallback.ban(options);
    }
  }

  async unban(ip: string): Promise<void> {
    await this.localCache.unban(ip);
    try {
      await this.primary.unban(ip);
    } catch (err) {
      this.onError?.(err, 'unban');
      await this.fallback.unban(ip);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close(), this.localCache.close()]);
  }
}

/** Factory to create the appropriate ban store. */
export function createBanStore(
  redisClient?: RedisClient,
  onError?: (err: unknown, op: string) => void,
): BanStore {
  if (!redisClient) {
    return new InMemoryBanStore();
  }
  const redisStore = new RedisBanStore(redisClient, onError);
  const memoryStore = new InMemoryBanStore();
  return new HybridBanStore(redisStore, memoryStore, onError);
}
