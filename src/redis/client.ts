/**
 * Redis client factory supporting standalone, Sentinel, and Cluster modes.
 *
 * Mode is selected via REDIS_MODE env var (default: standalone).
 * Structured log events are emitted on connect, reconnecting, and error
 * so ops tooling can alert on failover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Reconnection behaviour
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ioredis reconnects automatically whenever the TCP socket is lost.  The
 * reconnect schedule is driven by `defaultRetryStrategy` (below), which
 * delegates to `calculateNextRetryDelay` from `src/lib/retry.ts`.
 *
 * ### Backoff parameters (all overridable via env vars)
 *
 * | Env var                      | Default  | Meaning                                   |
 * |------------------------------|----------|-------------------------------------------|
 * | REDIS_RETRY_BASE_DELAY_MS    | 50 ms    | Delay after the first reconnect attempt   |
 * | REDIS_RETRY_MAX_DELAY_MS     | 2 000 ms | Hard ceiling on any single retry interval |
 * | REDIS_RETRY_MAX_ATTEMPTS     | 10       | Total reconnect attempts before giving up |
 *
 * Delay formula: `base × 2^attempt`, capped at `max`, with bounded legacy
 * jitter (±10 % by default).  After attempt 10 `retryStrategy` returns `null`
 * and ioredis emits an `'end'` event — callers receive `ECONNREFUSED` or a
 * "max retries exceeded" error.
 *
 * Example schedule (defaults, no jitter):
 *   attempt 1 →  50 ms
 *   attempt 2 → 100 ms
 *   attempt 3 → 200 ms
 *   attempt 4 → 400 ms
 *   attempt 5 → 800 ms
 *   attempt 6 → 1 600 ms
 *   attempt 7–10 → 2 000 ms (capped)
 *
 * ### Reconnect lifecycle events
 *
 * Every tracked instance emits structured log events and increments
 * `redis_reconnects_total{instance}` (see `src/metrics/redisPool.ts`):
 *
 *   `redis:connect`      – TCP connection established (before AUTH / SELECT)
 *   `redis:ready`        – server acknowledged; commands can be sent
 *   `redis:reconnecting` – a reconnect attempt is about to start
 *   `redis:close`        – socket closed (precedes reconnecting)
 *   `redis:end`          – ioredis gave up; no further reconnects
 *   `redis:error`        – any low-level error (logged at ERROR level)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Command retry policy (maxRetriesPerRequest)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `maxRetriesPerRequest` (default 3, env `REDIS_MAX_RETRIES_PER_REQUEST`)
 * controls how many times a **single command** is re-queued when the
 * connection is temporarily lost at the moment that command is dispatched.
 *
 * Behaviour during a reconnect window:
 *   • Commands in the offline queue are held until the socket becomes `ready`
 *     again, then re-sent automatically.
 *   • If the client cannot reconnect before the command exhausts its
 *     `maxRetriesPerRequest` attempts, the command promise rejects with
 *     a `MaxRetriesPerRequestError`.
 *   • `recordRedisCommandFailure(instanceName)` is called on every rejection
 *     so `redis_command_failures_total` stays accurate.
 *
 * ### Non-retryable commands
 *
 * The following commands MUST NOT be retried automatically (i.e. callers
 * must treat any error from them as final and not issue the command again
 * without application-level coordination):
 *
 * 1. **`setNx` (SET … NX)** — the lock was potentially acquired before the
 *    connection dropped.  Retrying would double-acquire or silently fail,
 *    both of which corrupt mutual-exclusion semantics in the lock store.
 *
 * 2. **`incr`** — an increment may have been applied server-side before the
 *    error was returned to the client.  Retrying would over-count in rate
 *    limiters and auth-attempt stores.
 *
 * 3. **`delIfValue` (EVAL Lua CAS delete)** — the Lua script is atomic but
 *    the reply can be lost during reconnect.  Retrying risks deleting a key
 *    that was already re-acquired by a different owner.
 *
 * 4. **`multi().exec()` (pipeline / MULTI-EXEC)** — pipelines are not
 *    automatically replayed on reconnect.  A partial pipeline that was
 *    flushed before the socket closed cannot be reconstructed; the caller
 *    must treat pipeline failure as terminal and re-evaluate application
 *    state before retrying the logical operation.
 *
 * ioredis itself does not distinguish retryable from non-retryable at the
 * network layer — all commands are re-queued the same way.  The burden of
 * NOT issuing the above commands a second time rests entirely with the
 * caller.  Each of the four methods above carries an inline `@nonRetryable`
 * JSDoc tag as the machine-readable marker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Connection state exposure
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * {@link getConnectionState} returns a typed snapshot of the current ioredis
 * status for every tracked instance.  Callers can use this to implement
 * health checks, circuit-breaker pre-flight guards, or canary comparisons
 * without coupling to ioredis internals.
 *
 * Prometheus gauges (`redis_connection_status{instance}`) are updated on
 * every poll cycle by {@link startRedisSaturationMetrics}.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Connection saturation metrics
 * ─────────────────────────────────────────────────────────────────────────────
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
import { resolveConnectionLimit } from '../config/connectionLimits.js';
import { logger } from '../logging/logger.js';
import { calculateNextRetryDelay } from '../lib/retry.js';
import {
  redisCommandQueueLength,
  redisConnectionStatus,
  redisQueueLengthWarningsTotal,
  statusToValue,
  syncRedisGauges,
  recordRedisReconnect,
  recordRedisCommandFailure,
} from '../metrics/redisPool.js';

function defaultRetryStrategy(times: number): number | null {
  const delay = calculateNextRetryDelay(times - 1, {
    baseDelayMs: resolveConnectionLimit('REDIS_RETRY_BASE_DELAY_MS'),
    maxDelayMs: resolveConnectionLimit('REDIS_RETRY_MAX_DELAY_MS'),
    maxAttempts: resolveConnectionLimit('REDIS_RETRY_MAX_ATTEMPTS'),
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
  /**
   * SET key value NX PX ms — returns true when the key was created.
   *
   * @nonRetryable The SET NX may have been applied server-side before the
   * connection dropped.  Retrying risks double-acquiring a lock held by this
   * client or silently succeeding when a different owner already holds it.
   * Treat any error as final; do not reissue without application-level
   * coordination.
   */
  setNx(key: string, value: string, pxMs: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /**
   * Delete only when the lock value still belongs to this owner.
   *
   * @nonRetryable The Lua CAS script is atomic but the reply can be lost
   * during reconnect.  Retrying risks deleting a key that was already
   * re-acquired by a different owner.  Treat any error as final.
   */
  delIfValue?(key: string, value: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Atomically increment an integer counter; returns the new value.
   *
   * @nonRetryable The increment may have been applied server-side before the
   * client received an error.  Retrying would over-count in rate limiters and
   * auth-attempt stores.  Treat any error as final.
   */
  incr(key: string): Promise<number>;
  close(): Promise<void>;
  /**
   * Begin a MULTI/EXEC pipeline.
   *
   * @nonRetryable Pipelines are not automatically replayed on reconnect.  A
   * pipeline that was partially flushed before the socket closed cannot be
   * reconstructed; treat `.exec()` failure as terminal and re-evaluate
   * application state before retrying the logical operation.
   */
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
  constructor(
    private readonly client: Redis | Cluster,
    private readonly instanceName: string,
  ) {}

  /**
   * Run a Redis command and count rejections as command failures
   * (separate from reconnect counters).
   */
  private async withCommandMetrics<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      recordRedisCommandFailure(this.instanceName);
      throw err;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.withCommandMetrics(
      () => this.client.get(key) as Promise<string | null>,
    );
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    return this.withCommandMetrics(async () => {
      if (options?.ex) {
        await this.client.set(key, value, 'EX', options.ex);
      } else {
        await this.client.set(key, value);
      }
    });
  }

  async setNx(key: string, value: string, pxMs: number): Promise<boolean> {
    return this.withCommandMetrics(async () => {
      const result = await this.client.set(key, value, 'PX', pxMs, 'NX');
      return result === 'OK';
    });
  }

  async del(key: string): Promise<void> {
    return this.withCommandMetrics(async () => {
      await this.client.del(key);
    });
  }

  async incr(key: string): Promise<number> {
    return this.withCommandMetrics(() => this.client.incr(key));
  }

  async delIfValue(key: string, value: string): Promise<void> {
    return this.withCommandMetrics(async () => {
      await this.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        value,
      );
    });
  }

  async exists(key: string): Promise<boolean> {
    return this.withCommandMetrics(async () => (await this.client.exists(key)) === 1);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  multi(): RedisPipeline {
    const pipeline = this.client.multi();
    const instanceName = this.instanceName;
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
      async exec() {
        try {
          return (await pipeline.exec()) as Array<[Error | null, unknown]>;
        } catch (err) {
          recordRedisCommandFailure(instanceName);
          throw err;
        }
      },
    };
    return wrapper;
  }

  async zcount(key: string, min: string | number, max: string | number): Promise<number> {
    return this.withCommandMetrics(() => this.client.zcount(key, min, max));
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

    return new IORedisClient(raw, instanceName);
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
      maxRetriesPerRequest: resolveConnectionLimit('REDIS_MAX_RETRIES_PER_REQUEST'),
      retryStrategy: defaultRetryStrategy,
      enableReadyCheck: true,
      connectTimeout: resolveConnectionLimit('REDIS_CONNECT_TIMEOUT_MS'),
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
      maxRetriesPerRequest: resolveConnectionLimit('REDIS_MAX_RETRIES_PER_REQUEST'),
      retryStrategy: defaultRetryStrategy,
      enableReadyCheck: true,
      connectTimeout: resolveConnectionLimit('REDIS_CONNECT_TIMEOUT_MS'),
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
        connectTimeout: resolveConnectionLimit('REDIS_CONNECT_TIMEOUT_MS'),
        maxRetriesPerRequest: resolveConnectionLimit('REDIS_MAX_RETRIES_PER_REQUEST'),
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

/**
 * Register a raw ioredis client for saturation-metrics tracking and wire
 * reconnect / failure counters.
 *
 * Reconnects (`reconnecting` events) increment {@link recordRedisReconnect}.
 * Command failures are counted in {@link IORedisClient}, not here — so the two
 * failure modes stay on separate counters.
 */
export function _trackClient(instanceName: string, client: Redis | Cluster): void {
  _trackedClients.set(instanceName, client);
  client.on('reconnecting', () => {
    recordRedisReconnect(instanceName);
  });
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
// Connection state helper
// ---------------------------------------------------------------------------

/**
 * The set of status strings that ioredis can report for a connection.
 *
 * These values are used as the `status` field in {@link RedisConnectionState}
 * and mapped to Prometheus gauge values by `statusToValue` in
 * `src/metrics/redisPool.ts`.
 *
 * | Value          | Meaning                                               |
 * |----------------|-------------------------------------------------------|
 * | `'connecting'` | Initial TCP dial in progress                         |
 * | `'connect'`    | TCP connected, AUTH / SELECT not yet acknowledged    |
 * | `'ready'`      | Fully authenticated; commands are accepted           |
 * | `'reconnecting'`| Lost connection; reconnect back-off in progress     |
 * | `'close'`      | Socket closed (precedes `reconnecting` or `end`)     |
 * | `'end'`        | Max reconnect attempts exhausted; no further retries |
 * | `'wait'`       | `lazyConnect=true` and `.connect()` not yet called   |
 * | `'unknown'`    | Status could not be read (e.g. untracked instance)   |
 */
export type RedisConnectionState =
  | 'connecting'
  | 'connect'
  | 'ready'
  | 'reconnecting'
  | 'close'
  | 'end'
  | 'wait'
  | 'unknown';

/**
 * A typed snapshot of the current connection state for every tracked ioredis
 * instance, keyed by instance name.
 *
 * Use this to implement health checks, circuit-breaker pre-flight guards, or
 * canary comparisons without coupling directly to ioredis internals.
 *
 * @example
 * ```ts
 * const states = getConnectionState();
 * if (states['default'] !== 'ready') {
 *   throw new ServiceUnavailableError('Redis is not ready');
 * }
 * ```
 */
export function getConnectionState(): Record<string, RedisConnectionState> {
  const result: Record<string, RedisConnectionState> = {};
  for (const [name, client] of _trackedClients) {
    const raw = client.status ?? 'unknown';
    const typed: RedisConnectionState = (
      ['connecting', 'connect', 'ready', 'reconnecting', 'close', 'end', 'wait'].includes(raw)
        ? raw
        : 'unknown'
    ) as RedisConnectionState;
    result[name] = typed;
  }
  return result;
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
  async incr(): Promise<number> { return 1; }
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
