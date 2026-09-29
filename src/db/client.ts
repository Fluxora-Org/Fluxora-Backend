import { Pool, PoolClient } from 'pg';
import { createPool, query as poolQuery } from './pool.js';

/**
 * PostgreSQL connection pool for the indexer database.
 *
 * This client wraps the centralized pool infrastructure from `src/db/pool.ts`,
 * ensuring that every query benefits from:
 *  - Statement timeout enforcement (queries exceeding STATEMENT_TIMEOUT_MS are
 *    automatically cancelled by PostgreSQL with error code 57014)
 *  - Pool exhaustion detection (requests are fast-failed with PoolExhaustedError
 *    when the queue limit is reached)
 *  - Error classification (timeout → QueryTimeoutError, unique violation →
 *    DuplicateEntryError, pool exhaustion → PoolExhaustedError)
 *  - Observability (slow-query logging, Prometheus metrics for timeouts,
 *    exhaustion, and query errors)
 *
 * Without this wrapper, callers bypass all timeout enforcement and metrics.
 */
export class DatabaseClient {
  private pool: Pool;

  constructor() {
    this.pool = createPool();
  }

  /**
   * Get a client from the pool.
   *
   * The returned `PoolClient` must be explicitly released after use.
   * Prefer using `query()` for one-off queries to avoid connection leaks.
   */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Execute a query with timeout enforcement, error classification, and metrics.
   *
   * - Queries exceeding STATEMENT_TIMEOUT_MS are cancelled automatically and
   *   throw `QueryTimeoutError`.
   * - Pool exhaustion (waiting queue ≥ POOL_QUEUE_LIMIT) throws `PoolExhaustedError`.
   * - Unique constraint violations throw `DuplicateEntryError`.
   * - Slow queries (≥ SLOW_QUERY_THRESHOLD_MS) are logged and counted.
   * - All query failures increment `dbQueryErrorsTotal` with a bounded error_type label.
   *
   * @param text SQL query string
   * @param params Query parameters (parameterized queries prevent SQL injection)
   * @returns Query result with rows, rowCount, etc.
   * @throws {QueryTimeoutError} When the query exceeds statement_timeout (PG 57014)
   * @throws {PoolExhaustedError} When the pool queue limit is reached
   * @throws {DuplicateEntryError} On unique constraint violations (PG 23505)
   */
  async query(text: string, params?: any[]) {
    return poolQuery(this.pool, text, params);
  }

  /**
   * Close the pool and release all connections.
   *
   * This should only be called during graceful shutdown. Once closed, the pool
   * cannot be reused.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const db = new DatabaseClient();
 