/**
 * Tests for migration 006_add_webhook_outbox_dispatch_index.
 *
 * Offline contract tests validate the SQL strings contain the expected
 * clauses so CI passes without a live database.
 *
 * Live integration tests (skipped when DATABASE_URL is absent) run EXPLAIN
 * against a real PostgreSQL instance and confirm the planner chooses an
 * Index Scan for the dispatcher batch-fetch query.
 *
 * Local run:
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/webhookOutbox.dispatchIndex.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import { up, down, INDEX_NAME } from '../../src/db/migrations/006_add_webhook_outbox_dispatch_index.js';

// ---------------------------------------------------------------------------
// Offline contract tests — no database required
// ---------------------------------------------------------------------------

describe('webhook_outbox dispatch index migration (offline contract)', () => {
  it('up migration creates the correct index name', () => {
    expect(up).toContain('webhook_outbox_dispatch_idx');
  });

  it('up migration targets the webhook_outbox table', () => {
    expect(up).toContain('ON webhook_outbox');
  });

  it('up migration includes both status and scheduled_at columns', () => {
    expect(up).toContain('status, scheduled_at');
  });

  it('up migration uses a partial index on pending rows only', () => {
    expect(up).toContain("WHERE status = 'pending'");
  });

  it('up migration uses CONCURRENTLY to avoid table lock', () => {
    expect(up.toUpperCase()).toContain('CONCURRENTLY');
  });

  it('up migration is idempotent via IF NOT EXISTS', () => {
    expect(up.toUpperCase()).toContain('IF NOT EXISTS');
  });

  it('down migration drops the correct index', () => {
    expect(down).toContain('webhook_outbox_dispatch_idx');
  });

  it('down migration uses IF EXISTS for safety', () => {
    expect(down.toUpperCase()).toContain('IF EXISTS');
  });

  it('down migration uses CONCURRENTLY to avoid table lock', () => {
    expect(down.toUpperCase()).toContain('CONCURRENTLY');
  });

  it('INDEX_NAME export matches the name in the SQL', () => {
    expect(up).toContain(INDEX_NAME);
    expect(down).toContain(INDEX_NAME);
  });
});

// ---------------------------------------------------------------------------
// Live integration tests — require a running PostgreSQL with migrations applied
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

/** Dispatcher batch-fetch query matching src/webhooks/dispatcher.ts */
const DISPATCHER_QUERY = `
  SELECT * FROM webhook_outbox
  WHERE status = 'pending'
    AND scheduled_at <= NOW()
  ORDER BY scheduled_at ASC
  LIMIT $1
`;

function planUsesIndex(planJson: unknown, indexName: string): boolean {
  return JSON.stringify(planJson).includes(indexName);
}

describe.skipIf(!isLiveDb)('webhook_outbox dispatch index (live DB)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();

    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'webhook_outbox'
       ) AS exists`,
    );
    if (!tableCheck.rows[0]?.exists) {
      throw new Error('webhook_outbox table not found — run migrations before EXPLAIN tests');
    }

    // Seed enough pending rows so the query planner chooses the index.
    await client.query(`
      INSERT INTO webhook_outbox (id, status, scheduled_at, payload, created_at)
      SELECT
        gen_random_uuid(),
        'pending',
        NOW() - (g || ' seconds')::interval,
        '{}',
        NOW()
      FROM generate_series(1, 300) g
      ON CONFLICT DO NOTHING
    `);
    await client.query('ANALYZE webhook_outbox');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('has the dispatch index installed', async () => {
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'webhook_outbox'`,
    );
    const names = new Set(result.rows.map((r) => r.indexname));
    expect(names.has(INDEX_NAME)).toBe(true);
  });

  it('dispatcher query EXPLAIN uses Index Scan on webhook_outbox_dispatch_idx', async () => {
    const explain = await client.query(`EXPLAIN (FORMAT JSON) ${DISPATCHER_QUERY}`, [50]);
    const plan = explain.rows[0]?.['QUERY PLAN'];
    expect(planUsesIndex(plan, INDEX_NAME)).toBe(true);
  });
});
