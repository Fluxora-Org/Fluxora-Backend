/**
 * Rollback coverage for the eight migrations in src/db/migrations.
 *
 * The PostgreSQL round trip is opt-in because the normal test setup provides a
 * default DATABASE_URL even when no database is running:
 *
 * MIGRATION_ROLLBACK_DATABASE_URL=postgresql://... pnpm test -- tests/db/migrations.rollback.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import * as createStreams from '../../src/db/migrations/001_create_streams_table.js';
import * as durableRetry from '../../src/db/migrations/002_webhook_outbox_durable_retry.js';
import * as replayProgress from '../../src/db/migrations/003_create_indexer_replay_progress.js';
import * as ingestedAt from '../../src/db/migrations/004_contract_events_ingested_at_default.js';
import * as streamEventIndex from '../../src/db/migrations/005_streams_contract_id_event_index.js';
import * as dispatchIndex from '../../src/db/migrations/006_add_webhook_outbox_dispatch_index.js';
import * as eventIndexCheck from '../../src/db/migrations/006_streams_event_index_check.js';
import * as lockColumns from '../../src/db/migrations/007_add_webhook_outbox_lock_columns.js';

const rollbackDatabaseUrl = process.env['MIGRATION_ROLLBACK_DATABASE_URL'];

const migrations = [
  createStreams,
  durableRetry,
  replayProgress,
  ingestedAt,
  streamEventIndex,
  dispatchIndex,
  eventIndexCheck,
  lockColumns,
] as const;

describe('src/db/migrations rollback contracts', () => {
  it.each(migrations)('exports an up and down path', (migration) => {
    expect(migration.up).toBeDefined();
    expect(migration.down).toBeDefined();
  });

  it('flags the only non-lossless migration', () => {
    expect(ingestedAt.irreversibleReason).toContain('NULL');
  });
});

describe.skipIf(!rollbackDatabaseUrl)('src/db/migrations PostgreSQL round trips', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: rollbackDatabaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function reset(): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS indexer_replay_progress, replay_cursors,
        contract_events, webhook_outbox, streams CASCADE;
    `);
  }

  async function hasColumn(table: string, column: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    return result.rowCount === 1;
  }

  async function hasIndex(indexName: string): Promise<boolean> {
    const result = await client.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [indexName]);
    return result.rowCount === 1;
  }

  it('reverses the streams table and leaves unrelated tables untouched', async () => {
    await reset();
    await client.query(createStreams.up);
    await client.query(`
      INSERT INTO streams
        (id, sender_address, recipient_address, amount, remaining_amount,
         rate_per_second, start_time, contract_id, transaction_hash, event_index)
      VALUES ('stream-1', 'sender', 'recipient', '10', '10', '1', 1, 'contract', 'tx', 0)
    `);
    await client.query(createStreams.down);

    expect(await hasColumn('streams', 'id')).toBe(false);
  });

  it('reverses durable retry columns without changing legacy rows', async () => {
    await reset();
    await client.query(`
      CREATE TABLE webhook_outbox (
        id UUID PRIMARY KEY, processed BOOLEAN NOT NULL DEFAULT false,
        payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(
      `INSERT INTO webhook_outbox (id, payload, created_at) VALUES ($1, $2, NOW())`,
      ['00000000-0000-0000-0000-000000000001', '{}']
    );
    const before = await client.query('SELECT id, processed, payload FROM webhook_outbox');
    await client.query(durableRetry.up);
    await client.query(durableRetry.down);
    const after = await client.query('SELECT id, processed, payload FROM webhook_outbox');

    expect(after.rows).toEqual(before.rows);
    expect(await hasColumn('webhook_outbox', 'attempt_count')).toBe(false);
  });

  it('reverses replay progress while preserving its prerequisite cursor', async () => {
    await reset();
    await client.query('CREATE TABLE replay_cursors (id UUID PRIMARY KEY)');
    await client.query(
      `INSERT INTO replay_cursors VALUES ('00000000-0000-0000-0000-000000000001')`
    );
    await client.query(replayProgress.up);
    await client.query(
      `INSERT INTO indexer_replay_progress (last_committed_cursor, total, status)
       VALUES ('00000000-0000-0000-0000-000000000001', 1, 'complete')`
    );
    await client.query(replayProgress.down);

    expect(await hasColumn('indexer_replay_progress', 'status')).toBe(false);
    expect(
      (await client.query('SELECT count(*)::int AS count FROM replay_cursors')).rows[0].count
    ).toBe(1);
  });

  it('reverses the ingested_at schema change and preserves non-null data', async () => {
    await reset();
    await client.query(
      'CREATE TABLE contract_events (id UUID PRIMARY KEY, ingested_at TIMESTAMPTZ)'
    );
    await client.query(
      `INSERT INTO contract_events VALUES ('00000000-0000-0000-0000-000000000001', '2026-01-01T00:00:00Z')`
    );
    const before = await client.query('SELECT * FROM contract_events');
    await client.query(ingestedAt.up);
    await client.query(ingestedAt.down);

    expect((await client.query('SELECT * FROM contract_events')).rows).toEqual(before.rows);
    expect(await hasColumn('contract_events', 'ingested_at')).toBe(true);
  });

  it('reverses the streams composite index with populated data', async () => {
    await reset();
    await client.query(`
      CREATE TABLE streams (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, event_index INTEGER NOT NULL)
    `);
    await client.query(`INSERT INTO streams VALUES ('stream-1', 'contract', 0)`);
    await client.query(streamEventIndex.up);
    expect(await hasIndex('idx_streams_contract_event')).toBe(true);
    await client.query(streamEventIndex.down);
    expect(await hasIndex('idx_streams_contract_event')).toBe(false);
  });

  it('reverses the webhook dispatch index with populated data', async () => {
    await reset();
    await client.query(`
      CREATE TABLE webhook_outbox (
        id UUID PRIMARY KEY, status TEXT NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(
      `INSERT INTO webhook_outbox VALUES ('00000000-0000-0000-0000-000000000001', 'pending', NOW())`
    );
    await client.query(dispatchIndex.up);
    expect(await hasIndex(dispatchIndex.INDEX_NAME)).toBe(true);
    await client.query(dispatchIndex.down);
    expect(await hasIndex(dispatchIndex.INDEX_NAME)).toBe(false);
  });

  it('reverses the event index check without changing populated data', async () => {
    await reset();
    await client.query(`
      CREATE TABLE streams (id TEXT PRIMARY KEY, event_index INTEGER NOT NULL)
    `);
    await client.query(`INSERT INTO streams VALUES ('stream-1', 0)`);
    await client.query(eventIndexCheck.up);
    await client.query(eventIndexCheck.down);

    expect((await client.query('SELECT * FROM streams')).rows).toEqual([
      { id: 'stream-1', event_index: 0 },
    ]);
  });

  it('reverses webhook lock columns and restores the legacy row shape', async () => {
    await reset();
    await client.query(`
      CREATE TABLE webhook_outbox (
        id UUID PRIMARY KEY, processed BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await client.query(
      `INSERT INTO webhook_outbox (id, processed) VALUES ('00000000-0000-0000-0000-000000000001', true)`
    );
    const before = await client.query('SELECT * FROM webhook_outbox');
    await client.query(lockColumns.up);
    await client.query(lockColumns.down);

    expect((await client.query('SELECT * FROM webhook_outbox')).rows).toEqual(before.rows);
    expect(await hasColumn('webhook_outbox', 'status')).toBe(false);
  });
});
