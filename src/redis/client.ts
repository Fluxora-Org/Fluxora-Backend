/**
 * Redis client factory supporting standalone, Sentinel, and Cluster modes.
 *
 * Mode is selected via REDIS_MODE env var (default: standalone).
 * Structured log events are emitted on connect, reconnecting, and error
 * so ops tooling can alert on failover.
 *
 * ## Connection saturation metrics
 *
 * When {@link startRedisSaturationMetrics} is called (typically from app.ts),
 * a background interval reads the command-queue length and connection status
 * from every tracked ioredis instance and pushes the values into the
 * Prometheus gauges defined in {@link src/metrics/redisPool.ts}.
 *
 * A rate-limited structured warning is emitted via the logger when the queue
 * length exceeds `REDIS_QUEUE_WARNING_THRESHOLD` (default 500).
 */

import type { Redis, Cluster } from 'ioredis';
import { logger } from '../logging/logger.js';
import { calculateNextRetryDelay } from '../lib/retry.js';
import {
  redisCommandQueueLength,
  redisConnectionStatus,
  redisQueueLengthWarningsTotal,
  statusToValue,
  syncRedisGauges,
} from '../metrics/redisPool.js';

function defaultRetryStrategy(times: number): number | null {
  const delay = calculateNextRetryDelay(times - 1, {
    baseDelayMs: 50,
    maxDelayMs: 2000,
    maxAttempts: 10,
  });
  return delay === 0 ? null : delay;
}

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
  client.on('connect', () => logger.info('redis:connect', undefined, { mode }));
  client.on('ready', () => logger.info('redis:ready', undefined, { mode }));
  client.on('reconnecting', () => logger.warn('redis:reconnecting', undefined, { mode }));
  client.on('error', (err: Error) =>
    logger.error('redis:error', undefined, { mode, error: err.message }),
  );
  client.on('close', () => logger.warn('redis:close', undefined, { mode }));
  client.on('end', () => logger.warn('redis:end', undefined, { mode }));
}

// ---------------------------------------------------------------------------
// IORedisClient — thin wrapper that normalises the ioredis API
// ---------------------------------------------------------------------------

class IORedisClient implements RedisClient {
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

    // Generate a stable instance label — use the mode as a simple differentiator.
    // In app.ts where the same config is reused for multiple modules, each call
    // creates a separate connection, but they all share the "default" label.
    const instanceName = 'default';
    _trackClient(instanceName, raw);

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
      retryStrategy: defaultRetryStrategy,
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
      retryStrategy: defaultRetryStrategy,
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
      clusterRetryStrategy: defaultRetryStrategy,
      lazyConnect: true,
    });
    await client.connect();
    return client;
  }
}

// ---------------------------------------------------------------------------
// Tracked ioredis instances for saturation metrics
// ---------------------------------------------------------------------------

/**
 * A minimal stats snapshot that {@link src/metrics/redisPool.ts} understands.
 * Separated into its own interface so the metrics module does not depend on ioredis types.
 */
export interface RedisSaturationStats {
  commandQueueLength: number;
  status: string;
  instanceName: string;
}

/**
 * Internal store of raw ioredis clients, keyed by instance name.
 * Used exclusively by the saturation-metrics polling loop.
 */
const _trackedClients = new Map<string, Redis | Cluster>();

/** Register a raw ioredis client for saturation-metrics tracking. */
function _trackClient(instanceName: string, client: Redis | Cluster): void {
  _trackedClients.set(instanceName, client);
}

/**
 * Collect saturation stats from all tracked ioredis instances.
 * Returns an empty array when no instances are tracked.
 */
export function collectRedisSaturationStats(): RedisSaturationStats[] {
  const stats: RedisSaturationStats[] = [];
  for (const [name, client] of _trackedClients) {
    stats.push({
      commandQueueLength:
        (client as { commandQueue?: { length: number } }).commandQueue?.length ?? 0,
      status: client.status ?? 'unknown',
      instanceName: name,
    });
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Saturation-metrics polling
// ---------------------------------------------------------------------------

/** Default polling interval (ms). Override via REDIS_SATURATION_POLL_INTERVAL_MS. */
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Environment-variable name for the queue-length warning threshold.
 * Defaults to 500 when not set.
 */
const REDIS_QUEUE_WARNING_THRESHOLD = Number(
  process.env['REDIS_QUEUE_WARNING_THRESHOLD'] ?? 500,
);

/**
 * Minimum interval (ms) between successive {@link logger.warn} calls for
 * queue-length exceedance, preventing log floods. Default: 30 000 (30 s).
 */
const REDIS_QUEUE_WARNING_RATE_LIMIT_MS = Number(
  process.env['REDIS_QUEUE_WARNING_RATE_LIMIT_MS'] ?? 30_000,
);

/** Timestamp (epoch ms) of the last queue-length warning, per instance. */
const _lastWarnTimestamps = new Map<string, number>();

let _metricsIntervalTimer: NodeJS.Timeout | null = null;

/** Reset the tracked-clients registry — for testing only. */
export function _resetTrackedClients(): void {
  _trackedClients.clear();
  _lastWarnTimestamps.clear();
  if (_metricsIntervalTimer) {
    clearInterval(_metricsIntervalTimer);
    _metricsIntervalTimer = null;
  }
}

/**
 * Central polling callback: iterates over all tracked clients and syncs
 * gauges, emitting rate-limited warnings on threshold exceedance.
 */
function _pollRedisSaturation(): void {
  const stats = collectRedisSaturationStats();
  const now = Date.now();

  for (const s of stats) {
    // Always update gauges (they stay current even without warnings)
    syncRedisGauges(s);

    // Rate-limited warning
    if (s.commandQueueLength > REDIS_QUEUE_WARNING_THRESHOLD) {
      const lastWarn = _lastWarnTimestamps.get(s.instanceName) ?? 0;
      if (now - lastWarn >= REDIS_QUEUE_WARNING_RATE_LIMIT_MS) {
        _lastWarnTimestamps.set(s.instanceName, now);
        redisQueueLengthWarningsTotal.inc({ instance: s.instanceName });
        logger.warn('redis:queue_length_exceeded', undefined, {
          instance: s.instanceName,
          commandQueueLength: s.commandQueueLength,
          threshold: REDIS_QUEUE_WARNING_THRESHOLD,
          status: s.status,
        });
      }
    }
  }
}

/**
 * Start the Redis saturation metrics polling loop.
 *
 * The loop reads command-queue length and connection status from each tracked
 * ioredis instance at the configured interval and pushes them into Prometheus
 * gauges. A rate-limited warning is emitted when queue length exceeds the
 * configured threshold.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param intervalMs  Polling interval (default: 10 000 ms / 10 s).
 */
export function startRedisSaturationMetrics(
  intervalMs = Number(process.env['REDIS_SATURATION_POLL_INTERVAL_MS']) || DEFAULT_POLL_INTERVAL_MS,
): void {
  if (_metricsIntervalTimer) return;

  logger.info('redis:metrics_started', undefined, {
    intervalMs,
    queueWarningThreshold: REDIS_QUEUE_WARNING_THRESHOLD,
    warnRateLimitMs: REDIS_QUEUE_WARNING_RATE_LIMIT_MS,
  });

  // Run once immediately so there is data on the first scrape
  _pollRedisSaturation();

  _metricsIntervalTimer = setInterval(_pollRedisSaturation, intervalMs);
  _metricsIntervalTimer.unref();
}

/**
 * Stop the Redis saturation metrics polling loop.
 * Idempotent — safe to call when not running.
 */
export function stopRedisSaturationMetrics(): void {
  if (_metricsIntervalTimer) {
    clearInterval(_metricsIntervalTimer);
    _metricsIntervalTimer = null;
    logger.info('redis:metrics_stopped');
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

/** All clients created via {@link createRedisClient}. Used for shutdown drain. */
const _activeClients = new Set<RedisClient>();

export async function createRedisClient(config: RedisConfig): Promise<RedisClient> {
  const client = await factory.createClient(config);
  _activeClients.add(client);
  return client;
}

/**
 * Quit all Redis clients that were created via {@link createRedisClient}.
 * Called during graceful shutdown to close sockets cleanly.
 */
export async function quitAllRedisClients(): Promise<void> {
  const clients = Array.from(_activeClients);
  _activeClients.clear();
  await Promise.all(
    clients.map((c) =>
      c.close().catch((err: unknown) => {
        logger.warn('redis:quit_error', undefined, { error: (err as Error).message });
      }),
    ),
  );
}

/** Reset the active-client registry — for testing only. */
export function _resetRedisClientRegistry(): void {
  _activeClients.clear();
}

// ---------------------------------------------------------------------------
// NoOpRedisClient — used when Redis is disabled
//
// This is the single canonical no-op Redis client for "Redis unavailable"
// scenarios (development, single-process, or when REDIS_ENABLED=false).
//
// Semantics:
// - setNx() returns `true` (always succeeds) because in a single-process /
//   no-Redis environment there is no other instance to contend with, so lock
//   acquisition should succeed immediately. Callers that need single-process
//   mutual exclusion (e.g. adminState) rely on in-process guards (fast-path
//   status checks) in addition to this lock, so the "always succeeds" behaviour
//   is correct and deliberate for this mode.
// - exists() returns `false` (nothing exists in no-op storage).
// - get() returns `null` (nothing stored).
// ---------------------------------------------------------------------------

export class NoOpRedisClient implements RedisClient {
  async get(): Promise<string | null> { return null; }
  async set(): Promise<void> { return; }
  /** Always returns true — simulates an uncontended single-process lock. */
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
