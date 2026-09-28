/**
 * Forward migration: add ledger_hash to contract_events.
 *
 * Why: store.ts INSERT, getLedgerHash (reorg lookup), and getEvents (replay
 * projection) all reference this column.  Databases deployed before this
 * migration existed will fail with "column does not exist" on every indexer
 * write or read.
 *
 * Column type: TEXT — matches the string values written by store.ts and the
 * SHA-256 hex strings produced by Stellar ledger headers.
 *
 * Nullable: yes — allows rows inserted by legacy code (before this migration)
 * to remain valid without a backfill.  getLedgerHash already handles a NULL
 * return gracefully by returning null to the caller.
 *
 * Security: ledger_hash is a chain-derived opaque hash string. It does not
 * contain PII and cannot be used to bypass the event_id uniqueness constraint.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Add ledger_hash (TEXT, nullable) to contract_events. */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // The initial-schema migration already creates this column on fresh
  // databases, so the forward migration must be safe when both run in order.
  pgm.sql('ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS ledger_hash TEXT');
}

/** Remove the ledger_hash column — reverses the up() migration. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('ALTER TABLE contract_events DROP COLUMN IF EXISTS ledger_hash');
}
