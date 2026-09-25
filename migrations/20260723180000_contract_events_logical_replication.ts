/**
 * Migration: Create PostgreSQL Logical Replication Publication for contract_events.
 *
 * @module migrations/20260723180000_contract_events_logical_replication
 *
 * RATIONALE:
 * Creates a PostgreSQL logical replication publication `fluxora_contract_events_pub`
 * specifically scoped to the `contract_events` table. External streaming consumers
 * can attach logical replication slots (using pgoutput) to tail real-time chain event
 * changes directly at the database level as a push-based alternative to polling
 * `GET /internal/indexer/events`.
 *
 * SECURITY & SCOPING:
 * - Scoped strictly to `contract_events`. Tables containing PII or sensitive data
 *   (e.g., `streams`, `api_keys`) are explicitly excluded from replication.
 * - Scoped strictly to `publish = 'insert'`. Because `contract_events` is an append-only
 *   event table, replicating UPDATEs, DELETEs, or TRUNCATEs is disabled to minimize
 *   WAL footprint and prevent unauthorized state change broadcasts.
 *
 * ROLLBACK:
 * `down()` safely drops `fluxora_contract_events_pub` if it exists.
 */

import type { MigrationBuilder } from 'node-pg-migrate';

/** Publication name for contract_events logical replication */
export const CONTRACT_EVENTS_PUBLICATION_NAME = 'fluxora_contract_events_pub';

/**
 * Forward migration: Create the logical replication publication for contract_events.
 *
 * @param pgm node-pg-migrate MigrationBuilder instance
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = '${CONTRACT_EVENTS_PUBLICATION_NAME}'
      ) THEN
        CREATE PUBLICATION ${CONTRACT_EVENTS_PUBLICATION_NAME}
        FOR TABLE contract_events
        WITH (publish = 'insert');
      END IF;
    END
    $$;
  `);
}

/**
 * Reverse migration: Drop the logical replication publication for contract_events.
 *
 * @param pgm node-pg-migrate MigrationBuilder instance
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP PUBLICATION IF EXISTS ${CONTRACT_EVENTS_PUBLICATION_NAME};`);
}
