/**
 * Migration: dead_letter_queue.failure_history — per-item failure history.
 *
 * A dead-lettered item is only actionable if it records *why* it failed. The
 * table carried a single `error` column, so a later attempt's cause could
 * replace the original one and the failure worth diagnosing was lost.
 *
 * `failure_history` is an append-only JSONB array of attempt records:
 *
 *   [{ "error": "...", "attempt": 3, "failedAt": "2026-01-01T00:00:00.000Z",
 *      "source": "replay" }]
 *
 * Semantics:
 *   - `error` (the legacy column) keeps the FIRST failure cause and is never
 *     rewritten afterwards, so existing readers stay correct.
 *   - Every subsequent attempt failure is appended to `failure_history`
 *     (`|| jsonb_build_array(...)`), never substituted.
 *   - `attempt` is the entry's attempt counter at the time of the failure and
 *     `failedAt` is when it happened, so ordering and counts are recoverable.
 *
 * Additive only: a new NOT NULL column with a default, plus a CHECK that keeps
 * the value an array. Rows written by an older version during a blue/green
 * cutover still satisfy the default, so both versions can run concurrently.
 */
import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('dead_letter_queue', {
    failure_history: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
      check: "jsonb_typeof(failure_history) = 'array'",
    },
  });

  // Backfill: seed the history of pre-existing rows with the cause they
  // already carry, so the first failure is not missing from the history of
  // items that were dead-lettered before this migration. One UPDATE inside the
  // migration transaction, over a table that retention purges;
  // `first_failed_at` is the best available timestamp for a legacy cause.
  pgm.sql(`
    UPDATE dead_letter_queue
       SET failure_history = jsonb_build_array(
             jsonb_build_object(
               'error',    error,
               'attempt',  GREATEST(attempts, 1),
               'failedAt', to_jsonb(first_failed_at),
               'source',   'legacy-backfill'
             )
           )
     WHERE error IS NOT NULL
       AND failure_history = '[]'::jsonb
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('dead_letter_queue', 'failure_history');
}
