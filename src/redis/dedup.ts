/**
 * Dedup cache for WebSocket event deduplication.
 *
 * Provides (streamId, eventId) tracking to prevent duplicate event delivery.
 * Supports two backends:
 *   - InMemoryDedupCache: Fast, non-persistent, cleared on restart
 *   - RedisDedupCache: Persistent across restarts when Redis is available
 */

import type { RedisClient } from './client.js';

export const DEDUP_KEY_PREFIX = 'fluxora:dedup:';

export interface DedupCache {
    has(streamId: string, eventId: string): Promise<boolean>;
    add(streamId: string, eventId: string): Promise<void>;
    clear(): Promise<void>;
    close(): Promise<void>;
}

const DEDUP_TTL_SECONDS = 86400;
const DEDUP_CACHE_MAX = 10_000;

export class InMemoryDedupCache implements DedupCache {
    private readonly seen = new Map<string, true>();

    async has(streamId: string, eventId: string): Promise<boolean> {
        return this.seen.has(`${streamId}:${eventId}`);
    }

    async add(streamId: string, eventId: string): Promise<void> {
        const key = `${streamId}:${eventId}`;
        if (this.seen.has(key)) return;
        if (this.seen.size >= DEDUP_CACHE_MAX) {
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
        this.seen.set(key, true);
    }

    async clear(): Promise<void> {
        this.seen.clear();
    }

    async close(): Promise<void> {}
}

export class RedisDedupCache implements DedupCache {
    private readonly client: RedisClient;
    private readonly ttlSeconds: number;

    constructor(client: RedisClient, ttlSeconds = DEDUP_TTL_SECONDS) {
        this.client = client;
        this.ttlSeconds = ttlSeconds;
    }

    private buildKey(streamId: string, eventId: string): string {
        return `${DEDUP_KEY_PREFIX}${streamId}:${eventId}`;
    }

    async has(streamId: string, eventId: string): Promise<boolean> {
        try {
            return await this.client.exists(this.buildKey(streamId, eventId));
        } catch {
            return false;
        }
    }

    async add(streamId: string, eventId: string): Promise<void> {
        try {
            await this.client.set(
                this.buildKey(streamId, eventId),
                '1',
                { ex: this.ttlSeconds }
            );
        } catch {}
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
            return this.fallback.has(streamId, eventId);
        }
    }

    async add(streamId: string, eventId: string): Promise<void> {
        if (this.useRedis) {
            try {
                await this.primary.add(streamId, eventId);
            } catch {}
        }
        await this.fallback.add(streamId, eventId);
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