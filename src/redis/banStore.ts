/**
 * Redis-backed abuse ban store for WebSocket connection limiter.
 *
 * Provides durable, cluster-wide IP bans with TTL expiry.
 * Uses a read-through in-memory cache for performance.
 * Fails closed on Redis read failures so an outage cannot erase protection.
 *
 * Scope & Expiry Contract
 * ----------------------
 * - Scope: Bans are scoped to IP addresses only. Each ban is identified by the
 *   IP address provided in the BanOptions.ip field.
 * - Expiry: All bans MUST have an explicit TTL (time-to-live) in seconds.
 *   The ttlSeconds field in BanOptions is REQUIRED and must be a positive integer.
 *   Redis automatically expires keys after TTL, and in-memory stores clean up
 *   expired entries on read.
 * - Audit: Every ban operation logs the IP, TTL, expiry timestamp, and source
 *   (redis/in-memory) for traceability.
 * - Bounded Lifetime: Entries cannot outlive their documented lifetime due to
 *   Redis TTL enforcement and in-memory expiry validation.
 *
 * Store Unavailability Behavior
 * -----------------------------
 * - RedisBanStore: Throws errors on Redis failures. Caller must handle.
 * - InMemoryBanStore: Always available (no external dependencies).
 * - HybridBanStore: Fails closed on Redis failures. When Redis is unavailable:
 *   * isBanned() returns { banned: true } (conservative deny)
 *   * ban() succeeds via local fallback cache
 *   * unban() succeeds via local fallback cache
 *   This ensures protection is never disabled by Redis outage.
 *
 * Security & Resilience
 * - Fail-safe: Redis outage never disables banning (falls back to local cache).
 * - TTL keys ensure automatic expiry without manual cleanup.
 * - Audit logging on ban creation and expiry.
 * - Keys prefixed to avoid collisions.
 *
 * @module redis/banStore
 */

import { createHash } from 'crypto';
import type { RedisClient } from './client.js';
import { logger } from '../lib/logger.js';

export const BAN_KEY_PREFIX = 'fluxora:ws:ban:';

/** Sanitise IP for use in Redis key (replace unsafe chars). */
// Hash IP with SHA-256 to prevent collision from truncation (#833)
export function sanitiseIp(ip: string): string {
  if (!ip) return 'unknown';
  return createHash('sha256').update(ip).digest('hex');
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

/**
 * Options for ban creation.
 *
 * @remarks
 * - ttlSeconds: REQUIRED. Must be a positive integer > 0. Represents the
 *   time-to-live in seconds. Redis will automatically expire the ban after this
 *   duration. In-memory stores also enforce this expiry on read.
 * - ip: REQUIRED. The IP address to ban. This is the scope of the ban.
 */
export interface BanOptions {
  /** Ban duration in seconds (TTL). Must be > 0. */
  ttlSeconds: number;
  /** IP address to ban. This defines the ban scope. */
  ip: string;
}

/** Interface for ban storage backends. */
export interface BanStore {
  /**
   * Check if an IP is currently banned.
   * Returns { banned: true, expiry } if active ban exists.
   *
   * Store unavailability behavior:
   * - RedisBanStore: Throws error on Redis failure
   * - InMemoryBanStore: Always succeeds
   * - HybridBanStore: Returns { banned: true } on Redis failure (fail-closed)
   */
  isBanned(ip: string): Promise<BanCheckResult>;

  /**
   * Record a ban for the given IP with TTL.
   * Emits audit log entry with IP, TTL, expiry timestamp, and source.
   *
   * Store unavailability behavior:
   * - RedisBanStore: Throws error on Redis failure
   * - InMemoryBanStore: Always succeeds
   * - HybridBanStore: Succeeds via local fallback on Redis failure
   *
   * @throws {Error} If ttlSeconds is not a positive integer
   */
  ban(options: BanOptions): Promise<void>;

  /**
   * Remove a ban (used on expiry or manual unban).
   *
   * Store unavailability behavior:
   * - RedisBanStore: Throws error on Redis failure
   * - InMemoryBanStore: Always succeeds
   * - HybridBanStore: Succeeds via local fallback on Redis failure
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
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`Invalid ttlSeconds: ${ttlSeconds}. Must be a positive integer.`);
    }
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
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`Invalid ttlSeconds: ${ttlSeconds}. Must be a positive integer.`);
    }
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
 * Hybrid implementation: prefers RedisBanStore and keeps a local cache for
 * known bans. Reads fail closed while Redis is unavailable.
 * Maintains a local read-through cache for fast checks.
 * Ensures banning is never disabled by Redis outage.
 *
 * Store unavailability behavior:
 * - isBanned(): Returns { banned: true } on Redis failure (fail-closed)
 * - ban(): Succeeds via local fallback on Redis failure
 * - unban(): Succeeds via local fallback on Redis failure
 */
export class HybridBanStore implements BanStore {
  usingFallback = false;
  /** Number of times a Redis operation failed and the fallback was invoked. */
  fallbackModeCount = 0;
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
      this.usingFallback = false;
      return result;
    } catch (err) {
      this.onError?.(err, 'isBanned');
      this.usingFallback = true;
      this.fallbackModeCount += 1;
      // An unavailable ban store must never become an allow decision. The next
      // successful Redis read automatically restores normal admission checks.
      return { banned: true };
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
      this.fallbackModeCount += 1;
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

let _globalBanStore: HybridBanStore | null = null;

export function setGlobalHybridBanStore(store: HybridBanStore): void {
  _globalBanStore = store;
}

export function getHybridBanStoreStatus(): { usingFallback: boolean; available: boolean } {
  if (!_globalBanStore) {
    return { usingFallback: false, available: false };
  }
  return {
    usingFallback: _globalBanStore.usingFallback,
    available: true,
  };
}
