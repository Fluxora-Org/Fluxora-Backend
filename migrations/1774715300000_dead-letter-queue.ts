import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('dead_letter_queue', {
    id: { type: 'text', primaryKey: true },
    topic: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    error: { type: 'text', notNull: true },
    attempts: { type: 'integer', notNull: true, default: 1 },
    correlation_id: { type: 'text', notNull: false },
    first_failed_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    last_failed_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('dead_letter_queue', 'topic');
  pgm.createIndex('dead_letter_queue', 'first_failed_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('dead_letter_queue');
}
