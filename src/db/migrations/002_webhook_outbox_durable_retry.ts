/**
 * Migration: Add durable retry columns to webhook_outbox
 * Adds next_attempt_at and attempt_count so retry state survives restarts.
 */

export const up = `
ALTER TABLE webhook_outbox
  ADD COLUMN IF NOT EXISTS attempt_count   INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_next_attempt_at
  ON webhook_outbox (next_attempt_at)
  WHERE processed = false;
`;

export const down = `
DROP INDEX IF EXISTS idx_webhook_outbox_next_attempt_at;
ALTER TABLE webhook_outbox
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS attempt_count;
`;
