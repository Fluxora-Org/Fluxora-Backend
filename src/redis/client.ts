/**
 * Redis client factory supporting standalone, Sentinel, and Cluster modes.
 *
 * Mode is selected via REDIS_MODE env var (default: standalone).
 * Structured log events are emitted on connect, reconnecting, and error
 * so ops tooling can alert on failover.
 */

import type { Redis, Cluster } from 'ioredis';
import { logger } from '../logging/logger.js';

export interface RedisConfig {
  url: string;
  enabled: boolean;
  /** Deployment mode. Defaults to 'standalone'. */
  mode?: 'standalone' | 'sentinel' | 'cluster';
  /** Comma-separated sentinel nodes: host:port,host:port */
  sentinelHosts?: string;
  /** Sentinel master name (required for sentinel mode) */
  sentinelName?: string;
  /** Comma-separated cluster nodes: host:port,host:port */
  clusterNodes?: string;
}

export interface RedisPipeline {
  zadd(key: string, nx: 'NX', score: number, member: string): this;
  zremrangebyscore(key: string, min: string | number, max: string | number): this;
  zcard(key: string): this;
  pexpire(key: string, ms: number): this;
  exec(): Promise<Array<[Error | null, unknown]>>;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<void>;
  /** SET key value NX PX ms — returns true when the key was created. */
  setNx(key: string, value: string, pxMs: number): Promise<boolean>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  close(): Promise<void>;
  multi(): RedisPipeline;
  zcount(key: string, min: string | number, max: string | number): Promise<number>;
}

export interface RedisClientFactory {
  createClient(config: RedisConfig): Promise<RedisClient>;
}

const activeRedisClients = new Set<RedisClient>();

function registerRedisClient(client: RedisClient): RedisClient {
  activeRedisClients.add(client);
  return client;
}

function unregisterRedisClient(client: RedisClient): void {
  activeRedisClients.delete(client);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse "host:port" pairs from a comma-separated string. */
function parseHostPorts(raw: string): Array<{ host: string; port: number }> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const lastColon = s.lastIndexOf(':');
      if (lastColon === -1) throw new Error(`Invalid host:port entry: "${s}"`);
      const host = s.slice(0, lastColon);
      const port = parseInt(s.slice(lastColon + 1), 10);
      if (!host || isNaN(port)) throw new Error(`Invalid host:port entry: "${s}"`);
      return { host, port };
    });
}

/** Attach structured log listeners to any ioredis client (Redis | Cluster). */
function attachLogListeners(client: Redis | Cluster, mode: string): void {
  client.on('connect', () => logger.info('redis:connect', { mode }));
  client.on('ready', () => logger.info('redis:ready', { mode }));
  client.on('reconnecting', () => logger.warn('redis:reconnecting', { mode }));
  client.on('error', (err: Error) =>
    logger.error('redis:error', { mode, error: err.message }),
  );
  client.on('close', () => logger.warn('redis:close', { mode }));
  client.on('end', () => logger.warn('redis:end', { mode }));
}

// ---------------------------------------------------------------------------
// IORedisClient — thin wrapper that normalises the ioredis API
// ---------------------------------------------------------------------------

class IORedisClient implements RedisClient {
  private closed = false;

  constructor(private readonly client: Redis | Cluster) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key) as Promise<string | null>;
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    if (options?.ex) {
      await this.client.set(key, value, 'EX', options.ex);
    } else {
      await this.client.set(key, value);
    }
  }

  async setNx(key: string, value: string, pxMs: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'PX', pxMs, 'NX');
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    unregisterRedisClient(this);
    await this.client.quit();
  }

  multi(): RedisPipeline {
    const pipeline = this.client.multi();
    const wrapper: RedisPipeline = {
      zadd(key, nx, score, member) {
        pipeline.zadd(key, 'NX', score, member);
        return wrapper;
      },
      zremrangebyscore(key, min, max) {
        pipeline.zremrangebyscore(key, min, max);
        return wrapper;
      },
      zcard(key) {
        pipeline.zcard(key);
        return wrapper;
      },
      pexpire(key, ms) {
        pipeline.pexpire(key, ms);
        return wrapper;
      },
      exec() {
        return pipeline.exec() as Promise<Array<[Error | null, unknown]>>;
      },
    };
    return wrapper;
  }

  async zcount(key: string, min: string | number, max: string | number): Promise<number> {
    return this.client.zcount(key, min, max);
  }
}

// ---------------------------------------------------------------------------
// DefaultRedisClientFactory — builds the right ioredis client for the mode
// ---------------------------------------------------------------------------

export class DefaultRedisClientFactory implements RedisClientFactory {
  async createClient(config: RedisConfig): Promise<RedisClient> {
    const ioredis = await import('ioredis');
    const mode = config.mode ?? 'standalone';

    let raw: Redis | Cluster;

    if (mode === 'cluster') {
      raw = await this._createCluster(ioredis, config);
    } else if (mode === 'sentinel') {
      raw = await this._createSentinel(ioredis, config);
    } else {
      raw = await this._createStandalone(ioredis, config);
    }

    attachLogListeners(raw, mode);
    return new IORedisClient(raw);
  }

  private async _createStandalone(
    ioredis: typeof import('ioredis'),
    config: RedisConfig,
  ): Promise<Redis> {
    const { URL } = await import('url');
    const url = new URL(config.url);
    const port = parseInt(url.port || '6379', 10);
    const host = url.hostname || 'localhost';
    const password = url.password || undefined;

    const client = new ioredis.Redis(port, host, {
      password,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 5000,
    });
    await client.connect();
    return client;
  }

  private async _createSentinel(
    ioredis: typeof import('ioredis'),
    config: RedisConfig,
  ): Promise<Redis> {
    if (!config.sentinelHosts) {
      throw new Error('REDIS_SENTINEL_HOSTS is required when REDIS_MODE=sentinel');
    }
    const name = config.sentinelName ?? 'mymaster';
    const sentinels = parseHostPorts(config.sentinelHosts);

    // Extract password from REDIS_URL if present
    const { URL } = await import('url');
    const password = (() => {
      try {
        return new URL(config.url).password || undefined;
      } catch {
        return undefined;
      }
    })();

    const client = new ioredis.Redis({
      sentinels,
      name,
      password,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 5000,
    });
    await client.connect();
    return client;
  }

  private async _createCluster(
    ioredis: typeof import('ioredis'),
    config: RedisConfig,
  ): Promise<Cluster> {
    if (!config.clusterNodes) {
      throw new Error('REDIS_CLUSTER_NODES is required when REDIS_MODE=cluster');
    }
    const nodes = parseHostPorts(config.clusterNodes);

    const { URL } = await import('url');
    const password = (() => {
      try {
        return new URL(config.url).password || undefined;
      } catch {
        return undefined;
      }
    })();

    const client = new ioredis.Cluster(nodes, {
      redisOptions: {
        password,
        connectTimeout: 5000,
        maxRetriesPerRequest: 3,
      },
      lazyConnect: true,
    });
    await client.connect();
    return client;
  }
}

// ---------------------------------------------------------------------------
// Module-level factory (replaceable for testing)
// ---------------------------------------------------------------------------

let factory: RedisClientFactory = new DefaultRedisClientFactory();

export function setRedisClientFactory(f: RedisClientFactory): void {
  factory = f;
}

export function getRedisClientFactory(): RedisClientFactory {
  return factory;
}

export async function createRedisClient(config: RedisConfig): Promise<RedisClient> {
  return registerRedisClient(await factory.createClient(config));
}

/**
 * Quit every Redis client created through createRedisClient().
 *
 * This central shutdown hook covers idempotency, circuit-breaker, rate-limit,
 * and future Redis users without relying on each store to be registered in the
 * correct teardown order.
 */
export async function closeAllRedisClients(): Promise<void> {
  const clients = Array.from(activeRedisClients);
  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.close();
      } finally {
        unregisterRedisClient(client);
      }
    }),
  );
}

export function getActiveRedisClientCount(): number {
  return activeRedisClients.size;
}

/** Testing helper. */
export function _resetRedisClientRegistryForTest(): void {
  activeRedisClients.clear();
}

// ---------------------------------------------------------------------------
// NoOpRedisClient — used when Redis is disabled
// ---------------------------------------------------------------------------

export class NoOpRedisClient implements RedisClient {
  async get(): Promise<string | null> { return null; }
  async set(): Promise<void> { return; }
  async setNx(): Promise<boolean> { return true; }
  async del(): Promise<void> { return; }
  async exists(): Promise<boolean> { return false; }
  async close(): Promise<void> { return; }
  multi(): RedisPipeline {
    const noop: RedisPipeline = {
      zadd() { return noop; },
      zremrangebyscore() { return noop; },
      zcard() { return noop; },
      pexpire() { return noop; },
      async exec() { return []; },
    };
    return noop;
  }
  async zcount(): Promise<number> { return 0; }
}
