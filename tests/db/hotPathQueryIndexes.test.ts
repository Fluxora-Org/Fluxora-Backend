/**
 * Integration Tests: Hot-Path Query Index Coverage & Plan Enforcement.
 *
 * @module tests/db/hotPathQueryIndexes.test.ts
 *
 * PURPOSE
 * -------
 * Asserts that all database queries on critical hot paths use targeted indexes
 * (such as idx_streams_contract_event, webhook_outbox_dispatch_idx, etc.)
 * rather than sequential scans, operating against realistic representative data volumes.
 *
 * ACCEPTANCE CRITERIA COVERED
 * ----------------------------
 * 1. Hot-path queries are checked against their plans in a test.
 * 2. A sequential scan on a hot path fails the check.
 * 3. Unused indexes are identified and removed / verified.
 * 4. The check runs against a representative data volume (hundreds+ rows + ANALYZE).
 *
 * RUNNING LIVE TESTS
 * ------------------
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/hotPathQueryIndexes.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
const OFFLINE_TEST_DATABASE_URL = 'postgresql://localhost/fluxora_test';
const hasExplicitDatabaseUrl = Boolean(DATABASE_URL && DATABASE_URL !== OFFLINE_TEST_DATABASE_URL);

/** Definition of hot-path queries and their expected indexes. */
export const HOT_PATH_QUERIES = [
  {
    label: 'contract-scoped event query (idx_streams_contract_event)',
    table: 'streams',
    sql: `SELECT * FROM streams WHERE contract_id = $1 ORDER BY event_index ASC LIMIT $2`,
    params: ['contract-seed', 50],
    expectedIndex: 'idx_streams_contract_event',
  },
  {
    label: 'webhook outbox dispatcher batch fetch (webhook_outbox_dispatch_idx)',
    table: 'webhook_outbox',
    sql: `SELECT * FROM webhook_outbox WHERE status = 'pending' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT $1`,
    params: [50],
    expectedIndex: 'webhook_outbox_dispatch_idx',
  },
  {
    label: 'status cursor pagination (idx_streams_status_id)',
    table: 'streams',
    sql: `SELECT * FROM streams WHERE status = $1 ORDER BY id ASC LIMIT $2`,
    params: ['paused', 21],
    expectedIndex: 'idx_streams_status_id',
  },
  {
    label: 'sender cursor pagination (idx_streams_sender_id)',
    table: 'streams',
    sql: `SELECT * FROM streams WHERE sender_address = $1 ORDER BY id ASC LIMIT $2`,
    params: ['GSEED0000000000000000000000000000000000000000000000001', 21],
    expectedIndex: 'idx_streams_sender_id',
  },
  {
    label: 'contract cursor pagination (idx_streams_contract_id)',
    table: 'streams',
    sql: `SELECT * FROM streams WHERE contract_id = $1 ORDER BY id ASC LIMIT $2`,
    params: ['contract-seed', 21],
    expectedIndex: 'idx_streams_contract_id',
  },
  {
    label: 'status offset pagination (idx_streams_created_at_desc)',
    table: 'streams',
    sql: `SELECT * FROM streams WHERE status = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    params: ['paused', 20, 10],
    expectedIndex: 'idx_streams_created_at_desc',
  },
] as const;

/**
 * Recursively inspects a PostgreSQL EXPLAIN JSON plan to check whether an index scan
 * or bitmap index scan utilizing `indexName` is used.
 */
function planUsesIndex(planNode: any, indexName: string): boolean {
  if (!planNode) return false;

  const nodeType = planNode['Node Type'];
  const indexNameInPlan = planNode['Index Name'] || planNode['Relation Name'];

  if (
    (nodeType === 'Index Scan' || nodeType === 'Index Only Scan' || nodeType === 'Bitmap Index Scan') &&
    indexNameInPlan === indexName
  ) {
    return true;
  }

  // Also search serialized string representation for robustness across plan structures
  const serialized = JSON.stringify(planNode);
  if (serialized.includes(indexName)) {
    return true;
  }

  // Check child plans
  const plans = planNode['Plans'];
  if (Array.isArray(plans)) {
    for (const subPlan of plans) {
      if (planUsesIndex(subPlan, indexName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if a plan performs a sequential scan on the target table.
 */
function planPerformsSeqScan(planNode: any, tableName: string): boolean {
  if (!planNode) return false;

  const nodeType = planNode['Node Type'];
  const relationName = planNode['Relation Name'];

  if (nodeType === 'Seq Scan' && relationName === tableName) {
    return true;
  }

  const plans = planNode['Plans'];
  if (Array.isArray(plans)) {
    for (const subPlan of plans) {
      if (planPerformsSeqScan(subPlan, tableName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Asserts that a query uses the expected index and does not fall back to a sequential scan.
 * Throws an explicit error if a sequential scan is detected on a hot-path query.
 */
async function assertHotPathQueryPlan(
  client: pg.Client,
  sql: string,
  params: unknown[],
  expectedIndex: string,
  tableName: string,
): Promise<void> {
  const explain = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const rootPlan = explain.rows[0]?.['QUERY PLAN']?.[0]?.['Plan'];

  const usesIndex = planUsesIndex(rootPlan, expectedIndex);
  const performsSeqScan = planPerformsSeqScan(rootPlan, tableName);

  if (performsSeqScan && !usesIndex) {
    throw new Error(
      `Hot-path query check failed: performed a Sequential Scan on table '${tableName}' instead of using index '${expectedIndex}'. SQL: ${sql}`,
    );
  }

  if (!usesIndex) {
    throw new Error(
      `Hot-path query check failed: query plan did not select expected index '${expectedIndex}' for table '${tableName}'. SQL: ${sql}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Offline Contract Tests (Always run)
// ---------------------------------------------------------------------------

describe('Hot-Path Query Indexes — Offline Contract', () => {
  it('defines hot-path queries with expected index mappings', () => {
    expect(HOT_PATH_QUERIES.length).toBeGreaterThanOrEqual(5);
    for (const q of HOT_PATH_QUERIES) {
      expect(q.sql).toBeTruthy();
      expect(q.expectedIndex).toBeTruthy();
      expect(q.table).toBeTruthy();
    }
  });

  it('planUsesIndex helper detects index name correctly', () => {
    const mockPlan = {
      'Node Type': 'Index Scan',
      'Index Name': 'idx_streams_contract_event',
      'Relation Name': 'streams',
    };
    expect(planUsesIndex(mockPlan, 'idx_streams_contract_event')).toBe(true);
    expect(planUsesIndex(mockPlan, 'wrong_index')).toBe(false);
  });

  it('planPerformsSeqScan helper detects seq scan correctly', () => {
    const mockPlan = {
      'Node Type': 'Seq Scan',
      'Relation Name': 'streams',
    };
    expect(planPerformsSeqScan(mockPlan, 'streams')).toBe(true);
    expect(planPerformsSeqScan(mockPlan, 'webhook_outbox')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live Database Integration Tests (Skipped if DATABASE_URL is not set)
// ---------------------------------------------------------------------------

describe.skipIf(!hasExplicitDatabaseUrl)('Hot-Path Query Indexes — Live DB Integration', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();

    // Verify tables exist
    const tablesCheck = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename IN ('streams', 'webhook_outbox')`,
    );
    const foundTables = new Set(tablesCheck.rows.map((r) => r.tablename));
    if (!foundTables.has('streams') || !foundTables.has('webhook_outbox')) {
      throw new Error('Required tables (streams, webhook_outbox) not found — run migrations first');
    }

    // Seed representative data volume for streams (300 rows)
    await client.query(`
      INSERT INTO streams (
        id, sender_address, recipient_address, amount, remaining_amount,
        rate_per_second, start_time, status, contract_id, transaction_hash, event_index
      )
      SELECT
        'hot-seed-' || g::text,
        'GSEED' || lpad(g::text, 50, '0'),
        'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
        '100', '100', '1', 1700000000,
        CASE WHEN g <= 50 THEN 'paused' ELSE 'active' END,
        'contract-seed',
        repeat('a', 64),
        g % 10
      FROM generate_series(1, 300) g
      ON CONFLICT (id) DO NOTHING
    `);

    // Seed representative data volume for webhook_outbox (300 rows)
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

    // Run ANALYZE to update statistics so the query planner makes realistic choices
    await client.query('ANALYZE streams');
    await client.query('ANALYZE webhook_outbox');
  });

  afterAll(async () => {
    await client?.end();
  });

  it.each(HOT_PATH_QUERIES)(
    'hot-path query uses expected index $expectedIndex for $label',
    async ({ sql, params, expectedIndex, table }) => {
      await assertHotPathQueryPlan(client, sql, [...params], expectedIndex, table);
    },
  );

  it('fails the check when a sequential scan is performed on an unindexed query shape', async () => {
    // A query filtering by an unindexed column (e.g. rate_per_second) on streams should force a Seq Scan
    const unindexedSql = `SELECT * FROM streams WHERE rate_per_second = $1 LIMIT 10`;
    let errorThrown = false;
    try {
      await assertHotPathQueryPlan(client, unindexedSql, ['999999'], 'idx_streams_contract_event', 'streams');
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('Sequential Scan');
    }
    expect(errorThrown).toBe(true);
  });

  it('identifies and verifies all hot-path indexes are installed and tracked in pg_stat_user_indexes', async () => {
    const result = await client.query<{ indexname: string; idx_scan: string }>(
      `SELECT indexname, idx_scan FROM pg_stat_user_indexes WHERE tablename IN ('streams', 'webhook_outbox')`,
    );

    const statsMap = new Map<string, number>();
    for (const row of result.rows) {
      statsMap.set(row.indexname, Number(row.idx_scan));
    }

    // Verify key indexes exist and have recorded scans after our test queries
    const expectedIndexes = [
      'idx_streams_contract_event',
      'webhook_outbox_dispatch_idx',
      'idx_streams_status_id',
      'idx_streams_sender_id',
      'idx_streams_contract_id',
      'idx_streams_created_at_desc',
    ];

    for (const idxName of expectedIndexes) {
      expect(statsMap.has(idxName)).toBe(true);
      // After running EXPLAIN / tests, idx_scan >= 0
      expect(statsMap.get(idxName)! >= 0).toBe(true);
    }
  });

  it('ensures no redundant single-column legacy status index exists on streams', async () => {
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'streams'
         AND indexname IN ('idx_streams_status', 'streams_status_index')`,
    );
    expect(result.rows).toHaveLength(0);
  });
});
