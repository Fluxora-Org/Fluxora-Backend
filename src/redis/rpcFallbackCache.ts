/**
 * Redis-backed last-known-good cache for Stellar RPC responses.
 *
 * Security notes:
 * - Keys are constructed from fixed operation names plus optional SHA-256
 *   parameter hashes; raw account addresses are not written to Redis keys.
 * - Values are JSON-serialized data only. The reader never evaluates cached
 *   content as code.
 * - Redis failures degrade to cache misses/no-op writes so the cache cannot
 *   become a new availability dependency for RPC reads.
 */

import { createHash } from 'crypto';
import type { RedisClient } from './client.js';
import { logger } from '../lib/logger.js';

export const RPC_FALLBACK_CACHE_PREFIX = 'rpc:cache::';
const SAFE_OPERATION = /^[A-Za-z0-9._-]+$/;
const RPC_FALLBACK_CACHE_ENVELOPE_VERSION = 1;

export interface RpcFallbackCacheEntry<T> {
  value: T;
  writtenAt: number;
  expiresAt: number;
  ttlSeconds: number;
  refreshDurationMs: number;
}

interface RpcFallbackCacheEnvelope<T> extends RpcFallbackCacheEntry<T> {
  version: typeof RPC_FALLBACK_CACHE_ENVELOPE_VERSION;
}

export interface RpcFallbackCacheSetOptions {
  nowMs?: number;
  refreshDurationMs?: number;
}

export interface RpcFallbackCache {
  get<T>(operation: string, cacheParts?: readonly string[]): Promise<T | null>;
  set<T>(operation: string, value: T, ttlSeconds: number, cacheParts?: readonly string[]): Promise<void>;
  getEntry?<T>(operation: string, cacheParts?: readonly string[]): Promise<RpcFallbackCacheEntry<T> | null>;
  setEntry?<T>(
    operation: string,
    value: T,
    ttlSeconds: number,
    cacheParts?: readonly string[],
    options?: RpcFallbackCacheSetOptions,
  ): Promise<void>;
}

export function hashCachePart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildCacheKey(operation: string, cacheParts: readonly string[] = []): string {
  if (!SAFE_OPERATION.test(operation)) {
    throw new Error('RPC fallback cache operation contains unsafe characters');
  }

  for (const part of cacheParts) {
    if (!SAFE_OPERATION.test(part)) {
      throw new Error('RPC fallback cache key part contains unsafe characters');
    }
  }

  return `${RPC_FALLBACK_CACHE_PREFIX}${[operation, ...cacheParts].join('::')}`;
}

function isCacheEnvelope<T>(value: unknown): value is RpcFallbackCacheEnvelope<T> {
  return typeof value === 'object'
    && value !== null
    && (value as { version?: unknown }).version === RPC_FALLBACK_CACHE_ENVELOPE_VERSION
    && 'value' in value
    && typeof (value as { writtenAt?: unknown }).writtenAt === 'number'
    && typeof (value as { expiresAt?: unknown }).expiresAt === 'number'
    && typeof (value as { ttlSeconds?: unknown }).ttlSeconds === 'number'
    && typeof (value as { refreshDurationMs?: unknown }).refreshDurationMs === 'number';
}

function createCacheEnvelope<T>(
  value: T,
  ttlSeconds: number,
  options: RpcFallbackCacheSetOptions = {},
): RpcFallbackCacheEnvelope<T> {
  const writtenAt = options.nowMs ?? Date.now();
  return {
    version: RPC_FALLBACK_CACHE_ENVELOPE_VERSION,
    value,
    writtenAt,
    expiresAt: writtenAt + ttlSeconds * 1000,
    ttlSeconds,
    refreshDurationMs: Math.max(1, Math.floor(options.refreshDurationMs ?? 1)),
  };
}

function parseCachedValue<T>(raw: string): T {
  const parsed = JSON.parse(raw) as unknown;
  return isCacheEnvelope<T>(parsed) ? parsed.value : parsed as T;
}

function parseCacheEntry<T>(raw: string): RpcFallbackCacheEntry<T> | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!isCacheEnvelope<T>(parsed)) {
    return null;
  }
  return {
    value: parsed.value,
    writtenAt: parsed.writtenAt,
    expiresAt: parsed.expiresAt,
    ttlSeconds: parsed.ttlSeconds,
    refreshDurationMs: parsed.refreshDurationMs,
  };
}

export class RedisRpcFallbackCache implements RpcFallbackCache {
  constructor(private readonly client: RedisClient) {}

  async get<T>(operation: string, cacheParts: readonly string[] = []): Promise<T | null> {
    const key = buildCacheKey(operation, cacheParts);

    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return parseCachedValue<T>(raw);
    } catch (err) {
      logger.warn('Stellar RPC fallback cache read failed', undefined, {
        event: 'rpc_fallback_cache_read_failed',
        operation,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async getEntry<T>(
    operation: string,
    cacheParts: readonly string[] = [],
  ): Promise<RpcFallbackCacheEntry<T> | null> {
    const key = buildCacheKey(operation, cacheParts);

    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return parseCacheEntry<T>(raw);
    } catch (err) {
      logger.warn('Stellar RPC fallback cache metadata read failed', undefined, {
        event: 'rpc_fallback_cache_metadata_read_failed',
        operation,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async set<T>(
    operation: string,
    value: T,
    ttlSeconds: number,
    cacheParts: readonly string[] = [],
  ): Promise<void> {
    return this.setEntry(operation, value, ttlSeconds, cacheParts);
  }

  async setEntry<T>(
    operation: string,
    value: T,
    ttlSeconds: number,
    cacheParts: readonly string[] = [],
    options: RpcFallbackCacheSetOptions = {},
  ): Promise<void> {
    const key = buildCacheKey(operation, cacheParts);

    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      logger.warn('Skipping Stellar RPC fallback cache write with invalid TTL', undefined, {
        event: 'rpc_fallback_cache_invalid_ttl',
        operation,
        ttlSeconds,
      });
      return;
    }

    try {
      await this.client.set(key, JSON.stringify(createCacheEnvelope(value, ttlSeconds, options)), { ex: ttlSeconds });
    } catch (err) {
      logger.warn('Stellar RPC fallback cache write failed', undefined, {
        event: 'rpc_fallback_cache_write_failed',
        operation,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export class NoOpRpcFallbackCache implements RpcFallbackCache {
  async get<T>(): Promise<T | null> {
    return null;
  }

  async set<T>(): Promise<void> {
    return;
  }

  async getEntry<T>(): Promise<RpcFallbackCacheEntry<T> | null> {
    return null;
  }

  async setEntry<T>(): Promise<void> {
    return;
  }
}

export class InMemoryRpcFallbackCache implements RpcFallbackCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async get<T>(operation: string, cacheParts: readonly string[] = []): Promise<T | null> {
    const key = buildCacheKey(operation, cacheParts);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    return parseCachedValue<T>(entry.value);
  }

  async getEntry<T>(
    operation: string,
    cacheParts: readonly string[] = [],
  ): Promise<RpcFallbackCacheEntry<T> | null> {
    const key = buildCacheKey(operation, cacheParts);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    return parseCacheEntry<T>(entry.value);
  }

  async set<T>(
    operation: string,
    value: T,
    ttlSeconds: number,
    cacheParts: readonly string[] = [],
  ): Promise<void> {
    return this.setEntry(operation, value, ttlSeconds, cacheParts);
  }

  async setEntry<T>(
    operation: string,
    value: T,
    ttlSeconds: number,
    cacheParts: readonly string[] = [],
    options: RpcFallbackCacheSetOptions = {},
  ): Promise<void> {
    const key = buildCacheKey(operation, cacheParts);
    const envelope = createCacheEnvelope(value, ttlSeconds, options);
    this.entries.set(key, {
      value: JSON.stringify(envelope),
      expiresAt: envelope.expiresAt,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
