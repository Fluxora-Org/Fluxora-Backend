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

  // Contract events table for the indexer service
  pgm.createTable('contract_events', {
    event_id: { type: 'text', primaryKey: true },
    ledger: { type: 'integer', notNull: true },
    contract_id: { type: 'text', notNull: true },
    topic: { type: 'text', notNull: true },
    tx_hash: { type: 'text', notNull: true },
    tx_index: { type: 'integer', notNull: true },
    operation_index: { type: 'integer', notNull: true },
    event_index: { type: 'integer', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    happened_at: { type: 'timestamp with time zone', notNull: true },
    ingested_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('contract_events', 'contract_id');
  pgm.createIndex('contract_events', 'tx_hash');
  pgm.createIndex('contract_events', 'happened_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('contract_events');
  pgm.dropTable('streams');
}
