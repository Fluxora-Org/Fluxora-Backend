import { describe, expect, it, vi } from 'vitest';
import { up, down } from '../migrations/003_contract_events_partitioning_retention.js';

function makeMigrationBuilder() {
  const statements: string[] = [];
  return {
    statements,
    builder: {
      sql: vi.fn((statement: string) => {
        statements.push(statement);
      }),
    },
  };
}

describe('003_contract_events_partitioning_retention migration', () => {
  it('creates a partitioned contract_events path and a shadow table for safe backfill', async () => {
    const { builder, statements } = makeMigrationBuilder();

    await up(builder);
    const sql = statements.join('\n');

    expect(sql).toContain('PARTITION BY RANGE (ledger)');
    expect(sql).toContain('contract_events_partitioned');
    expect(sql).toContain('PARTITION OF contract_events DEFAULT');
    expect(sql).toContain('PRIMARY KEY (ledger, event_id)');
  });

  it('defines and attaches the ingested_at lifecycle trigger', async () => {
    const { builder, statements } = makeMigrationBuilder();

    await up(builder);
    const sql = statements.join('\n');

    expect(sql).toContain('enforce_contract_events_ingested_at_lifecycle');
    expect(sql).toContain('cannot move from ingested back to pending');
    expect(sql).toContain('cannot move backwards');
    expect(sql).toContain('trg_contract_events_ingested_at_lifecycle');
    expect(sql).toContain('ingestion_state TEXT GENERATED ALWAYS AS');
  });

  it('defines partition creation routine and per-partition indexes', async () => {
    const { builder, statements } = makeMigrationBuilder();

    await up(builder);
    const sql = statements.join('\n');

    expect(sql).toContain('ensure_contract_events_partition');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I');
    expect(sql).toContain('pending_ingestion');
    expect(sql).toContain('happened_at');
  });

  it('down removes helpers and shadow partition table without dropping canonical data', async () => {
    const { builder, statements } = makeMigrationBuilder();

    await down(builder);
    const sql = statements.join('\n');

    expect(sql).toContain('DROP FUNCTION IF EXISTS ensure_contract_events_partition');
    expect(sql).toContain('DROP TABLE IF EXISTS contract_events_partitioned CASCADE');
    expect(sql).not.toContain('DROP TABLE IF EXISTS contract_events CASCADE');
  });
});
