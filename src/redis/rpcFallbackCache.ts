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

export interface RpcFallbackCache {
  get<T>(operation: string, cacheParts?: readonly string[]): Promise<T | null>;
  set<T>(operation: string, value: T, ttlSeconds: number, cacheParts?: readonly string[]): Promise<void>;
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

export class RedisRpcFallbackCache implements RpcFallbackCache {
  constructor(private readonly client: RedisClient) {}

  async get<T>(operation: string, cacheParts: readonly string[] = []): Promise<T | null> {
    const key = buildCacheKey(operation, cacheParts);

    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn('Stellar RPC fallback cache read failed', undefined, {
        event: 'rpc_fallback_cache_read_failed',
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
      await this.client.set(key, JSON.stringify(value), { ex: ttlSeconds });
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

    return JSON.parse(entry.value) as T;
  }

  async set<T>(
    operation: string,
    value: T,
    ttlSeconds: number,
    cacheParts: readonly string[] = [],
  ): Promise<void> {
    const key = buildCacheKey(operation, cacheParts);
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
