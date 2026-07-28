import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import { query, extractTableHint } from '../../src/db/pool.js';
import { deRegisterDbMetrics } from '../../src/metrics/dbMetrics.js';
import { registry } from '../../src/metrics.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePool(queryDelayMs: number): pg.Pool {
  return {
    totalCount: 0,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 10 },
    query: vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, queryDelayMs));
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    }),
  } as unknown as pg.Pool;
}

function getSlowQueryCount(tableHint = 'streams'): number {
  const metric = registry.getSingleMetric('fluxora_db_slow_queries_total');
  if (!metric) return 0;
  // @ts-expect-error accessing internal hashMap for test assertions
  const hash = metric.hashMap as Record<string, { value: number }>;
  const key = Object.keys(hash).find((k) => k.includes(tableHint));
  return key ? (hash[key]?.value ?? 0) : 0;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  deRegisterDbMetrics();
  // Re-import to re-register the counter fresh
  vi.resetModules();
  warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  warnSpy.mockRestore();
  deRegisterDbMetrics();
});

// ── extractTableHint ──────────────────────────────────────────────────────────

describe('extractTableHint', () => {
  it('extracts table from SELECT … FROM', () => {
    expect(extractTableHint('SELECT id FROM streams WHERE id = $1')).toBe('streams');
  });

  it('extracts table from INSERT INTO', () => {
    expect(extractTableHint('INSERT INTO contract_events (id) VALUES ($1)')).toBe('contract_events');
  });

  it('extracts table from UPDATE', () => {
    expect(extractTableHint('UPDATE audit_logs SET status = $1')).toBe('audit_logs');
  });

  it('extracts table from JOIN', () => {
    expect(extractTableHint('SELECT * FROM streams JOIN audit_logs ON streams.id = audit_logs.ref')).toBe('streams');
  });

  it('returns unknown for unrecognised SQL', () => {
    expect(extractTableHint('VACUUM')).toBe('unknown');
  });
});

// ── Slow-query logging ────────────────────────────────────────────────────────

describe('query() slow-query logging', () => {
  it('does not log when query is under threshold', async () => {
    const pool = makePool(0);
    await query(pool, 'SELECT id FROM streams WHERE id = $1', ['1'], 100);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).not.toContain('Slow postgres query');
  });

  it('logs a warn when query exceeds threshold', async () => {
    const pool = makePool(60);
    await query(pool, 'SELECT id FROM streams WHERE id = $1', ['1'], 50);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('Slow postgres query');
  });

  it('log entry contains query_hash, duration_ms, table_hint — never raw SQL', async () => {
    const pool = makePool(60);
    const sql = 'SELECT id FROM streams WHERE id = $1';
    await query(pool, sql, ['secret-param'], 50);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    const record = JSON.parse(logged.trim().split('\n').find((l) => l.includes('Slow'))!);
    expect(record.query_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(record.duration_ms).toBeGreaterThanOrEqual(50);
    expect(record.table_hint).toBe('streams');
    expect(logged).not.toContain(sql);
    expect(logged).not.toContain('secret-param');
  });

  it('does not log when threshold is 0 (disabled)', async () => {
    const pool = makePool(60);
    await query(pool, 'SELECT id FROM streams', [], 0);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).not.toContain('Slow postgres query');
  });

  it('query_hash is deterministic for the same SQL', async () => {
    const pool1 = makePool(60);
    const pool2 = makePool(60);
    const sql = 'SELECT id FROM streams WHERE id = $1';
    await query(pool1, sql, ['a'], 50);
    await query(pool2, sql, ['b'], 50);
    const lines = warnSpy.mock.calls
      .map((c) => String(c[0]).trim())
      .filter((l) => l.includes('Slow postgres query'))
      .map((l) => JSON.parse(l));
    expect(lines[0].query_hash).toBe(lines[1]?.query_hash);
  });

  it('query_hash differs for different SQL', async () => {
    const pool1 = makePool(60);
    const pool2 = makePool(60);
    await query(pool1, 'SELECT id FROM streams', [], 50);
    await query(pool2, 'SELECT id FROM contract_events', [], 50);
    const lines = warnSpy.mock.calls
      .map((c) => String(c[0]).trim())
      .filter((l) => l.includes('Slow postgres query'))
      .map((l) => JSON.parse(l));
    expect(lines[0].query_hash).not.toBe(lines[1]?.query_hash);
  });

  it('reads threshold from SLOW_QUERY_THRESHOLD_MS env when not passed explicitly', async () => {
    process.env['SLOW_QUERY_THRESHOLD_MS'] = '50';
    const pool = makePool(60);
    await query(pool, 'SELECT id FROM streams');
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('Slow postgres query');
    delete process.env['SLOW_QUERY_THRESHOLD_MS'];
  });
});
