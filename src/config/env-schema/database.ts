/**
 * Database (PostgreSQL) environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { integerEnv, optionalUrlString, urlString } from './parsers.js';

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
  DB_POOL_MIN: integerEnv('DB_POOL_MIN', 1, 100).default(2),
  /** Maximum primary-pool connections. @default 10 */
  DB_POOL_MAX: integerEnv('DB_POOL_MAX', 1, 100).default(10),
  /** New connection acquisition timeout in ms. @default 5000 */
  DB_CONNECTION_TIMEOUT: integerEnv('DB_CONNECTION_TIMEOUT', 1000, 60000).default(5000),
  /** Idle client release timeout in ms. @default 30000 */
  DB_IDLE_TIMEOUT: integerEnv('DB_IDLE_TIMEOUT', 1000, 600000).default(30000),
  /** Queries slower than this are logged as slow. @default 1000 */
  SLOW_QUERY_THRESHOLD_MS: integerEnv('SLOW_QUERY_THRESHOLD_MS', 0).default(1000),
  /** statement_timeout for primary connections in ms; 0 disables. @default 5000 */
  STATEMENT_TIMEOUT_MS: integerEnv('STATEMENT_TIMEOUT_MS', 0).default(5000),
  /** Replica statement timeout in ms. Defaults to STATEMENT_TIMEOUT_MS when absent. 0 = disabled. */
  REPLICA_STATEMENT_TIMEOUT_MS: integerEnv('REPLICA_STATEMENT_TIMEOUT_MS', 0).optional(),
  /** Max requests allowed to queue on the replica pool before fast-failing. */
  REPLICA_QUEUE_LIMIT: integerEnv('REPLICA_QUEUE_LIMIT', 1).default(25),
};
