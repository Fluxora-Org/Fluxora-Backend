import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Repair any existing NULL values in ingested_at
  pgm.sql('UPDATE contract_events SET ingested_at = NOW() WHERE ingested_at IS NULL;');

  // 2. Configure default value and make the column NOT NULL
  pgm.alterColumn('contract_events', 'ingested_at', {
    default: pgm.func('now()'),
    notNull: true,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('contract_events', 'ingested_at', {
    default: null,
    notNull: false,
  });
}
