import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('streams', {
    id: { type: 'text', primaryKey: true },
    sender_address: { type: 'text', notNull: true },
    recipient_address: { type: 'text', notNull: true },
    amount: { type: 'text', notNull: true },
    streamed_amount: { type: 'text', notNull: true, default: '0' },
    remaining_amount: { type: 'text', notNull: true },
    rate_per_second: { type: 'text', notNull: true },
    start_time: { type: 'bigint', notNull: true },
    end_time: { type: 'bigint', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'active' },
    contract_id: { type: 'text', notNull: true },
    transaction_hash: { type: 'text', notNull: true },
    event_index: { type: 'integer', notNull: true },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Unique constraint for idempotency
  pgm.addConstraint('streams', 'idx_streams_unique_event', {
    unique: ['transaction_hash', 'event_index'],
  });

  // Indexes for common query patterns
  pgm.createIndex('streams', 'status');
  pgm.createIndex('streams', 'sender_address');
  pgm.createIndex('streams', 'recipient_address');
  pgm.createIndex('streams', 'contract_id');
  pgm.createIndex('streams', 'created_at');

  // Contract events table for the indexer service. Keep this in sync with
  // migrations/000_initial_schema.ts: the table is partitioned by ledger and
  // includes nullable columns for both legacy replay rows and typed indexer rows.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS contract_events (
      event_id VARCHAR(255) NOT NULL,
      contract_id VARCHAR(255) NOT NULL,
      ledger INTEGER NOT NULL CHECK (ledger >= 0),
      event_type VARCHAR(100),
      event_data JSONB,
      block_height BIGINT,
      transaction_hash VARCHAR(255),
      topic TEXT,
      tx_hash TEXT,
      tx_index INTEGER,
      operation_index INTEGER,
      event_index INTEGER,
      payload JSONB,
      happened_at TIMESTAMPTZ,
      ledger_hash TEXT,
      ingested_at TIMESTAMPTZ,
      ingestion_state TEXT GENERATED ALWAYS AS (
        CASE WHEN ingested_at IS NULL THEN 'pending' ELSE 'ingested' END
      ) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (ledger, event_id)
    ) PARTITION BY RANGE (ledger);

    CREATE TABLE IF NOT EXISTS contract_events_default
      PARTITION OF contract_events DEFAULT;

    CREATE INDEX IF NOT EXISTS idx_contract_events_contract_id
      ON contract_events (contract_id);
    CREATE INDEX IF NOT EXISTS idx_contract_events_tx_hash
      ON contract_events (tx_hash);
    CREATE INDEX IF NOT EXISTS idx_contract_events_happened_at
      ON contract_events (happened_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE IF EXISTS contract_events CASCADE;');
  pgm.dropTable('streams');
}
