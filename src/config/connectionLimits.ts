/**
 * Single source of truth for the connection, statement and retry limits
 * Fluxora applies to every external dependency: PostgreSQL (primary and read
 * replica), Redis, and the Stellar/Soroban RPC endpoint.
 *
 * The values in {@link CONNECTION_LIMIT_DEFAULTS} are consumed directly by
 * `EnvSchema` in `./env.ts`, so the defaults the process validates at startup
 * are the same values that `src/db/pool.ts`, `src/db/replicaPool.ts`,
 * `src/redis/client.ts` and `src/services/stellar-rpc.ts` apply at runtime.
 *
 * `docs/connection-limits.md` documents these limits in one place, and
 * `connectionLimits.test.ts` fails if the document, this registry and the
 * configuration schema drift apart.
 */

/** Unit a limit is expressed in. */
export type LimitUnit = 'ms' | 'connections' | 'requests' | 'failures';

/** External dependency a limit is scoped to. */
export type DependencyName = 'postgres' | 'postgres-replica' | 'redis' | 'stellar-rpc';

/**
 * Default value for every documented limit.
 *
 * `EnvSchema` uses these constants for its `.default(...)` values, and the
 * runtime modules use {@link resolveConnectionLimit}, so the schema stays the
 * authoritative declaration of each limit.
 */
export const CONNECTION_LIMIT_DEFAULTS = {
  DB_POOL_MIN: 2,
  DB_POOL_MAX: 10,
  DB_CONNECTION_TIMEOUT: 5_000,
  DB_IDLE_TIMEOUT: 30_000,
  POOL_QUEUE_LIMIT: 50,
  STATEMENT_TIMEOUT_MS: 5_000,
  REPLICA_QUEUE_LIMIT: 25,
  REDIS_CONNECT_TIMEOUT_MS: 5_000,
  REDIS_MAX_RETRIES_PER_REQUEST: 3,
  REDIS_RETRY_BASE_DELAY_MS: 50,
  REDIS_RETRY_MAX_DELAY_MS: 2_000,
  REDIS_RETRY_MAX_ATTEMPTS: 10,
  STELLAR_RPC_TIMEOUT: 10_000,
  STELLAR_RPC_MAX_RETRIES: 3,
  STELLAR_RPC_RETRY_DELAY: 1_000,
  RPC_TIMEOUT_MS: 5_000,
  RPC_CB_FAILURE_THRESHOLD: 5,
  RPC_CB_WINDOW_MS: 30_000,
  RPC_CB_RESET_TIMEOUT_MS: 60_000,
} as const;

/** Name of a limit declared in {@link CONNECTION_LIMIT_DEFAULTS}. */
export type ConnectionLimitKey = keyof typeof CONNECTION_LIMIT_DEFAULTS;

/** A single documented limit. */
export interface ConnectionLimit {
  /** Environment variable declared in `EnvSchema`. */
  envVar: ConnectionLimitKey;
  /** External dependency the limit belongs to. */
  dependency: DependencyName;
  /** Unit the value is expressed in. */
  unit: LimitUnit;
  /** What the limit bounds and where it is enforced. */
  description: string;
}

/**
 * Every limit that must appear in `docs/connection-limits.md`.
 *
 * The registry is exhaustive: `connectionLimits.test.ts` asserts that each key
 * of {@link CONNECTION_LIMIT_DEFAULTS} has exactly one entry here and one row in
 * the document, so a limit cannot be added to the schema without being
 * documented.
 */
export const CONNECTION_LIMITS: readonly ConnectionLimit[] = [
  {
    envVar: 'DB_POOL_MIN',
    dependency: 'postgres',
    unit: 'connections',
    description: 'Minimum idle connections kept open in the primary pool (src/db/pool.ts).',
  },
  {
    envVar: 'DB_POOL_MAX',
    dependency: 'postgres',
    unit: 'connections',
    description: 'Hard cap on primary pool connections (src/db/pool.ts).',
  },
  {
    envVar: 'DB_CONNECTION_TIMEOUT',
    dependency: 'postgres',
    unit: 'ms',
    description: 'Time to wait for a pooled connection before failing (src/db/pool.ts).',
  },
  {
    envVar: 'DB_IDLE_TIMEOUT',
    dependency: 'postgres',
    unit: 'ms',
    description: 'Time an idle pooled connection is kept before it is closed (src/db/pool.ts).',
  },
  {
    envVar: 'POOL_QUEUE_LIMIT',
    dependency: 'postgres',
    unit: 'requests',
    description: 'Waiting requests allowed before the primary pool fast-fails with 503 (src/db/pool.ts).',
  },
  {
    envVar: 'STATEMENT_TIMEOUT_MS',
    dependency: 'postgres',
    unit: 'ms',
    description: 'Per-connection statement_timeout applied to the primary pool; 0 disables (src/db/pool.ts).',
  },
  {
    envVar: 'REPLICA_QUEUE_LIMIT',
    dependency: 'postgres-replica',
    unit: 'requests',
    description: 'Waiting requests allowed before the replica pool fast-fails (src/db/replicaPool.ts).',
  },
  {
    envVar: 'REDIS_CONNECT_TIMEOUT_MS',
    dependency: 'redis',
    unit: 'ms',
    description: 'TCP connect timeout for each Redis client (src/redis/client.ts).',
  },
  {
    envVar: 'REDIS_MAX_RETRIES_PER_REQUEST',
    dependency: 'redis',
    unit: 'requests',
    description: 'Command retries per request before a Redis call fails (src/redis/client.ts).',
  },
  {
    envVar: 'REDIS_RETRY_BASE_DELAY_MS',
    dependency: 'redis',
    unit: 'ms',
    description: 'Base delay of the Redis reconnect backoff (src/redis/client.ts).',
  },
  {
    envVar: 'REDIS_RETRY_MAX_DELAY_MS',
    dependency: 'redis',
    unit: 'ms',
    description: 'Ceiling of the Redis reconnect backoff (src/redis/client.ts).',
  },
  {
    envVar: 'REDIS_RETRY_MAX_ATTEMPTS',
    dependency: 'redis',
    unit: 'requests',
    description: 'Reconnect attempts before ioredis stops retrying (src/redis/client.ts).',
  },
  {
    envVar: 'STELLAR_RPC_TIMEOUT',
    dependency: 'stellar-rpc',
    unit: 'ms',
    description: 'Timeout for the legacy Stellar RPC client (src/config.ts).',
  },
  {
    envVar: 'STELLAR_RPC_MAX_RETRIES',
    dependency: 'stellar-rpc',
    unit: 'requests',
    description: 'Retries for a failed Stellar RPC call (src/services/stellar-rpc.ts).',
  },
  {
    envVar: 'STELLAR_RPC_RETRY_DELAY',
    dependency: 'stellar-rpc',
    unit: 'ms',
    description: 'Base delay between Stellar RPC retries (src/services/stellar-rpc.ts).',
  },
  {
    envVar: 'RPC_TIMEOUT_MS',
    dependency: 'stellar-rpc',
    unit: 'ms',
    description: 'Per-call timeout for the Stellar RPC service (src/services/stellar-rpc.ts).',
  },
  {
    envVar: 'RPC_CB_FAILURE_THRESHOLD',
    dependency: 'stellar-rpc',
    unit: 'failures',
    description: 'Consecutive RPC failures that trip the circuit breaker (src/services/stellar-rpc.ts).',
  },
  {
    envVar: 'RPC_CB_WINDOW_MS',
    dependency: 'stellar-rpc',
    unit: 'ms',
    description: 'Window over which RPC failures are counted (src/services/stellar-rpc.ts).',
  },
  {
    envVar: 'RPC_CB_RESET_TIMEOUT_MS',
    dependency: 'stellar-rpc',
    unit: 'ms',
    description: 'Time the RPC circuit breaker stays open before probing (src/services/stellar-rpc.ts).',
  },
];

/**
 * Resolve a limit from the environment, falling back to the value declared in
 * {@link CONNECTION_LIMIT_DEFAULTS}.
 *
 * `EnvSchema` validates the value at startup; this helper exists so the runtime
 * modules read the same env var the schema documents without duplicating the
 * default in a second literal.
 */
export function resolveConnectionLimit(name: ConnectionLimitKey): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return CONNECTION_LIMIT_DEFAULTS[name];
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : CONNECTION_LIMIT_DEFAULTS[name];
}

/**
 * Worst-case number of pooled database connections a single backend instance
 * can hold: the primary pool plus the read replica pool (created only when
 * `DATABASE_REPLICA_URL` is set).
 *
 * Redis clients are single multiplexed sockets rather than pools, and the RPC
 * endpoint is reached over short-lived HTTP requests guarded by
 * `RPC_TIMEOUT_MS`, so neither contributes a pooled connection count.
 */
export function worstCaseDatabaseConnections(
  maxPerPool: number = CONNECTION_LIMIT_DEFAULTS.DB_POOL_MAX,
): number {
  return maxPerPool * 2;
}
