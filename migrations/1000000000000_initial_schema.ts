/**
 * Migration: Initial schema — historical_events and contract_events tables.
 *
 * Previously used a hand-rolled PoolClient runner (migrations/run.ts).
 * Converted to the node-pg-migrate MigrationBuilder convention so all
 * migrations share a single runner and the pgmigrations ledger.
 *
 * Note on contract_events: this table is also referenced by
 * 1774715131962_streams-table.ts which adds a different column set for the
 * streams/indexer service. The definition here covers the original replay
 * columns (event_type, event_data, block_height, etc.); the later migration
 * extends it. Both target the same table name via IF NOT EXISTS guards.
 *
 * Ordering convention: numeric timestamp prefix (Unix-ms epoch or a fixed
 * integer < real timestamps) guarantees this file sorts before the
 * 1774715131962_streams-table.ts migration.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Create the historical_events source table and the contract_events replay
 * destination table used by the indexer replay service.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Source data table — events fetched from chain history
  pgm.createTable(
    'historical_events',
    {
      event_id:         { type: 'text',      primaryKey: true },
      contract_id:      { type: 'text',      notNull: true },
      ledger:           { type: 'integer',   notNull: true },
      event_type:       { type: 'text',      notNull: true },
      event_data:       { type: 'jsonb',     notNull: true },
      block_height:     { type: 'bigint',    notNull: true },
      transaction_hash: { type: 'text',      notNull: true },
      created_at:       { type: 'timestamp', default: pgm.func('current_timestamp') },
    },
    { ifNotExists: true },
  );

  // Replay destination table — events written by the indexer replay service.
  // A richer schema (topic, tx_hash, payload, ledger_hash, etc.) is layered on
  // by 1774715131962_streams-table.ts which runs afterward.
  // ledger_hash is nullable here so legacy rows without it remain valid; the
  // forward migration 20260624000000_add_ledger_hash.ts backfills deployed DBs.
  pgm.createTable(
    'contract_events',
    {
      event_id:         { type: 'text',      primaryKey: true },
      contract_id:      { type: 'text',      notNull: true },
      ledger:           { type: 'integer',   notNull: true },
      event_type:       { type: 'text',      notNull: true },
      event_data:       { type: 'jsonb',     notNull: true },
      block_height:     { type: 'bigint',    notNull: true },
      transaction_hash: { type: 'text',      notNull: true },
      // Hash of the Stellar ledger header; used for reorg detection.
      ledger_hash:      { type: 'text',      notNull: false },
      ingested_at:      { type: 'timestamp' },
      created_at:       { type: 'timestamp', default: pgm.func('current_timestamp') },
    },
    { ifNotExists: true },
  );
}

/**
 * Drop both tables in reverse dependency order.
 *
 * ⚠️  Not executed in automated production scripts — destructive DDL must be
 * reviewed manually before use.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('contract_events',  { ifExists: true, cascade: true });
  pgm.dropTable('historical_events', { ifExists: true, cascade: true });
}
