import { Pool, PoolClient } from 'pg';
import { config } from '../config';

/**
 * PostgreSQL connection pool for the indexer database
 */
export class DatabaseClient {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }

  /**
   * Get a client from the pool
   */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Execute a query directly
   */
  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }

  /**
   * Close the pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const db = new DatabaseClient();
 