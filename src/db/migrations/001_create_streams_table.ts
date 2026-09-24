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
 * - Composite indexes align with streamRepository filter+order patterns (see below)
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

-- Cursor pagination (findWithCursor): filter + ORDER BY id ASC
CREATE INDEX IF NOT EXISTS idx_streams_status_id              ON streams (status, id);
CREATE INDEX IF NOT EXISTS idx_streams_sender_id                ON streams (sender_address, id);
CREATE INDEX IF NOT EXISTS idx_streams_contract_id              ON streams (contract_id, id);

-- Offset pagination (find): status filter + ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_streams_status_created_at_desc   ON streams (status, created_at DESC, id DESC);

-- Standalone indexes for patterns not covered by composites above
CREATE INDEX IF NOT EXISTS idx_streams_recipient   ON streams (recipient_address);
CREATE INDEX IF NOT EXISTS idx_streams_created_at  ON streams (created_at);
CREATE INDEX IF NOT EXISTS idx_streams_start_time  ON streams (start_time);
CREATE INDEX IF NOT EXISTS idx_streams_end_time    ON streams (end_time);
`;

export const down = `
DROP TABLE IF EXISTS streams;
`;
