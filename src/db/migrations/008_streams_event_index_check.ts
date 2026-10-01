/**
 * Migration: Add CHECK constraint ensuring streams.event_index >= 0.
 *
 * event_index represents the position of an event within a transaction,
 * which is always non-negative. This constraint enforces that invariant
 * at the database layer.
 *
 * MIGRATION: 008_streams_event_index_check
 *
 * This migration was originally numbered `006` and shared its ordinal with
 * `006_add_webhook_outbox_dispatch_index`, which made the applied order depend
 * on filename sorting rather than on intent (#1485). It now sits after
 * `007_add_webhook_outbox_lock_columns`; both migrations touch different
 * tables, so the relative order of the two is immaterial.
 *
 * `up` is idempotent: an environment that already carries the constraint
 * (because it applied the migration under its old name) is left untouched
 * instead of failing on a duplicate constraint, so the renumbering never
 * requires re-running DDL against a live database.
 *
 * @module db/migrations/008_streams_event_index_check
 */

export const CONSTRAINT_NAME = 'chk_streams_event_index_non_negative';

export const up = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = '${CONSTRAINT_NAME}'
      AND conrelid = 'streams'::regclass
  ) THEN
    ALTER TABLE streams
      ADD CONSTRAINT ${CONSTRAINT_NAME}
      CHECK (event_index >= 0);
  END IF;
END
$$;
`;

export const down = `
ALTER TABLE streams
  DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};
`;
