/**
 * Dedup cache for stream event and inbound webhook deduplication.
 *
 * Provides (streamId, eventId) tracking to prevent duplicate event delivery.
 * Supports two backends:
 *   - InMemoryDedupCache: Fast, non-persistent, cleared on restart
 *   - RedisDedupCache: Persistent across restarts when Redis is available
 *
 * ## Deduplication window
 * A key is remembered for `DEDUP_WINDOW_SECONDS` (default 86400 = 24h),
 * measured from the first time it was added. Within the window, the first
 * `add()` returns true and every later `add()` returns false, so the caller
 * processes the event exactly once. Once the window has elapsed the key is
 * forgotten and the next `add()` returns true again: the event is processed
 * again. Both backends apply the same window.
 *
 * ## Store-unavailable behaviour (fail-open to in-memory)
 * `HybridDedupCache` never rejects an event because Redis is unavailable.
 * When a Redis call throws, it answers from the per-process in-memory cache
 * instead and increments `dedup_redis_fallback_total`. While degraded:
 *   - duplicates reaching the same process inside the window are still
 *     suppressed, up to the most recent DEDUP_CACHE_MAX keys;
 *   - duplicates reaching a different process, arriving after a restart,
 *     or evicted by the DEDUP_CACHE_MAX cap are NOT suppressed and will be
 *     processed again.
 * This cache suppresses duplicate delivery only. Duplicate persistence of
 * streams is prevented independently by the database unique constraint on
 * (transaction_hash, event_index).
 */

import type { RedisClient } from './client.js';
import { dedupRedisErrorsTotal, dedupRedisFallbackTotal } from '../metrics.js';
import { logger } from '../lib/logger.js';

export const DEDUP_KEY_PREFIX = 'fluxora:dedup:';

export interface DedupCache {
    has(streamId: string, eventId: string): Promise<boolean>;
    add(streamId: string, eventId: string): Promise<boolean>;
    clear(): Promise<void>;
    close(): Promise<void>;
}

/** Default deduplication window; overridden by DEDUP_WINDOW_SECONDS. */
export const DEDUP_WINDOW_SECONDS_DEFAULT = 86400;
export const DEDUP_CACHE_MAX = 10_000;
const FALLBACK_LOG_THROTTLE_MS = 5_000;

let lastFallbackLog = 0;

function logFallback(operation: string, streamId: string, eventId: string): void {
  const now = Date.now();
  if (now - lastFallbackLog >= FALLBACK_LOG_THROTTLE_MS) {
    lastFallbackLog = now;
    logger.debug('dedup:fallback', undefined, { operation, streamId, eventId });
  }
}

export function __resetDedupForTest(): void {
  lastFallbackLog = 0;
}

export class InMemoryDedupCache implements DedupCache {
    /** FIFO eviction: when size reaches DEDUP_CACHE_MAX, the oldest-inserted key is evicted.
     * Under sustained load at capacity, this is a one-in-one-out FIFO.
     * Trade-off: evicted keys will be treated as new (false negative) if replayed.
     * This is the fallback for HybridDedupCache when Redis is unavailable;
     * during a Redis outage, dedup degrades to best-effort on the most recent DEDUP_CACHE_MAX events.
     * Each key also expires `windowSeconds` after it was added, matching RedisDedupCache. */
    private readonly seen = new Map<string, number>();
    private readonly windowMs: number;

    constructor(windowSeconds = DEDUP_WINDOW_SECONDS_DEFAULT) {
        this.windowMs = windowSeconds * 1000;
    }

    /** Returns true if the key is present and still inside the window; drops it if expired. */
    private isLive(key: string): boolean {
        const expiresAt = this.seen.get(key);
        if (expiresAt === undefined) return false;
        if (Date.now() < expiresAt) return true;
        this.seen.delete(key);
        return false;
    }

    async has(streamId: string, eventId: string): Promise<boolean> {
        return this.isLive(`${streamId}:${eventId}`);
    }

    async add(streamId: string, eventId: string): Promise<boolean> {
        const key = `${streamId}:${eventId}`;
        if (this.isLive(key)) return false;
        if (this.seen.size >= DEDUP_CACHE_MAX) {
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
        this.seen.set(key, Date.now() + this.windowMs);
        return true;
    }

    async clear(): Promise<void> {
        this.seen.clear();
    }

    async close(): Promise<void> {}
}

export class RedisDedupCache implements DedupCache {
    private readonly client: RedisClient;
    private readonly ttlSeconds: number;

    constructor(client: RedisClient, ttlSeconds = DEDUP_WINDOW_SECONDS_DEFAULT) {
        this.client = client;
        this.ttlSeconds = ttlSeconds;
    }

    private buildKey(streamId: string, eventId: string): string {
        return `${DEDUP_KEY_PREFIX}${streamId}:${eventId}`;
    }

    async has(streamId: string, eventId: string): Promise<boolean> {
        try {
            return await this.client.exists(this.buildKey(streamId, eventId));
        } catch (e) {
            dedupRedisErrorsTotal.inc({ operation: 'has' });
            throw e;
        }
    }

    async add(streamId: string, eventId: string): Promise<boolean> {
        try {
            return await this.client.setNx(
                this.buildKey(streamId, eventId),
                '1',
                this.ttlSeconds * 1000
            );
        } catch (e) {
            dedupRedisErrorsTotal.inc({ operation: 'add' });
            throw e;
        }
    }

    async clear(): Promise<void> {}

    async close(): Promise<void> {
        await this.client.close();
    }
}

export class HybridDedupCache implements DedupCache {
    private readonly primary: DedupCache;
    private readonly fallback: DedupCache;
    private readonly useRedis: boolean;

    constructor(primary: DedupCache, fallback: DedupCache, useRedis: boolean) {
        this.primary = primary;
        this.fallback = fallback;
        this.useRedis = useRedis;
    }

    async has(streamId: string, eventId: string): Promise<boolean> {
        try {
            if (this.useRedis) {
                const inRedis = await this.primary.has(streamId, eventId);
                if (inRedis) return true;
            }
            return this.fallback.has(streamId, eventId);
        } catch {
            dedupRedisFallbackTotal.inc({ operation: 'has' });
            logFallback('has', streamId, eventId);
            return this.fallback.has(streamId, eventId);
        }
    }

    async add(streamId: string, eventId: string): Promise<boolean> {
        if (this.useRedis) {
            try {
                const inFallback = await this.fallback.has(streamId, eventId);
                if (inFallback) {
                    try {
                        await this.primary.add(streamId, eventId);
                    } catch {}
                    return false;
                }
                const added = await this.primary.add(streamId, eventId);
                if (added) await this.fallback.add(streamId, eventId);
                return added;
            } catch {
                dedupRedisFallbackTotal.inc({ operation: 'add' });
                logFallback('add', streamId, eventId);
            }
        }
        return await this.fallback.add(streamId, eventId);
    }

    async clear(): Promise<void> {
        if (this.useRedis) {
            try {
                await this.primary.clear();
            } catch {}
        }
        await this.fallback.clear();
    }

    async close(): Promise<void> {
        if (this.useRedis) {
            await this.primary.close();
        }
        await this.fallback.close();
    }
}
