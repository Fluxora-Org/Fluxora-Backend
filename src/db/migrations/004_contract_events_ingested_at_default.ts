/**
 * Migration: Configure default value for contract_events.ingested_at (PostgreSQL)
 *
 * MIGRATION: 004_contract_events_ingested_at_default
 *
 * @module db/migrations/004_contract_events_ingested_at_default
 */

export const up = `
-- 1. Repair any existing NULL values in ingested_at
UPDATE contract_events SET ingested_at = NOW() WHERE ingested_at IS NULL;

-- 2. Configure default value and make the column NOT NULL
ALTER TABLE contract_events ALTER COLUMN ingested_at SET DEFAULT NOW();
ALTER TABLE contract_events ALTER COLUMN ingested_at SET NOT NULL;
`;

export const down = `
ALTER TABLE contract_events ALTER COLUMN ingested_at DROP DEFAULT;
ALTER TABLE contract_events ALTER COLUMN ingested_at DROP NOT NULL;
`;
