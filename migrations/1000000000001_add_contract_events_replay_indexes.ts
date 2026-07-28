/**
 * Migration: Indexes for optimised contract-event replay.
 *
 * Previously used a hand-rolled PoolClient runner (migrations/run.ts).
 * Converted to the node-pg-migrate MigrationBuilder convention so all
 * migrations share a single runner and the pgmigrations ledger.
 *
 * Indexes created:
 *  1. idx_contract_events_contract_ledger    — composite (contract_id, ledger,
 *     block_height, event_id); accelerates replay queries that filter on both
 *     columns and sort by position within the ledger.
 *  2. idx_contract_events_pending_ingestion  — partial index on rows where
 *     ingested_at IS NULL; optimises progress queries and resume logic.
 *  3. idx_historical_events_replay           — mirrors the composite index on
 *     historical_events for efficient batch-fetch during replay.
 *
 * All three indexes use CONCURRENTLY (via pgm ifNotExists option) so writes
 * are not blocked on large tables.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Create three replay-optimisation indexes on contract_events and
 * historical_events.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction(); // required for CONCURRENTLY

  // Composite covering index — main replay query path
  pgm.createIndex(
    'contract_events',
    ['contract_id', 'ledger', 'block_height', 'event_id'],
    { name: 'idx_contract_events_contract_ledger', concurrently: true, ifNotExists: true },
  );

  // Partial index — fast lookup of unprocessed events
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_pending_ingestion
      ON contract_events (contract_id, ledger, block_height)
      WHERE ingested_at IS NULL;
  `);

  // Historical events composite index — batch fetch during replay
  pgm.createIndex(
    'historical_events',
    ['contract_id', 'ledger', 'block_height', 'event_id'],
    { name: 'idx_historical_events_replay', concurrently: true, ifNotExists: true },
  );
}

/**
 * Drop the three replay indexes.
 *
 * ⚠️  Not executed in automated production scripts.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.dropIndex('contract_events',  ['contract_id', 'ledger', 'block_height', 'event_id'],
    { name: 'idx_contract_events_contract_ledger',   concurrently: true, ifExists: true });

  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_contract_events_pending_ingestion;`);

  pgm.dropIndex('historical_events', ['contract_id', 'ledger', 'block_height', 'event_id'],
    { name: 'idx_historical_events_replay', concurrently: true, ifExists: true });
}
