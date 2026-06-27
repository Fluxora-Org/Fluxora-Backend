import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Creates indexes on the contract_events table concurrently.
 * * SECURITY & OPS NOTE:
 * We disable the transaction block via `pgm.noTransaction()` because PostgreSQL 
 * strictly forbids `CREATE INDEX CONCURRENTLY` inside a transaction block.
 * Building concurrently ensures we do not hold an exclusive lock that blocks writes 
 * to `contract_events` in production. 
 * * IF A MIGRATION FAILS: 
 * A failed CONCURRENTLY build can leave an INVALID index in Postgres. 
 * You must check `pg_index.indisvalid` and drop the invalid index manually 
 * before re-running the migration, otherwise query planning may degrade.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Disable transaction wrapping for this specific migration
  pgm.noTransaction();

  // Create the Contract Ledger Index
  pgm.createIndex('contract_events', ['contract_id', 'ledger_sequence'], {
    name: 'idx_contract_events_contract_ledger',
    concurrently: true,
    ifNotExists: true,
  });

  // Create the Replay Index with the partial predicate
  pgm.createIndex('contract_events', ['contract_id'], {
    name: 'idx_contract_events_replay_null_ingested',
    concurrently: true,
    ifNotExists: true,
    where: 'ingested_at IS NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Must also disable transaction for dropping indexes concurrently
  pgm.noTransaction();

  pgm.dropIndex('contract_events', ['contract_id', 'ledger_sequence'], {
    name: 'idx_contract_events_contract_ledger',
    concurrently: true,
    ifExists: true,
  });

  pgm.dropIndex('contract_events', ['contract_id'], {
    name: 'idx_contract_events_replay_null_ingested',
    concurrently: true,
    ifExists: true,
  });
}
