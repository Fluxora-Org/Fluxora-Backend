import { MigrationBuilder } from 'node-pg-migrate';

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

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.createIndex('contract_events', ['contract_id', 'ledger', 'block_height', 'event_id'], {
    name: 'idx_contract_events_contract_ledger',
    concurrently: true,
    ifNotExists: true,
  });

  pgm.createIndex('contract_events', ['contract_id', 'ledger', 'block_height'], {
    name: 'idx_contract_events_pending_ingestion',
    concurrently: true,
    ifNotExists: true,
    where: 'ingested_at IS NULL',
  });

  pgm.createIndex('historical_events', ['contract_id', 'ledger', 'block_height', 'event_id'], {
    name: 'idx_historical_events_replay',
    concurrently: true,
    ifNotExists: true,
  });
}

/**
 * Drop replay indexes outside a transaction to match their concurrent create.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.dropIndex('contract_events', ['contract_id', 'ledger', 'block_height', 'event_id'], {
    name: 'idx_contract_events_contract_ledger',
    concurrently: true,
    ifExists: true,
  });

  pgm.dropIndex('contract_events', ['contract_id', 'ledger', 'block_height'], {
    name: 'idx_contract_events_pending_ingestion',
    concurrently: true,
    ifExists: true,
  });

  pgm.dropIndex('historical_events', ['contract_id', 'ledger', 'block_height', 'event_id'], {
    name: 'idx_historical_events_replay',
    concurrently: true,
    ifExists: true,
  });
}
