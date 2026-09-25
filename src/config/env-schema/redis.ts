/**
 * Redis cache/queue environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { z } from 'zod';
import { booleanEnv, optionalString, urlString } from './parsers.js';

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
};
