/**
 * Migration: Add CHECK constraint ensuring streams.event_index >= 0.
 *
 * event_index represents the position of an event within a transaction,
 * which is always non-negative. This constraint enforces that invariant
 * at the database layer.
 *
 * MIGRATION: 006_streams_event_index_check
 *
 * @module db/migrations/006_streams_event_index_check
 */

export const up = `
ALTER TABLE streams
  ADD CONSTRAINT chk_streams_event_index_non_negative
  CHECK (event_index >= 0);
`;

export const down = `
ALTER TABLE streams
  DROP CONSTRAINT IF EXISTS chk_streams_event_index_non_negative;
`;
