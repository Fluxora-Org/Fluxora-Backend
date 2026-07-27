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
 * PARTITION AWARENESS:
 * `contract_events` is a range-partitioned table (PARTITION BY RANGE happened_at).
 * Using `FOR TABLE contract_events` (without ONLY) ensures that INSERT changes from
 * all child partitions (e.g., `contract_events_y2026m07`, `contract_events_default`)
 * are published. The WAL decoder reports row identities using the parent table name by
 * default. If consumers need row-level routing keyed by partition, set
 * `publish_via_partition_root = false` on the slot; the default (true since PG15)
 * reports rows under the parent table identity, which simplifies consumer schema
 * management.
 *
 * PREREQUISITES (postgresql.conf):
 * - wal_level = logical         (requires server restart)
 * - max_replication_slots >= 5
 * - max_wal_senders >= 5
 *
 * OPERATIONAL SLOT MANAGEMENT:
 * This migration only creates the PUBLICATION. Attaching a replication slot is an
 * operational step performed by the consumer or an operator:
 *   SELECT pg_create_logical_replication_slot('fluxora_contract_events_slot', 'pgoutput');
 * See docs/database.md § "Logical Replication for contract_events" for the full runbook.
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
