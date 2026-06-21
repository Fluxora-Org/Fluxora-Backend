import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('dlq_consumer_replay_state', {
    consumer_url_hash: { type: 'text', primaryKey: true },
    consumer_url: { type: 'text', notNull: true },
    consecutive_failures: { type: 'integer', notNull: true, default: 0 },
    suspended: { type: 'boolean', notNull: true, default: false },
    suspended_at: { type: 'timestamp with time zone', notNull: false },
    updated_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('dlq_consumer_replay_state', 'suspended');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('dlq_consumer_replay_state');
}
