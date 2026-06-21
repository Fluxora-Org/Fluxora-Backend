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

  // contract_events is created by 1774715000000_initial_schema.ts and indexed
  // by 1774715050000_add_contract_events_replay_indexes.ts. This migration only
  // adds the event-store indexes that originally lived next to the duplicate
  // table definition.
  pgm.createIndex('contract_events', 'contract_id', { ifNotExists: true });
  pgm.createIndex('contract_events', 'tx_hash', { ifNotExists: true });
  pgm.createIndex('contract_events', 'happened_at', { ifNotExists: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('contract_events', 'happened_at', { ifExists: true });
  pgm.dropIndex('contract_events', 'tx_hash', { ifExists: true });
  pgm.dropIndex('contract_events', 'contract_id', { ifExists: true });
  pgm.dropTable('streams');
}
