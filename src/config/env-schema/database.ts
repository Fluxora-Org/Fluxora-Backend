/**
 * Database (PostgreSQL) environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect. Numeric defaults are sourced
 * from `CONNECTION_LIMIT_DEFAULTS` (see `src/config/connectionLimits.ts`) so
 * the schema and the documented connection-limit contract cannot drift.
 */
import { integerEnv, optionalUrlString, urlString } from './parsers.js';
import { CONNECTION_LIMIT_DEFAULTS as LIMITS } from '../connectionLimits.js';

export const databaseEnvSchema = {
  /** Primary PostgreSQL connection string. Required — no default. */
  DATABASE_URL: urlString('DATABASE_URL'),
  /**
   * Optional read-replica connection string. When set, SELECT queries on
   * streams are routed through a dedicated replica pool.
   * @default unset (all queries use the primary pool)
   */
  DATABASE_REPLICA_URL: optionalUrlString('DATABASE_REPLICA_URL'),
  /** Minimum primary-pool connections. @default 2 */
  DB_POOL_MIN: integerEnv('DB_POOL_MIN', 1, 100).default(LIMITS.DB_POOL_MIN),
  /** Maximum primary-pool connections. @default 10 */
  DB_POOL_MAX: integerEnv('DB_POOL_MAX', 1, 100).default(LIMITS.DB_POOL_MAX),
  /** New connection acquisition timeout in ms. @default 5000 */
  DB_CONNECTION_TIMEOUT: integerEnv('DB_CONNECTION_TIMEOUT', 1000, 60000).default(
    LIMITS.DB_CONNECTION_TIMEOUT
  ),
  /** Idle client release timeout in ms. @default 30000 */
  DB_IDLE_TIMEOUT: integerEnv('DB_IDLE_TIMEOUT', 1000, 600000).default(LIMITS.DB_IDLE_TIMEOUT),
  /** Queries slower than this are logged as slow. @default 1000 */
  SLOW_QUERY_THRESHOLD_MS: integerEnv('SLOW_QUERY_THRESHOLD_MS', 0).default(1000),
  /** statement_timeout for primary connections in ms; 0 disables. @default 5000 */
  STATEMENT_TIMEOUT_MS: integerEnv('STATEMENT_TIMEOUT_MS', 0).default(
    LIMITS.STATEMENT_TIMEOUT_MS
  ),
  /** Max requests allowed to queue on the primary pool before fast-failing with 503. @default 50 */
  POOL_QUEUE_LIMIT: integerEnv('POOL_QUEUE_LIMIT', 1).default(LIMITS.POOL_QUEUE_LIMIT),
  /** Replica statement timeout in ms. Defaults to STATEMENT_TIMEOUT_MS when absent. 0 = disabled. */
  REPLICA_STATEMENT_TIMEOUT_MS: integerEnv('REPLICA_STATEMENT_TIMEOUT_MS', 0).optional(),
  /** Max requests allowed to queue on the replica pool before fast-failing. @default 25 */
  REPLICA_QUEUE_LIMIT: integerEnv('REPLICA_QUEUE_LIMIT', 1).default(LIMITS.REPLICA_QUEUE_LIMIT),
};
