/**
 * Migration: Create indexer_replay_progress table
 *
 * MIGRATION: 003_create_indexer_replay_progress
 *
 * @module db/migrations/003_create_indexer_replay_progress
 */

export const up = `
CREATE TABLE IF NOT EXISTS indexer_replay_progress (
  last_committed_cursor UUID PRIMARY KEY REFERENCES replay_cursors(id) ON DELETE CASCADE,
  total                 INTEGER NOT NULL,
  status                TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export const down = `
DROP TABLE IF EXISTS indexer_replay_progress;
`;
