/**
 * Database migration: Create streams table
 *
 * This migration creates the streams table that maps on-chain streaming events
 * to the database with proper indexing for efficient querying.
 *
 * MIGRATION: 001_create_streams_table
 * APPLIED_AT: Will be set by migration runner
 *
 * @module db/migrations/001_create_streams_table
 */

export const up = `
/**
 * Streams table - maps on-chain streaming contract events
 * 
 * Indexes:
 * - idx_streams_status: For filtering by status
 * - idx_streams_sender: For sender lookups
 * - idx_streams_recipient: For recipient lookups
 * - idx_streams_contract: For contract-scoped queries
 * - idx_streams_created_at: For time-based queries
 * - idx_streams_id: For unique ID lookups (primary key)
 * - idx_streams_tx_hash_event: For idempotency checks
 */
CREATE TABLE IF NOT EXISTS streams (
  -- Primary identifier derived from transaction hash + event index
  id TEXT PRIMARY KEY,
  
  -- Account addresses (Stellar addresses - base32 encoded)
  sender_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  
  -- Monetary amounts as decimal strings (never floating point)
  amount TEXT NOT NULL CHECK (amount ~ '^[+-]?\\d+(\\.\\d+)?$'),
  streamed_amount TEXT NOT NULL DEFAULT '0' CHECK (streamed_amount ~ '^[+-]?\\d+(\\.\\d+)?$'),
  remaining_amount TEXT NOT NULL CHECK (remaining_amount ~ '^[+-]?\\d+(\\.\\d+)?$'),
  rate_per_second TEXT NOT NULL CHECK (rate_per_second ~ '^[+-]?\\d+(\\.\\d+)?$'),
  
  -- Timestamps (Unix epoch seconds)
  start_time INTEGER NOT NULL CHECK (start_time >= 0),
  end_time INTEGER NOT NULL DEFAULT 0 CHECK (end_time >= 0),
  
  -- Status (state machine: active -> paused/completed/cancelled)
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'completed', 'cancelled')
  ),
  
  -- Contract and event metadata
  contract_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  
  -- Timestamps for audit trail
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Constraints
  CONSTRAINT idx_streams_unique_event UNIQUE (transaction_hash, event_index)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
CREATE INDEX IF NOT EXISTS idx_streams_sender ON streams(sender_address);
CREATE INDEX IF NOT EXISTS idx_streams_recipient ON streams(recipient_address);
CREATE INDEX IF NOT EXISTS idx_streams_contract ON streams(contract_id);
CREATE INDEX IF NOT EXISTS idx_streams_created_at ON streams(created_at);
CREATE INDEX IF NOT EXISTS idx_streams_start_time ON streams(start_time);
CREATE INDEX IF NOT EXISTS idx_streams_end_time ON streams(end_time);
`;

export const down = `
DROP TABLE IF EXISTS streams;
`;
