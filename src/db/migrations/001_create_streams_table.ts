/**
 * Database migration: Create streams table (PostgreSQL)
 *
 * Creates the streams table that maps on-chain streaming events to the database
 * with proper indexing for efficient querying and idempotency guarantees.
 *
 * MIGRATION: 001_create_streams_table
 *
 * @module db/migrations/001_create_streams_table
 */

/**
 * SQL to create the streams table and its indexes.
 *
 * Design decisions:
 * - id: TEXT primary key derived from transaction_hash + event_index (deterministic)
 * - All monetary amounts stored as TEXT (decimal strings) — never NUMERIC/FLOAT
 * - CHECK constraints enforce decimal-string format at the DB layer
 * - UNIQUE constraint on (transaction_hash, event_index) for idempotent ingestion
 * - Indexes cover all common filter/sort patterns
 */
export const up = `
CREATE TABLE IF NOT EXISTS streams (
  id                TEXT        PRIMARY KEY,

  sender_address    TEXT        NOT NULL,
  recipient_address TEXT        NOT NULL,

  amount            TEXT        NOT NULL
    CHECK (amount            ~ '^[+-]?[0-9]+(\\.[0-9]+)?$'),
  streamed_amount   TEXT        NOT NULL DEFAULT '0'
    CHECK (streamed_amount   ~ '^[+-]?[0-9]+(\\.[0-9]+)?$'),
  remaining_amount  TEXT        NOT NULL
    CHECK (remaining_amount  ~ '^[+-]?[0-9]+(\\.[0-9]+)?$'),
  rate_per_second   TEXT        NOT NULL
    CHECK (rate_per_second   ~ '^[+-]?[0-9]+(\\.[0-9]+)?$'),

  start_time        BIGINT      NOT NULL CHECK (start_time >= 0),
  end_time          BIGINT      NOT NULL DEFAULT 0 CHECK (end_time >= 0),

  status            TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),

  contract_id       TEXT        NOT NULL,
  transaction_hash  TEXT        NOT NULL,
  event_index       INTEGER     NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT streams_unique_event UNIQUE (transaction_hash, event_index)
);

CREATE INDEX IF NOT EXISTS idx_streams_status      ON streams (status);
CREATE INDEX IF NOT EXISTS idx_streams_sender      ON streams (sender_address);
CREATE INDEX IF NOT EXISTS idx_streams_recipient   ON streams (recipient_address);
CREATE INDEX IF NOT EXISTS idx_streams_contract    ON streams (contract_id);
CREATE INDEX IF NOT EXISTS idx_streams_created_at  ON streams (created_at);
CREATE INDEX IF NOT EXISTS idx_streams_start_time  ON streams (start_time);
CREATE INDEX IF NOT EXISTS idx_streams_end_time    ON streams (end_time);
`;

/**
 * Audit log table — stores immutable records of privileged state changes.
 * Written atomically with stream operations via transactionalUpsertStream /
 * transactionalUpdateStream so audit rows are always in sync with stream rows.
 */
export const upAuditLogs = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  seq            INTEGER NOT NULL,
  timestamp      TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  resource_type  TEXT    NOT NULL,
  resource_id    TEXT    NOT NULL,
  correlation_id TEXT,
  meta           TEXT    -- JSON string or NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_id  ON audit_logs(resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action       ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp    ON audit_logs(timestamp);
`;

/**
 * Webhook outbox table — transactional outbox pattern.
 * A row is inserted here atomically with the stream write so the webhook
 * dispatcher can pick it up without risk of the stream being written but
 * the webhook being lost (or vice-versa).
 */
export const upWebhookOutbox = `
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id  TEXT    NOT NULL,
  event_type TEXT    NOT NULL,
  payload    TEXT    NOT NULL, -- JSON string; amounts are decimal strings
  created_at TEXT    NOT NULL,
  processed  INTEGER NOT NULL DEFAULT 0 -- 0 = pending, 1 = dispatched
);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_stream_id  ON webhook_outbox(stream_id);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_processed  ON webhook_outbox(processed);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_created_at ON webhook_outbox(created_at);
`;

export const down = `
DROP TABLE IF EXISTS webhook_outbox;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS streams;
`;
