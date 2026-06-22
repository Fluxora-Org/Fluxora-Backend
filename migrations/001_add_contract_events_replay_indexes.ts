import type { MigrationBuilder } from 'node-pg-migrate';
import type { PoolClient } from 'pg';

type MigrationTarget = MigrationBuilder | PoolClient;

function isMigrationBuilder(target: MigrationTarget): target is MigrationBuilder {
  return typeof (target as MigrationBuilder).sql === 'function';
}

async function runSql(target: MigrationTarget, sql: string): Promise<void> {
  if (isMigrationBuilder(target)) {
    target.sql(sql);
    return;
  }

  await target.query(sql);
}

function runOutsideTransaction(target: MigrationTarget): void {
  if (isMigrationBuilder(target)) {
    target.noTransaction();
  }
}

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

export async function up(pgm: MigrationTarget): Promise<void> {
  // CREATE INDEX CONCURRENTLY is forbidden inside a PostgreSQL transaction.
  runOutsideTransaction(pgm);

  // Composite index for general replay queries
  await runSql(pgm, `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_contract_ledger
    ON contract_events (contract_id, ledger, block_height, event_id);
  `);

  // Partial index for unprocessed events (ingested_at IS NULL)
  // This is useful for tracking replay progress and identifying incomplete ingestions
  await runSql(pgm, `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_pending_ingestion
    ON contract_events (contract_id, ledger, block_height)
    WHERE ingested_at IS NULL;
  `);

  // Index on historical_events for efficient batch fetching during replay
  await runSql(pgm, `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_historical_events_replay
    ON historical_events (contract_id, ledger, block_height, event_id);
  `);
}

export async function down(pgm: MigrationTarget): Promise<void> {
  // DROP INDEX CONCURRENTLY is forbidden inside a PostgreSQL transaction.
  runOutsideTransaction(pgm);

  await runSql(pgm, `
    DROP INDEX CONCURRENTLY IF EXISTS idx_contract_events_contract_ledger;
  `);

  await runSql(pgm, `
    DROP INDEX CONCURRENTLY IF EXISTS idx_contract_events_pending_ingestion;
  `);

  await runSql(pgm, `
    DROP INDEX CONCURRENTLY IF EXISTS idx_historical_events_replay;
  `);
}
