import { PoolClient } from 'pg';

/**
 * Initial database schema for contract event indexer
 */

export async function up(client: PoolClient): Promise<void> {
  console.log('Creating initial schema...');

  // Historical events table (source data)
  await client.query(`
    CREATE TABLE IF NOT EXISTS historical_events (
      event_id VARCHAR(255) PRIMARY KEY,
      contract_id VARCHAR(255) NOT NULL,
      ledger INTEGER NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      event_data JSONB NOT NULL,
      block_height BIGINT NOT NULL,
      transaction_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Contract events table (replay destination)
  await client.query(`
    CREATE TABLE IF NOT EXISTS contract_events (
      event_id VARCHAR(255) NOT NULL,
      contract_id VARCHAR(255) NOT NULL,
      ledger INTEGER NOT NULL,
      event_type VARCHAR(100),
      event_data JSONB,
      block_height BIGINT,
      transaction_hash VARCHAR(255),
      topic TEXT,
      tx_hash TEXT,
      tx_index INTEGER,
      operation_index INTEGER,
      event_index INTEGER,
      payload JSONB,
      happened_at TIMESTAMPTZ,
      ledger_hash TEXT,
      ingested_at TIMESTAMP,
      ingestion_state TEXT GENERATED ALWAYS AS (
        CASE WHEN ingested_at IS NULL THEN 'pending' ELSE 'ingested' END
      ) STORED,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ledger, event_id)
    ) PARTITION BY RANGE (ledger);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS contract_events_default
      PARTITION OF contract_events DEFAULT;
  `);

  console.log('Initial schema created successfully');
}

export async function down(client: PoolClient): Promise<void> {
  console.log('Dropping initial schema...');

  await client.query(`DROP TABLE IF EXISTS contract_events CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS historical_events;`);

  console.log('Initial schema dropped successfully');
}
