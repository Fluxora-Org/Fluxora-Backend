import { MigrationBuilder } from 'node-pg-migrate';

/**
 * Create the source and replay tables used by the contract event indexer.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('historical_events', {
    event_id: { type: 'varchar(255)', primaryKey: true },
    contract_id: { type: 'varchar(255)', notNull: true },
    ledger: { type: 'integer', notNull: true },
    event_type: { type: 'varchar(100)', notNull: true },
    event_data: { type: 'jsonb', notNull: true },
    block_height: { type: 'bigint', notNull: true },
    transaction_hash: { type: 'varchar(255)', notNull: true },
    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') },
  }, { ifNotExists: true });

  pgm.createTable('contract_events', {
    event_id: { type: 'varchar(255)', primaryKey: true },
    contract_id: { type: 'varchar(255)', notNull: true },
    ledger: { type: 'integer', notNull: true },
    event_type: { type: 'varchar(100)' },
    event_data: { type: 'jsonb' },
    block_height: { type: 'bigint' },
    transaction_hash: { type: 'varchar(255)' },
    topic: { type: 'text' },
    tx_hash: { type: 'text' },
    tx_index: { type: 'integer' },
    operation_index: { type: 'integer' },
    event_index: { type: 'integer' },
    payload: { type: 'jsonb' },
    happened_at: { type: 'timestamp with time zone' },
    ledger_hash: { type: 'text' },
    ingested_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') },
  }, { ifNotExists: true });

  pgm.addColumns(
    'contract_events',
    {
      event_type: { type: 'varchar(100)' },
      event_data: { type: 'jsonb' },
      block_height: { type: 'bigint' },
      transaction_hash: { type: 'varchar(255)' },
      topic: { type: 'text' },
      tx_hash: { type: 'text' },
      tx_index: { type: 'integer' },
      operation_index: { type: 'integer' },
      event_index: { type: 'integer' },
      payload: { type: 'jsonb' },
      happened_at: { type: 'timestamp with time zone' },
      ledger_hash: { type: 'text' },
      ingested_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
      created_at: { type: 'timestamp', default: pgm.func('current_timestamp') },
    },
    { ifNotExists: true },
  );

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'contract_events_shape_check'
          AND conrelid = 'contract_events'::regclass
      ) THEN
        ALTER TABLE contract_events
          ADD CONSTRAINT contract_events_shape_check
          CHECK (
            (
              event_type IS NOT NULL
              AND event_data IS NOT NULL
              AND block_height IS NOT NULL
              AND transaction_hash IS NOT NULL
            )
            OR
            (
              topic IS NOT NULL
              AND tx_hash IS NOT NULL
              AND tx_index IS NOT NULL
              AND operation_index IS NOT NULL
              AND event_index IS NOT NULL
              AND payload IS NOT NULL
              AND happened_at IS NOT NULL
            )
          );
      END IF;
    END $$;
  `);
}

/**
 * Drop the indexer replay tables created by this migration.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('contract_events', 'contract_events_shape_check', { ifExists: true });
  pgm.dropTable('contract_events', { ifExists: true });
  pgm.dropTable('historical_events', { ifExists: true });
}
