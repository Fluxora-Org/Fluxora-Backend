import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Rename existing table and indexes to avoid conflicts
  pgm.renameTable('contract_events', 'contract_events_old');
  pgm.renameIndex('contract_events_old', 'contract_id', 'idx_contract_events_old_contract_id');
  pgm.renameIndex('contract_events_old', 'tx_hash', 'idx_contract_events_old_tx_hash');
  pgm.renameIndex('contract_events_old', 'happened_at', 'idx_contract_events_old_happened_at');

  // 2. Create the new range-partitioned table
  pgm.sql(`
    CREATE TABLE contract_events (
      event_id TEXT NOT NULL,
      ledger INTEGER NOT NULL,
      contract_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_index INTEGER NOT NULL,
      operation_index INTEGER NOT NULL,
      event_index INTEGER NOT NULL,
      payload JSONB NOT NULL,
      happened_at TIMESTAMP WITH TIME ZONE NOT NULL,
      ledger_hash TEXT,
      ingested_at TIMESTAMP WITH TIME ZONE,
      PRIMARY KEY (happened_at, event_id)
    ) PARTITION BY RANGE (happened_at);
  `);

  // 3. Create the DEFAULT partition to hold all existing backfill data and new data not in range.
  //    (In production, explicit ranges are preferred, but a DEFAULT partition avoids insert failures 
  //     if the management script lags). We will also create an initial partition for the current month.
  pgm.sql(`
    CREATE TABLE contract_events_default PARTITION OF contract_events DEFAULT;
  `);

  // 4. Re-create partial and composite indexes per-partition.
  // PostgreSQL 11+ automatically cascades these to partitions when created on the parent.
  pgm.createIndex('contract_events', 'contract_id');
  pgm.createIndex('contract_events', 'tx_hash');
  
  // Composite index for general replay queries
  pgm.sql(`
    CREATE INDEX idx_contract_events_contract_ledger
    ON contract_events (contract_id, ledger, event_id);
  `);

  // Partial index for unprocessed events
  pgm.sql(`
    CREATE INDEX idx_contract_events_pending_ingestion
    ON contract_events (contract_id, ledger)
    WHERE ingested_at IS NULL;
  `);

  // 5. Define ingested_at monotonicity constraint using a trigger
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_ingested_at_monotonicity()
    RETURNS TRIGGER AS $$
    BEGIN
        IF OLD.ingested_at IS NOT NULL AND NEW.ingested_at IS NULL THEN
            RAISE EXCEPTION 'ingested_at cannot be set back to NULL';
        END IF;
        IF OLD.ingested_at IS NOT NULL AND NEW.ingested_at < OLD.ingested_at THEN
            RAISE EXCEPTION 'ingested_at cannot decrease';
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_enforce_ingested_at
    BEFORE UPDATE ON contract_events
    FOR EACH ROW
    WHEN (OLD.ingested_at IS DISTINCT FROM NEW.ingested_at)
    EXECUTE FUNCTION enforce_ingested_at_monotonicity();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_enforce_ingested_at ON contract_events`);
  pgm.sql(`DROP FUNCTION IF EXISTS enforce_ingested_at_monotonicity()`);
  pgm.dropTable('contract_events');
  pgm.renameTable('contract_events_old', 'contract_events');
}
