
import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('dead_letter_queue', {
    status: {
      type: 'text',
      notNull: true,
      default: 'dead',
      check: "status IN ('dead', 'replayed')",
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('dead_letter_queue', 'status');
}
