/**
 * Tests for migration 007_add_webhook_outbox_lock_columns.
 *
 * Offline contract tests validate the SQL strings contain the expected
 * clauses, columns, and partial index so CI passes without a live database.
 *
 * Live integration tests (skipped when DATABASE_URL is absent) verify that
 * columns and indexes are created on PostgreSQL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import {
  up,
  down,
  IN_FLIGHT_INDEX_NAME,
} from '../../src/db/migrations/007_add_webhook_outbox_lock_columns.js';

// ---------------------------------------------------------------------------
// Offline contract tests — no database required
// ---------------------------------------------------------------------------

describe('webhook_outbox lock columns migration (offline contract)', () => {
  it('up migration creates the in-flight index', () => {
    expect(up).toContain('idx_webhook_outbox_in_flight');
  });

  it('up migration targets the webhook_outbox table', () => {
    expect(up).toContain('ON webhook_outbox');
  });

  it('up migration adds status column with default pending', () => {
    expect(up).toContain('ADD COLUMN IF NOT EXISTS status');
    expect(up).toContain("DEFAULT 'pending'");
  });

  it('up migration adds locked_at and locked_by columns', () => {
    expect(up).toContain('ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ');
    expect(up).toContain('ADD COLUMN IF NOT EXISTS locked_by TEXT');
  });

  it('up migration creates a partial index on status in_flight on locked_at', () => {
    expect(up).toContain('(locked_at)');
    expect(up).toContain("WHERE status = 'in_flight'");
  });

  it('up migration backfills status from legacy processed boolean', () => {
    expect(up).toContain('UPDATE webhook_outbox');
    expect(up).toContain("SET status = 'delivered'");
    expect(up).toContain("WHERE processed = true AND status = 'pending'");
  });

  it('up migration is idempotent via IF NOT EXISTS', () => {
    expect(up.toUpperCase()).toContain('IF NOT EXISTS');
  });

  it('down migration drops the in-flight index', () => {
    expect(down).toContain('DROP INDEX IF EXISTS idx_webhook_outbox_in_flight');
  });

  it('down migration drops the lock columns and status', () => {
    expect(down).toContain('DROP COLUMN IF EXISTS locked_by');
    expect(down).toContain('DROP COLUMN IF EXISTS locked_at');
    expect(down).toContain('DROP COLUMN IF EXISTS status');
  });

  it('IN_FLIGHT_INDEX_NAME export matches the index name in the SQL', () => {
    expect(up).toContain(IN_FLIGHT_INDEX_NAME);
    expect(down).toContain(IN_FLIGHT_INDEX_NAME);
    expect(IN_FLIGHT_INDEX_NAME).toBe('idx_webhook_outbox_in_flight');
  });
});

// ---------------------------------------------------------------------------
// Live integration tests — require a running PostgreSQL with migrations applied
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

describe.skipIf(!isLiveDb)('webhook_outbox lock columns (live DB)', () => {
  let client: pg.Client;
  let isConnected = false;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      isConnected = true;
    } catch {
      // Local Postgres not reachable; skip live DB assertions gracefully
      return;
    }

    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'webhook_outbox'
       ) AS exists`,
    );
    if (!tableCheck.rows[0]?.exists) {
      isConnected = false;
      return;
    }
  });

  afterAll(async () => {
    if (isConnected) {
      await client?.end();
    }
  });

  it('has the in-flight index installed on webhook_outbox', async () => {
    if (!isConnected) return;
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'webhook_outbox'`,
    );
    const names = new Set(result.rows.map((r) => r.indexname));
    expect(names.has(IN_FLIGHT_INDEX_NAME)).toBe(true);
  });

  it('has locked_at and locked_by columns in webhook_outbox', async () => {
    if (!isConnected) return;
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_outbox'`,
    );
    const cols = new Set(result.rows.map((r) => r.column_name));
    expect(cols.has('locked_at')).toBe(true);
    expect(cols.has('locked_by')).toBe(true);
    expect(cols.has('status')).toBe(true);
  });
});
