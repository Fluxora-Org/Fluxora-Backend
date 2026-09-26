/**
 * Redis cache/queue environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect. Numeric defaults are sourced
 * from `CONNECTION_LIMIT_DEFAULTS` (see `src/config/connectionLimits.ts`).
 */
import { z } from 'zod';
import { booleanEnv, integerEnv, optionalString, urlString } from './parsers.js';
import { CONNECTION_LIMIT_DEFAULTS as LIMITS } from '../connectionLimits.js';

export const redisEnvSchema = {
  /** Redis connection string for cache, pub/sub, and queue backends. @default 'redis://localhost:6379' */
  REDIS_URL: urlString('REDIS_URL').default('redis://localhost:6379'),
  /** Master switch for Redis-backed features; false falls back to in-memory. @default true */
  REDIS_ENABLED: booleanEnv().default(true),
  /**
   * Client topology: `standalone` (single endpoint), `sentinel`
   * (HA via monitors), or `cluster` (sharded).
   * @default 'standalone'
   */
  REDIS_MODE: z.enum(['standalone', 'sentinel', 'cluster']).default('standalone'),
  /** Comma-separated list of sentinel nodes: host:port,host:port */
  REDIS_SENTINEL_HOSTS: optionalString('REDIS_SENTINEL_HOSTS'),
  /** Sentinel master name (required when REDIS_MODE=sentinel) */
  REDIS_SENTINEL_NAME: optionalString('REDIS_SENTINEL_NAME'),
  /** Comma-separated list of cluster nodes: host:port,host:port */
  REDIS_CLUSTER_NODES: optionalString('REDIS_CLUSTER_NODES'),
  /** TCP connect timeout for each Redis client, in ms. @default 5000 */
  REDIS_CONNECT_TIMEOUT_MS: integerEnv('REDIS_CONNECT_TIMEOUT_MS', 1, 60000).default(
    LIMITS.REDIS_CONNECT_TIMEOUT_MS
  ),
  /** Command retries per request before a Redis call fails. @default 3 */
  REDIS_MAX_RETRIES_PER_REQUEST: integerEnv('REDIS_MAX_RETRIES_PER_REQUEST', 0).default(
    LIMITS.REDIS_MAX_RETRIES_PER_REQUEST
  ),
  /** Base delay of the Redis reconnect backoff, in ms. @default 50 */
  REDIS_RETRY_BASE_DELAY_MS: integerEnv('REDIS_RETRY_BASE_DELAY_MS', 0).default(
    LIMITS.REDIS_RETRY_BASE_DELAY_MS
  ),
  /** Ceiling of the Redis reconnect backoff, in ms. @default 2000 */
  REDIS_RETRY_MAX_DELAY_MS: integerEnv('REDIS_RETRY_MAX_DELAY_MS', 0).default(
    LIMITS.REDIS_RETRY_MAX_DELAY_MS
  ),
  /** Reconnect attempts before ioredis stops retrying. @default 10 */
  REDIS_RETRY_MAX_ATTEMPTS: integerEnv('REDIS_RETRY_MAX_ATTEMPTS', 1).default(
    LIMITS.REDIS_RETRY_MAX_ATTEMPTS
  ),
};
