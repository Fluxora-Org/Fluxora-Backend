import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('dead_letter_queue', { tenant_id: { type: 'text', notNull: false } });
  pgm.createIndex('dead_letter_queue', ['tenant_id', 'last_failed_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('dead_letter_queue', ['tenant_id', 'last_failed_at']);
  pgm.dropColumn('dead_letter_queue', 'tenant_id');
}
