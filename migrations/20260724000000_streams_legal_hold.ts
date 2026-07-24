/**
 * Migration: add `legal_hold` flag to the `streams` table.
 *
 * When `legal_hold = TRUE` a stream record is exempt from the automatic
 * retention-purge job regardless of its age.  This flag is set manually
 * by an operator (or a future admin API endpoint) when the record is
 * subject to an active legal request, regulatory inquiry, or dispute
 * and must not be modified or deleted until the hold is lifted.
 *
 * Design decisions
 * ─────────────────
 * • Default is FALSE so all existing rows are immediately purgeable once
 *   they exceed their retention window without requiring a backfill.
 * • NOT NULL with DEFAULT FALSE ensures the value is always determinate;
 *   no NULL-check is required in application code.
 * • A partial index on `legal_hold = TRUE` makes listing held records
 *   cheap (the common path has a very small cardinality for held rows).
 * • The column is deliberately narrow (boolean) to avoid schema ambiguity;
 *   richer hold metadata (hold reason, requester, set-at timestamp) should
 *   live in a separate `stream_legal_holds` audit table when needed.
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('streams', {
    legal_hold: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'When TRUE, this stream is exempt from the automatic retention purge job.',
    },
  });

  // Partial index: fast lookup of held streams (expected to be a tiny fraction
  // of total rows, so the index is always dense enough to be useful).
  pgm.createIndex('streams', 'legal_hold', {
    name: 'idx_streams_legal_hold_true',
    where: 'legal_hold = TRUE',
  });

  // Composite index to accelerate the purge job's primary query:
  //   WHERE created_at < $cutoff AND legal_hold = FALSE
  // status is included so rows with terminal statuses can be targeted first.
  pgm.createIndex('streams', ['created_at', 'legal_hold'], {
    name: 'idx_streams_purge_candidates',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('streams', [], { name: 'idx_streams_purge_candidates' });
  pgm.dropIndex('streams', [], { name: 'idx_streams_legal_hold_true' });
  pgm.dropColumn('streams', 'legal_hold');
}
