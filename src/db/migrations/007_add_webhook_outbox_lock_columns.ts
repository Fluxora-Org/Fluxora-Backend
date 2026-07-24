/**
 * Migration: Add status/lock columns to webhook_outbox for atomic claim-and-dispatch
 *
 * The outbox poller in src/webhooks/store.ts uses an atomic claim pattern to
 * prevent duplicate delivery when multiple workers poll the same table.
 * The new columns support:
 *   - status:   'pending' | 'in_flight' | 'delivered' | 'failed'
 *   - locked_at: timestamp when a worker claimed the row
 *   - locked_by: opaque worker identifier for debugging / stuck-row recovery
 *
 * Existing rows are backfilled from the legacy `processed` boolean.
 *
 * MIGRATION: 007_add_webhook_outbox_lock_columns
 *
 * @module db/migrations/007_add_webhook_outbox_lock_columns
 */

export const up = `
-- Add status column (TEXT for extensibility)
ALTER TABLE webhook_outbox
  ADD COLUMN IF NOT EXISTS status    TEXT NOT NULL DEFAULT 'pending';

-- Add lock-tracking columns
ALTER TABLE webhook_outbox
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

-- Backfill status from the legacy processed boolean.
-- Only touch rows that still have the default so manual overrides are preserved.
UPDATE webhook_outbox
  SET status = 'delivered'
  WHERE processed = true AND status = 'pending';

-- Partial index for reclaiming stuck in-flight rows
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_in_flight
  ON webhook_outbox (locked_at)
  WHERE status = 'in_flight';
`;

export const down = `
DROP INDEX IF EXISTS idx_webhook_outbox_in_flight;

ALTER TABLE webhook_outbox
  DROP COLUMN IF EXISTS locked_by,
  DROP COLUMN IF EXISTS locked_at;

ALTER TABLE webhook_outbox
  DROP COLUMN IF EXISTS status;
`;
