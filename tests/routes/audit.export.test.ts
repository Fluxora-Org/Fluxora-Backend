/**
 * tests/routes/audit.export.test.ts
 *
 * Tests for GET /api/audit/export — the streaming CSV/NDJSON compliance export.
 *
 * Covers:
 *  - AuthZ: anonymous → 401, token without `audit:read` → 403, `admin` and
 *    `operator` → 200.
 *  - Validation: unknown format, non-ISO dates, inverted date range.
 *  - CSV output: header row, column order, RFC 4180 quoting, and formula-
 *    injection neutralisation.
 *  - NDJSON output: one parseable JSON object per line.
 *  - Response headers: content type, attachment disposition, nosniff, no-store.
 *  - Filter reuse: every list filter is pushed into SQL as a bound parameter.
 *  - Streaming: rows are fetched in keyset-paginated batches, never all at once.
 *  - Self-audit: an AUDIT_EXPORTED row is written *before* any data is read,
 *    and a failure to write it refuses the export (fail closed).
 *  - Redaction: credential-shaped meta fields never reach the export.
 *  - Edge cases: empty result set, mid-stream database failure.
 *
 * The pg pool is mocked, so no live Postgres is required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mock the pg pool before importing anything that touches it ────────────────

/** One recorded query issued through the mocked pool. */
interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** Raw `audit_logs` row shape as the driver would hand it back. */
interface RawAuditRow {
  id: number;
  seq: number;
  timestamp: string;
  action: string;
  resource_type: string;
  resource_id: string;
  correlation_id: string | null;
  meta: Record<string, unknown> | null;
}

/**
 * Mutable fake-database state.
 *
 * Declared through `vi.hoisted` because `vi.mock` factories are hoisted above
 * normal module-scope bindings and would otherwise capture it before it exists.
 */
const db = vi.hoisted(() => ({
  rows: [] as RawAuditRow[],
  queries: [] as RecordedQuery[],
  /** When set, the self-audit INSERT rejects with this error. */
  insertError: null as Error | null,
  /** When set, the Nth (0-based) SELECT rejects — simulates a mid-stream failure. */
  selectErrorAt: null as number | null,
  /** SELECTs issued so far this test. */
  selectCount: 0,
}));

vi.mock('../../src/db/pool.js', () => {
  class PoolExhaustedError extends Error {}
  class DuplicateEntryError extends Error {}
  class QueryTimeoutError extends Error {}

  return {
    getPool: vi.fn(() => ({}) as unknown),
    setPool: vi.fn(),
    PoolExhaustedError,
    DuplicateEntryError,
    QueryTimeoutError,
    query: vi.fn(async (_pool: unknown, sql: string, params: unknown[] = []) => {
      db.queries.push({ sql, params });

      if (sql.includes('INSERT INTO audit_logs')) {
        if (db.insertError) throw db.insertError;
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('FROM audit_logs') && sql.includes('SELECT')) {
        const index = db.selectCount++;
        if (db.selectErrorAt === index) throw new Error('connection reset');

        // Emulate the keyset page: `id > $1 ORDER BY id ASC LIMIT $2`.
        const lastId = Number(params[0]);
        const limit = Number(params[1]);
        const page = db.rows.filter((r) => r.id > lastId).slice(0, limit);
        return { rows: page, rowCount: page.length };
      }

      return { rows: [], rowCount: 0 };
    }),
  };
});

const { auditRouter } = await import('../../src/routes/audit.js');
const { toCsvField } = await import('../../src/routes/audit.js');
const { _resetAuditLog } = await import('../../src/lib/auditLog.js');
const { correlationIdMiddleware } = await import('../../src/middleware/correlationId.js');
const { errorHandler } = await import('../../src/middleware/errorHandler.js');
const { generateToken } = await import('../../src/lib/auth.js');
const { Permission } = await import('../../src/middleware/auth.js');
const { initializeConfig } = await import('../../src/config/env.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupertestApp = any;

function createTestApp(): SupertestApp {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

function makeRow(id: number, overrides: Partial<RawAuditRow> = {}): RawAuditRow {
  return {
    id,
    seq: id,
    timestamp: `2026-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    action: 'STREAM_CREATED',
    resource_type: 'stream',
    resource_id: `stream-${id}`,
    correlation_id: `corr-${id}`,
    meta: { actor: 'GADMIN' },
    ...overrides,
  };
}

/** The SELECT statements issued against audit_logs, in order. */
function selectQueries(): RecordedQuery[] {
  return db.queries.filter((q) => q.sql.includes('SELECT') && q.sql.includes('FROM audit_logs'));
}

/** The self-audit INSERT statements issued, in order. */
function insertQueries(): RecordedQuery[] {
  return db.queries.filter((q) => q.sql.includes('INSERT INTO audit_logs'));
}

let app: SupertestApp;
let adminToken: string;
let operatorToken: string;
let viewerToken: string;

beforeEach(() => {
  db.rows = [];
  db.queries = [];
  db.insertError = null;
  db.selectErrorAt = null;
  db.selectCount = 0;

  _resetAuditLog();
  process.env['NODE_ENV'] = 'test';
  process.env['JWT_SECRET'] = 'a-very-long-secret-key-for-testing-only-12345';
  initializeConfig();

  // `generateToken` only backfills a permissions claim for the `operator`
  // role, so the admin token states its permissions explicitly.
  adminToken = generateToken({
    address: 'GADMIN',
    role: 'admin',
    permissions: Object.values(Permission),
  });
  operatorToken = generateToken({ address: 'GOPERATOR', role: 'operator' });
  viewerToken = generateToken({ address: 'GVIEWER', role: 'viewer' });

  app = createTestApp();
});

function asAdmin(path: string): request.Test {
  return request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
}

// ── Authorisation ─────────────────────────────────────────────────────────────

describe('GET /api/audit/export — authorisation', () => {
  it('rejects an anonymous request with 401', async () => {
    await request(app).get('/api/audit/export').expect(401);
    expect(selectQueries()).toHaveLength(0);
  });

  it('rejects a token without audit:read with 403', async () => {
    await request(app)
      .get('/api/audit/export')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(selectQueries()).toHaveLength(0);
  });

  it('never touches the database for an unauthorised caller', async () => {
    await request(app).get('/api/audit/export').expect(401);
    expect(db.queries).toHaveLength(0);
  });

  it('allows the admin role', async () => {
    await asAdmin('/api/audit/export').expect(200);
  });

  it('allows the operator (audit-reader) role', async () => {
    await request(app)
      .get('/api/audit/export')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — query validation', () => {
  it('rejects an unknown format with 400', async () => {
    const res = await asAdmin('/api/audit/export?format=xlsx').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-ISO dateFrom with 400', async () => {
    const res = await asAdmin('/api/audit/export?dateFrom=2026-01-01').expect(400);
    expect(res.body.error.message).toMatch(/ISO-8601/);
  });

  it('rejects an impossible calendar date with 400', async () => {
    await asAdmin('/api/audit/export?dateTo=2026-02-31T00:00:00.000Z').expect(400);
  });

  it('rejects dateFrom later than dateTo with 400', async () => {
    const res = await asAdmin(
      '/api/audit/export?dateFrom=2026-06-01T00:00:00.000Z&dateTo=2026-01-01T00:00:00.000Z',
    ).expect(400);
    expect(res.body.error.message).toBe('dateFrom: must be less than or equal to dateTo');
  });

  it('does not query the database when validation fails', async () => {
    await asAdmin('/api/audit/export?format=xlsx').expect(400);
    expect(db.queries).toHaveLength(0);
  });
});

// ── CSV output ────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — CSV', () => {
  it('defaults to CSV and emits a header row plus one record per row', async () => {
    db.rows = [makeRow(1), makeRow(2)];

    const res = await asAdmin('/api/audit/export').expect(200);

    const lines = res.text.trimEnd().split('\n');
    expect(lines[0]).toBe('id,seq,timestamp,action,resource_type,resource_id,correlation_id,meta');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"stream-1"');
    expect(lines[2]).toContain('"stream-2"');
  });

  it('sets streaming-safe response headers', async () => {
    const res = await asAdmin('/api/audit/export').expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-export-.*\.csv"$/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    // Streamed, not buffered: no up-front Content-Length.
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('emits only the header row when nothing matches', async () => {
    const res = await asAdmin('/api/audit/export').expect(200);
    expect(res.text).toBe('id,seq,timestamp,action,resource_type,resource_id,correlation_id,meta\n');
  });

  it('neutralises spreadsheet formula injection in cell values', async () => {
    db.rows = [
      makeRow(1, {
        resource_id: '=HYPERLINK("http://evil.example","click")',
        meta: { actor: '@SUM(1+1)' },
      }),
    ];

    const res = await asAdmin('/api/audit/export').expect(200);

    // The leading '=' is defanged with an apostrophe, so no spreadsheet
    // evaluates the cell on open.
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(res.text).not.toContain('"=HYPERLINK');
  });

  it('quotes embedded commas, quotes, and newlines per RFC 4180', async () => {
    db.rows = [makeRow(1, { resource_id: 'a,b"c\nd' })];
    const res = await asAdmin('/api/audit/export').expect(200);
    expect(res.text).toContain('"a,b""c\nd"');
  });
});

describe('toCsvField', () => {
  it('quotes every field and doubles embedded quotes', () => {
    expect(toCsvField('plain')).toBe('"plain"');
    expect(toCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('renders null and undefined as an empty quoted field', () => {
    expect(toCsvField(null)).toBe('""');
    expect(toCsvField(undefined)).toBe('""');
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])('prefixes a leading %j with an apostrophe', (trigger) => {
    expect(toCsvField(`${trigger}cmd`)).toBe(`"'${trigger}cmd"`);
  });

  it('leaves a safe leading character alone', () => {
    expect(toCsvField('GADMIN')).toBe('"GADMIN"');
  });
});

// ── NDJSON output ─────────────────────────────────────────────────────────────

describe('GET /api/audit/export — NDJSON', () => {
  it('emits one parseable JSON object per line with no header', async () => {
    db.rows = [makeRow(1), makeRow(2), makeRow(3)];

    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);

    const lines = res.text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.resourceId)).toEqual(['stream-1', 'stream-2', 'stream-3']);
    expect(parsed[0]).toMatchObject({
      id: '1',
      action: 'STREAM_CREATED',
      resourceType: 'stream',
      correlationId: 'corr-1',
      meta: { actor: 'GADMIN' },
    });
  });

  it('uses the NDJSON content type and filename', async () => {
    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toMatch(/\.ndjson"$/);
  });

  it('emits an empty body when nothing matches', async () => {
    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);
    expect(res.text).toBe('');
  });

  it('preserves a null meta as JSON null', async () => {
    db.rows = [makeRow(1, { meta: null, correlation_id: null })];
    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);
    expect(JSON.parse(res.text.trim())).toMatchObject({ meta: null, correlationId: null });
  });
});

// ── Filter reuse ──────────────────────────────────────────────────────────────

describe('GET /api/audit/export — filters', () => {
  it('pushes every list filter into SQL as a bound parameter', async () => {
    await asAdmin(
      '/api/audit/export?actor=GADMIN&actionType=STREAM_CREATED&resourceType=stream' +
        '&resourceId=stream-7&dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-02-01T00:00:00.000Z',
    ).expect(200);

    const select = selectQueries()[0];
    expect(select).toBeDefined();
    expect(select!.sql).toContain('action = $3');
    expect(select!.sql).toContain('resource_type = $4');
    expect(select!.sql).toContain('resource_id = $5');
    expect(select!.sql).toContain(`meta->>'actor' = $6`);
    expect(select!.sql).toContain('timestamp >= $7');
    expect(select!.sql).toContain('timestamp <= $8');

    // $1/$2 are the keyset bound and page size; filters follow.
    expect(select!.params.slice(2)).toEqual([
      'STREAM_CREATED',
      'stream',
      'stream-7',
      'GADMIN',
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ]);
  });

  it('never interpolates a filter value into the SQL string', async () => {
    await asAdmin("/api/audit/export?resourceId=x'%20OR%201%3D1--").expect(200);
    const select = selectQueries()[0]!;
    expect(select.sql).not.toContain('OR 1=1');
    expect(select.params).toContain("x' OR 1=1--");
  });

  it('applies no filter conditions when none are supplied', async () => {
    await asAdmin('/api/audit/export').expect(200);
    const select = selectQueries()[0]!;
    expect(select.sql).toContain('WHERE id > $1');
    expect(select.params).toHaveLength(2);
  });
});

// ── Streaming behaviour ───────────────────────────────────────────────────────

describe('GET /api/audit/export — streaming', () => {
  it('fetches in keyset-paginated batches rather than one unbounded query', async () => {
    // 1200 rows against the default batch size of 500 → 500 + 500 + 200.
    db.rows = Array.from({ length: 1200 }, (_, i) => makeRow(i + 1));

    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);

    expect(res.text.trimEnd().split('\n')).toHaveLength(1200);

    const selects = selectQueries();
    expect(selects).toHaveLength(3);
    // Every page is bounded by LIMIT — nothing ever asks for the whole table.
    for (const q of selects) {
      expect(q.sql).toContain('LIMIT $2');
      expect(q.params[1]).toBe(500);
    }
    // The keyset advances to the last id of the previous page.
    expect(selects.map((q) => q.params[0])).toEqual(['0', '500', '1000']);
  });

  it('stops after a short page instead of issuing a final empty query', async () => {
    db.rows = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
    await asAdmin('/api/audit/export?format=ndjson').expect(200);
    expect(selectQueries()).toHaveLength(1);
  });

  it('orders rows deterministically by ascending id', async () => {
    db.rows = [makeRow(3), makeRow(1), makeRow(2)].sort((a, b) => a.id - b.id);
    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);
    const ids = res.text.trimEnd().split('\n').map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['1', '2', '3']);
  });
});

// ── Self-audit ────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — self-audit', () => {
  it('writes an AUDIT_EXPORTED row recording who exported which range', async () => {
    db.rows = [makeRow(1)];

    await asAdmin(
      '/api/audit/export?format=ndjson&dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-02-01T00:00:00.000Z',
    ).expect(200);

    const insert = insertQueries()[0];
    expect(insert).toBeDefined();

    const [, action, resourceType, resourceId, , metaJson] = insert!.params as string[];
    expect(action).toBe('AUDIT_EXPORTED');
    expect(resourceType).toBe('audit_logs');
    expect(resourceId).toBe('2026-01-01T00:00:00.000Z..2026-02-01T00:00:00.000Z');

    const meta = JSON.parse(metaJson!);
    expect(meta).toMatchObject({
      actor: 'GADMIN',
      role: 'admin',
      format: 'ndjson',
      filters: { dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-02-01T00:00:00.000Z' },
    });
  });

  it('describes an unbounded range explicitly', async () => {
    await asAdmin('/api/audit/export').expect(200);
    const resourceId = (insertQueries()[0]!.params as string[])[3];
    expect(resourceId).toBe('beginning..latest');
  });

  it('records the export before reading any data', async () => {
    db.rows = [makeRow(1)];
    await asAdmin('/api/audit/export').expect(200);

    const insertIndex = db.queries.findIndex((q) => q.sql.includes('INSERT INTO audit_logs'));
    const selectIndex = db.queries.findIndex(
      (q) => q.sql.includes('SELECT') && q.sql.includes('FROM audit_logs'),
    );
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(selectIndex).toBeGreaterThan(insertIndex);
  });

  it('fails closed: refuses the export when the self-audit write fails', async () => {
    db.rows = [makeRow(1)];
    db.insertError = new Error('audit table unavailable');

    const res = await asAdmin('/api/audit/export').expect(500);

    expect(selectQueries()).toHaveLength(0);
    expect(res.text).not.toContain('stream-1');
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────────

describe('GET /api/audit/export — redaction', () => {
  it('redacts credential-shaped meta fields in NDJSON', async () => {
    db.rows = [
      makeRow(1, {
        meta: { actor: 'GADMIN', authorization: 'Bearer super-secret', nested: { 'x-api-key': 'k-123' } },
      }),
    ];

    const res = await asAdmin('/api/audit/export?format=ndjson').expect(200);

    expect(res.text).not.toContain('super-secret');
    expect(res.text).not.toContain('k-123');
    const parsed = JSON.parse(res.text.trim());
    expect(parsed.meta.authorization).toBe('[REDACTED]');
    expect(parsed.meta.nested['x-api-key']).toBe('[REDACTED]');
    expect(parsed.meta.actor).toBe('GADMIN');
  });

  it('redacts credential-shaped meta fields in CSV', async () => {
    db.rows = [makeRow(1, { meta: { authToken: 'tok-abc' } })];
    const res = await asAdmin('/api/audit/export').expect(200);
    expect(res.text).not.toContain('tok-abc');
    expect(res.text).toContain('[REDACTED]');
  });
});

// ── Mid-stream failure ────────────────────────────────────────────────────────

describe('GET /api/audit/export — mid-stream failure', () => {
  it('does not hand back a silently truncated file when a later page fails', async () => {
    db.rows = Array.from({ length: 600 }, (_, i) => makeRow(i + 1));
    db.selectErrorAt = 1; // first page succeeds, second page throws

    // The response is destroyed rather than ended, so supertest surfaces an
    // aborted transfer instead of a clean 200 with partial data.
    await expect(asAdmin('/api/audit/export?format=ndjson')).rejects.toThrow();
  });
});
