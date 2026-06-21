import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('webhook_outbox', {
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamp with time zone' },
  });

  pgm.sql(`
    UPDATE webhook_outbox
    SET next_attempt_at = created_at
    WHERE next_attempt_at IS NULL
  `);

  pgm.alterColumn('webhook_outbox', 'next_attempt_at', {
    default: pgm.func('current_timestamp'),
  });

  pgm.createIndex(
    'webhook_outbox',
    ['processed', 'next_attempt_at', 'created_at'],
    {
      name: 'idx_webhook_outbox_ready_retry',
      where: 'processed = false',
    },
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('webhook_outbox', ['processed', 'next_attempt_at', 'created_at'], {
    name: 'idx_webhook_outbox_ready_retry',
    ifExists: true,
  });
  pgm.dropColumns('webhook_outbox', ['next_attempt_at', 'attempt_count']);
}
