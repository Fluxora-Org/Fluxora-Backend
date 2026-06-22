import { PoolClient } from 'pg';

type MigrationTarget = PoolClient | { sql: (statement: string) => void };

function isPoolClient(target: MigrationTarget): target is PoolClient {
  return typeof (target as PoolClient).query === 'function';
}

async function runSql(target: MigrationTarget, statement: string): Promise<void> {
  if (isPoolClient(target)) {
    await target.query(statement);
    return;
  }

  target.sql(statement);
}

/**
 * Add partition-management and ingestion-state enforcement for contract_events.
 *
 * Fresh deployments should create `contract_events` as a ledger range-partitioned
 * table. Existing non-partitioned deployments get a shadow
 * `contract_events_partitioned` table and helper routines so operators can
 * backfill and swap during a controlled maintenance window instead of taking a
 * long table lock inside this migration.
 */
export async function up(target: MigrationTarget): Promise<void> {
  await runSql(target, `
    DO $$
    DECLARE
      contract_events_kind "char";
    BEGIN
      SELECT c.relkind
        INTO contract_events_kind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'contract_events';

      IF contract_events_kind IS NULL THEN
        CREATE TABLE contract_events (
          event_id VARCHAR(255) NOT NULL,
          contract_id VARCHAR(255) NOT NULL,
          ledger INTEGER NOT NULL CHECK (ledger >= 0),
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
          ingested_at TIMESTAMPTZ,
          ingestion_state TEXT GENERATED ALWAYS AS (
            CASE WHEN ingested_at IS NULL THEN 'pending' ELSE 'ingested' END
          ) STORED,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (ledger, event_id)
        ) PARTITION BY RANGE (ledger);

        CREATE TABLE contract_events_default
          PARTITION OF contract_events DEFAULT;
      ELSIF contract_events_kind = 'p' THEN
        NULL;
      ELSE
        CREATE TABLE IF NOT EXISTS contract_events_partitioned (
          event_id VARCHAR(255) NOT NULL,
          contract_id VARCHAR(255) NOT NULL,
          ledger INTEGER NOT NULL CHECK (ledger >= 0),
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
          ingested_at TIMESTAMPTZ,
          ingestion_state TEXT GENERATED ALWAYS AS (
            CASE WHEN ingested_at IS NULL THEN 'pending' ELSE 'ingested' END
          ) STORED,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (ledger, event_id)
        ) PARTITION BY RANGE (ledger);

        CREATE TABLE IF NOT EXISTS contract_events_partitioned_default
          PARTITION OF contract_events_partitioned DEFAULT;
      END IF;
    END
    $$;
  `);

  await runSql(target, `
    CREATE OR REPLACE FUNCTION enforce_contract_events_ingested_at_lifecycle()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.ingested_at IS NOT NULL AND NEW.ingested_at IS NULL THEN
          RAISE EXCEPTION 'contract_events.ingested_at cannot move from ingested back to pending';
        END IF;

        IF OLD.ingested_at IS NOT NULL
           AND NEW.ingested_at IS NOT NULL
           AND NEW.ingested_at < OLD.ingested_at THEN
          RAISE EXCEPTION 'contract_events.ingested_at cannot move backwards';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  await runSql(target, `
    DO $$
    BEGIN
      IF to_regclass('public.contract_events') IS NOT NULL THEN
        ALTER TABLE contract_events
          ADD COLUMN IF NOT EXISTS event_type VARCHAR(100),
          ADD COLUMN IF NOT EXISTS event_data JSONB,
          ADD COLUMN IF NOT EXISTS block_height BIGINT,
          ADD COLUMN IF NOT EXISTS transaction_hash VARCHAR(255),
          ADD COLUMN IF NOT EXISTS topic TEXT,
          ADD COLUMN IF NOT EXISTS tx_hash TEXT,
          ADD COLUMN IF NOT EXISTS tx_index INTEGER,
          ADD COLUMN IF NOT EXISTS operation_index INTEGER,
          ADD COLUMN IF NOT EXISTS event_index INTEGER,
          ADD COLUMN IF NOT EXISTS payload JSONB,
          ADD COLUMN IF NOT EXISTS happened_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ledger_hash TEXT,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

        ALTER TABLE contract_events
          ADD COLUMN IF NOT EXISTS ingestion_state TEXT GENERATED ALWAYS AS (
            CASE WHEN ingested_at IS NULL THEN 'pending' ELSE 'ingested' END
          ) STORED;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'contract_events'
             AND column_name = 'created_at'
        ) THEN
          ALTER TABLE contract_events
            ADD CONSTRAINT contract_events_ingested_at_not_before_create
            CHECK (ingested_at IS NULL OR created_at IS NULL OR ingested_at >= created_at)
            NOT VALID;
        END IF;

        DROP TRIGGER IF EXISTS trg_contract_events_ingested_at_lifecycle
          ON contract_events;
        CREATE TRIGGER trg_contract_events_ingested_at_lifecycle
          BEFORE UPDATE OF ingested_at ON contract_events
          FOR EACH ROW
          EXECUTE FUNCTION enforce_contract_events_ingested_at_lifecycle();
      END IF;
    END
    $$;
  `);

  await runSql(target, `
    CREATE OR REPLACE FUNCTION ensure_contract_events_partition(
      start_ledger INTEGER,
      end_ledger INTEGER
    )
    RETURNS TEXT
    LANGUAGE plpgsql
    AS $$
    DECLARE
      active_parent TEXT;
      partition_name TEXT;
      suffix TEXT;
    BEGIN
      IF start_ledger IS NULL OR end_ledger IS NULL OR start_ledger < 0 OR end_ledger <= start_ledger THEN
        RAISE EXCEPTION 'invalid contract_events partition range [% , %)', start_ledger, end_ledger;
      END IF;

      SELECT CASE
               WHEN c.relkind = 'p' THEN 'contract_events'
               WHEN to_regclass('public.contract_events_partitioned') IS NOT NULL THEN 'contract_events_partitioned'
               ELSE NULL
             END
        INTO active_parent
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'contract_events';

      IF active_parent IS NULL THEN
        RAISE EXCEPTION 'contract_events partition parent is not available';
      END IF;

      suffix := start_ledger::TEXT || '_' || end_ledger::TEXT;
      partition_name := active_parent || '_ledger_' || suffix;

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%s) TO (%s)',
        partition_name,
        active_parent,
        start_ledger,
        end_ledger
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I (contract_id, ledger, block_height, event_id)',
        'idx_ce_' || suffix || '_contract_ledger',
        partition_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I (contract_id, ledger, block_height) WHERE ingested_at IS NULL',
        'idx_ce_' || suffix || '_pending_ingestion',
        partition_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I (happened_at, ledger) WHERE happened_at IS NOT NULL',
        'idx_ce_' || suffix || '_happened_at',
        partition_name
      );

      RETURN partition_name;
    END;
    $$;
  `);

  await runSql(target, `
    DO $$
    BEGIN
      IF to_regclass('public.contract_events') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_contract_events_contract_ledger
          ON contract_events (contract_id, ledger, block_height, event_id);

        CREATE INDEX IF NOT EXISTS idx_contract_events_pending_ingestion
          ON contract_events (contract_id, ledger, block_height)
          WHERE ingested_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_contract_events_happened_at_ledger
          ON contract_events (happened_at, ledger)
          WHERE happened_at IS NOT NULL;
      END IF;

      IF to_regclass('public.contract_events_partitioned') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_contract_events_partitioned_contract_ledger
          ON contract_events_partitioned (contract_id, ledger, block_height, event_id);

        CREATE INDEX IF NOT EXISTS idx_contract_events_partitioned_pending_ingestion
          ON contract_events_partitioned (contract_id, ledger, block_height)
          WHERE ingested_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_contract_events_partitioned_happened_at_ledger
          ON contract_events_partitioned (happened_at, ledger)
          WHERE happened_at IS NOT NULL;
      END IF;
    END
    $$;
  `);
}

export async function down(target: MigrationTarget): Promise<void> {
  await runSql(target, `
    DO $$
    BEGIN
      IF to_regclass('public.contract_events') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_contract_events_ingested_at_lifecycle
          ON contract_events;
        ALTER TABLE contract_events
          DROP CONSTRAINT IF EXISTS contract_events_ingested_at_not_before_create;
      END IF;
    END
    $$;
  `);

  await runSql(target, `
    DROP FUNCTION IF EXISTS ensure_contract_events_partition(INTEGER, INTEGER);
    DROP FUNCTION IF EXISTS enforce_contract_events_ingested_at_lifecycle();
    DROP TABLE IF EXISTS contract_events_partitioned CASCADE;
  `);
}
