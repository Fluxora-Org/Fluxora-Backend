/**
 * src/metrics/redisPool.ts
 *
 * Prometheus Gauge / Counter definitions for Redis (ioredis) connection
 * saturation and failure telemetry.
 *
 * Each series carries an `instance` label so that multiple Redis connections
 * (e.g. "dedup", "idempotency", "webhook-rate-limit") are distinguishable.
 *
 * Metric names follow the Prometheus naming convention:
 *   redis_command_queue_length       – number of commands waiting in the queue
 *   redis_connection_status          – connection state as an enum value
 *   redis_queue_length_warnings_total – counter when queue length exceeds threshold
 *   redis_reconnects_total           – counter of reconnect attempts (separate from command failures)
 *   redis_command_failures_total     – counter of rejected/failed commands (separate from reconnects)
 *
 * ## Connection status enum values
 *   0 = end       – connection fully closed
 *   1 = connecting – initial connect in progress
 *   2 = reconnecting – automatic reconnect in progress
 *   3 = ready      – authenticated and ready to accept commands
 *   4 = close      – connection closed (may re-enter connecting)
 *  -1 = unknown   – unexpected status string
 *
 * ## Alert thresholds (intended)
 *   redis_reconnects_total        – alert when `rate(...[5m]) > 0.1` (sustained reconnect churn)
 *   redis_command_failures_total  – alert when `rate(...[5m]) > 1` (elevated command error rate)
 *
 * @security
 * The `instance` label value is set exclusively from the `instanceName` parameter
 * passed by the application layer (e.g. "default", "dedup", "idempotency").
 * It is **never** derived from user input, preventing label-injection attacks.
 * No unbounded labels (error messages, keys, hosts) are attached — cardinality
 * is bounded by the fixed set of application-defined instance names.
 */

import { Gauge, Counter } from 'prom-client';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Status enum mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw ioredis `status` string to a numeric value suitable for a Prometheus
 * gauge. A monotonic mapping allows operators to alert on transitions away from
 * `ready` (value 3).
 */
export function statusToValue(status: string): number {
  switch (status) {
    case 'end':
      return 0;
    case 'connecting':
      return 1;
    case 'reconnecting':
      return 2;
    case 'ready':
      return 3;
    case 'connect':
      return 3; // 'connect' is functionally equivalent to 'ready' for our purposes
    case 'close':
      return 4;
    case 'wait':
      return 1; // 'wait' means waiting to connect, treat as connecting
    default:
      return -1;
  }
}

// ---------------------------------------------------------------------------
// Gauges / Counters
// ---------------------------------------------------------------------------

/** Number of commands waiting in the Redis command queue. */
export const redisCommandQueueLength =
  (registry.getSingleMetric('redis_command_queue_length') as Gauge<'instance'>) ||
  new Gauge<'instance'>({
    name: 'redis_command_queue_length',
    help: 'Current number of commands waiting in the Redis command queue, labeled by instance',
    labelNames: ['instance'],
    registers: [registry],
  });

/**
 * Connection status as a numeric enum.
 * 0=end, 1=connecting, 2=reconnecting, 3=ready, 4=close, -1=unknown.
 */
export const redisConnectionStatus =
  (registry.getSingleMetric('redis_connection_status') as Gauge<'instance'>) ||
  new Gauge<'instance'>({
    name: 'redis_connection_status',
    help: 'Redis connection status (0=end, 1=connecting, 2=reconnecting, 3=ready, 4=close, -1=unknown), labeled by instance',
    labelNames: ['instance'],
    registers: [registry],
  });

/** Counter incremented every time the command queue length exceeds the warning threshold. */
export const redisQueueLengthWarningsTotal =
  (registry.getSingleMetric('redis_queue_length_warnings_total') as Counter<'instance'>) ||
  new Counter<'instance'>({
    name: 'redis_queue_length_warnings_total',
    help: 'Total number of times the Redis command queue exceeded the warning threshold, labeled by instance',
    labelNames: ['instance'],
    registers: [registry],
  });

/**
 * Counter of Redis reconnect attempts.
 *
 * Incremented on the ioredis `reconnecting` event path — NOT on command
 * failures. Operators should alert separately from {@link redisCommandFailuresTotal}.
 *
 * Intended alert threshold: `rate(redis_reconnects_total[5m]) > 0.1` for 5m
 * (more than ~30 reconnects in a 5-minute window indicates unstable connectivity).
 */
export const redisReconnectsTotal =
  (registry.getSingleMetric('redis_reconnects_total') as Counter<'instance'>) ||
  new Counter<'instance'>({
    name: 'redis_reconnects_total',
    help: 'Total Redis reconnect attempts (ioredis reconnecting events), labeled by instance. Alert when rate > 0.1/s over 5m.',
    labelNames: ['instance'],
    registers: [registry],
  });

/**
 * Counter of Redis command failures (rejected / errored commands).
 *
 * Incremented when a command promise rejects — NOT on reconnect events.
 * Kept separate from {@link redisReconnectsTotal} so alerts can distinguish
 * transport churn from application-visible command errors.
 *
 * Intended alert threshold: `rate(redis_command_failures_total[5m]) > 1` for 2m.
 */
export const redisCommandFailuresTotal =
  (registry.getSingleMetric('redis_command_failures_total') as Counter<'instance'>) ||
  new Counter<'instance'>({
    name: 'redis_command_failures_total',
    help: 'Total Redis command failures (rejected commands), labeled by instance. Alert when rate > 1/s over 5m.',
    labelNames: ['instance'],
    registers: [registry],
  });

// ---------------------------------------------------------------------------
// Failure-path recorders (called from the Redis client layer)
// ---------------------------------------------------------------------------

/**
 * Record a reconnect attempt for the given instance.
 * Call from the ioredis `reconnecting` listener only.
 */
export function recordRedisReconnect(instanceName: string): void {
  redisReconnectsTotal.inc({ instance: instanceName });
}

/**
 * Record a command failure for the given instance.
 * Call when a Redis command promise rejects — never from reconnect handlers.
 */
export function recordRedisCommandFailure(instanceName: string): void {
  redisCommandFailuresTotal.inc({ instance: instanceName });
}

// ---------------------------------------------------------------------------
// Sync function
// ---------------------------------------------------------------------------

/**
 * Stats snapshot from a single Redis connection.
 */
export interface RedisInstanceStats {
  /** Number of queued commands pending execution. */
  commandQueueLength: number;
  /** Raw ioredis status string. */
  status: string;
  /** Arbitrary, application-controlled label (e.g. "default", "dedup"). */
  instanceName: string;
}

/**
 * Sync queue-length and connection-status gauges from the current Redis instance stats.
 *
 * This function is **stateless** — it only sets Prometheus gauge values and does
 * not emit logs or increment counters. Reconnect / command-failure counters are
 * updated on their respective event paths via {@link recordRedisReconnect} and
 * {@link recordRedisCommandFailure}. Callers (e.g. the polling loop in
 * `client.ts`) are responsible for rate-limited warning emission.
 *
 * @param stats - Stats snapshot for a single Redis connection.
 */
export function syncRedisGauges(stats: RedisInstanceStats): void {
  const { commandQueueLength, status, instanceName } = stats;

  redisCommandQueueLength.set({ instance: instanceName }, commandQueueLength);
  redisConnectionStatus.set({ instance: instanceName }, statusToValue(status));
}

/**
 * Remove all Redis pool metrics from the registry.
 * Useful between test runs to avoid duplicate-metric registration errors.
 */
export function deRegisterRedisPoolMetrics(): void {
  registry.removeSingleMetric('redis_command_queue_length');
  registry.removeSingleMetric('redis_connection_status');
  registry.removeSingleMetric('redis_queue_length_warnings_total');
  registry.removeSingleMetric('redis_reconnects_total');
  registry.removeSingleMetric('redis_command_failures_total');
}
