/**
 * Integration tests: composite stream pagination indexes.
 *
 * When DATABASE_URL points at a live PostgreSQL instance with the streams table
 * and composite indexes applied, EXPLAIN plans must show index scans for the
 * cursor and offset query patterns from streamRepository.
 *
 * Offline / CI without Postgres: tests are skipped automatically.
 *
 * Local run:
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/streams.compositeIndexes.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

/** Index names created by migrations/20260622000000_streams_composite_pagination_indexes.ts */
export const COMPOSITE_INDEX_NAMES = [
  'idx_streams_status_id',
  'idx_streams_sender_id',
  'idx_streams_contract_id',
  'idx_streams_status_created_at_desc',
] as const;

/** SQL patterns mirroring streamRepository.findWithCursor / find. */
export const CURSOR_QUERIES = [
  {
    label: 'status cursor',
    sql: `SELECT * FROM streams WHERE status = $1 ORDER BY id ASC LIMIT $2`,
    params: ['paused', 21],
    expectedIndex: 'idx_streams_status_id',
  },
  {
    label: 'sender cursor',
    sql: `SELECT * FROM streams WHERE sender_address = $1 ORDER BY id ASC LIMIT $2`,
    params: ['GSEED' + '0'.repeat(49) + '1', 21],
    expectedIndex: 'idx_streams_sender_id',
  },
  {
    label: 'contract cursor',
    sql: `SELECT * FROM streams WHERE contract_id = $1 ORDER BY id ASC LIMIT $2`,
    params: ['contract-a', 21],
    expectedIndex: 'idx_streams_contract_id',
  },
  {
    label: 'status cursor with afterId',
    sql: `SELECT * FROM streams WHERE status = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
    params: ['paused', 'explain-seed-50', 21],
    expectedIndex: 'idx_streams_status_id',
  },
] as const;

export const OFFSET_QUERIES = [
  {
    label: 'status offset',
    sql: `SELECT * FROM streams WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    params: ['paused', 20, 10],
    expectedIndex: 'idx_streams_status_created_at_desc',
  },
] as const;

function planUsesIndex(planJson: unknown, indexName: string): boolean {
  const serialized = JSON.stringify(planJson);
  return serialized.includes(indexName);
}

describe.skipIf(!isLiveDb)('streams composite pagination indexes (live DB)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();

    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'streams'
       ) AS exists`,
    );
    if (!tableCheck.rows[0]?.exists) {
      throw new Error('streams table not found — run migrations before EXPLAIN tests');
    }

    // Seed varied senders and a selective paused status set so the planner
    // prefers composite indexes over a primary-key scan on small/local datasets.
    await client.query(`
      INSERT INTO streams (
        id, sender_address, recipient_address, amount, remaining_amount,
        rate_per_second, start_time, status, contract_id, transaction_hash, event_index
      )
      SELECT
        'explain-seed-' || g::text,
        'GSEED' || lpad(g::text, 50, '0'),
        'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
        '100', '100', '1', 1700000000,
        CASE WHEN g <= 30 THEN 'paused' ELSE 'active' END,
        'contract-seed',
        repeat('b', 64), 0
      FROM generate_series(1, 200) g
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query('ANALYZE streams');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('has all composite indexes installed', async () => {
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'streams'`,
    );
    const names = new Set(result.rows.map((r) => r.indexname));
    for (const indexName of COMPOSITE_INDEX_NAMES) {
      expect(names.has(indexName)).toBe(true);
    }
  });

  it.each(CURSOR_QUERIES)('cursor EXPLAIN uses index for $label', async ({ sql, params, expectedIndex }) => {
    const explain = await client.query(
      `EXPLAIN (FORMAT JSON) ${sql}`,
      [...params],
    );
    const plan = explain.rows[0]?.['QUERY PLAN'];
    expect(planUsesIndex(plan, expectedIndex)).toBe(true);
  });

  it.each(OFFSET_QUERIES)('offset EXPLAIN uses index for $label', async ({ sql, params, expectedIndex }) => {
    const explain = await client.query(
      `EXPLAIN (FORMAT JSON) ${sql}`,
      [...params],
    );
    const plan = explain.rows[0]?.['QUERY PLAN'];
    expect(planUsesIndex(plan, expectedIndex)).toBe(true);
  });

  it('does not retain redundant single-column status index after migration', async () => {
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'streams'
         AND indexname IN ('idx_streams_status', 'streams_status_index')`,
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe('streams composite pagination indexes (offline contract)', () => {
  it('documents the index-to-query mapping for cursor pagination', () => {
    expect(CURSOR_QUERIES.map((q) => q.expectedIndex)).toEqual([
      'idx_streams_status_id',
      'idx_streams_sender_id',
      'idx_streams_contract_id',
      'idx_streams_status_id',
    ]);
  });

  it('documents the index-to-query mapping for offset pagination', () => {
    expect(OFFSET_QUERIES[0]?.expectedIndex).toBe('idx_streams_status_created_at_desc');
  });

  it('lists exactly four composite indexes', () => {
    expect(COMPOSITE_INDEX_NAMES).toHaveLength(4);
  });
});
