/**
 * Migration: Add composite index on streams(contract_id, event_index) for contract-scoped event queries.
 *
 * The existing idx_streams_contract_id index covers (contract_id, id) but does not
 * efficiently support ORDER BY event_index queries scoped to a single contract.
 * This migration adds a dedicated composite index so those queries can use an
 * index scan instead of a sequential scan + sort.
 *
 * MIGRATION: 005_streams_contract_id_event_index
 *
 * @module db/migrations/005_streams_contract_id_event_index
 */

export const up = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_streams_contract_event
  ON streams (contract_id, event_index);
`;

export const down = `
DROP INDEX CONCURRENTLY IF EXISTS idx_streams_contract_event;
`;
