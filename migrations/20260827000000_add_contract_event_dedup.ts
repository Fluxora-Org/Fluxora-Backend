/**
 * Give contract event IDs a global uniqueness boundary.
 *
 * `contract_events` is partitioned by happened_at, which means PostgreSQL
 * cannot enforce UNIQUE(event_id) on that table. This small unpartitioned
 * claim table provides the global insert-on-conflict gate used by the indexer.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('contract_event_dedup', {
    event_id: { type: 'text', primaryKey: true },
    happened_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, { ifNotExists: true });

  // Preserve the first canonical occurrence of every event already stored.
  pgm.sql(`
    INSERT INTO contract_event_dedup (event_id, happened_at)
    SELECT event_id, MIN(happened_at)
      FROM contract_events
     GROUP BY event_id
    ON CONFLICT (event_id) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('contract_event_dedup', { ifExists: true });
}
