import { PoolClient } from 'pg';

/**
 * Migration: Add indexes for optimized contract event replay
 * 
 * Indexes created:
 * 1. Composite index on (contract_id, ledger) - speeds up replay queries filtering by these columns
 * 2. Partial index on (contract_id, ledger) WHERE ingested_at IS NULL - optimizes queries for unprocessed events
 * 
 * These indexes significantly improve replay performance by:
 * - Reducing table scan time for contract_id + ledger lookups
 * - Enabling efficient identification of events pending ingestion
 * - Supporting the ORDER BY block_height, event_id pattern used in batched fetches
 */

export async function up(client: PoolClient): Promise<void> {
  console.log('Creating contract_events replay indexes...');

  // Composite index for general replay queries
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_contract_ledger
    ON contract_events (contract_id, ledger, block_height, event_id);
  `);

  // Partial index for unprocessed events (ingested_at IS NULL)
  // This is useful for tracking replay progress and identifying incomplete ingestions
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_pending_ingestion
    ON contract_events (contract_id, ledger, block_height)
    WHERE ingested_at IS NULL;
  `);

  // Index on historical_events for efficient batch fetching during replay
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_historical_events_replay
    ON historical_events (contract_id, ledger, block_height, event_id);
  `);

  console.log('Indexes created successfully');
}

export async function down(client: PoolClient): Promise<void> {
  console.log('Dropping contract_events replay indexes...');

  await client.query(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_contract_events_contract_ledger;
  `);

  await client.query(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_contract_events_pending_ingestion;
  `);

  await client.query(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_historical_events_replay;
  `);

  console.log('Indexes dropped successfully');
}
