/**
 * Migration test: audit_logs is append-only at the storage layer.
 *
 * Covers issue #1481:
 *  - the `audit_logs` table denies UPDATE and DELETE to the application role
 *  - attempts fail at the database, not only in application code
 *  - the grant configuration is asserted by this migration test
 *  - retention deletion, if permitted, uses a separate role
 *
 * Two layers, matching tests/db/* conventions in this repo:
 *
 *  1. Offline contract (always runs, no DB required): executes the migration's
 *     `up()` against a recording `pgm` double and asserts the emitted DDL
 *     provisions the app/retention roles, grants the app role only
 *     SELECT+INSERT, grants the retention role SELECT+INSERT+DELETE (and never
 *     UPDATE), and installs a BEFORE UPDATE OR DELETE trigger whose function
 *     rejects UPDATE unconditionally and DELETE for everyone except the
 *     retention role / an explicit retention-transaction opt-in.
 *
 *  2. Live enforcement (runs when DATABASE_URL is set): inserts a probe row,
 *     then asserts UPDATE and DELETE without the retention opt-in are refused
 *     by the database itself (SQLSTATE 42501 permission-denied or P0001
 *     raise_exception from the guard trigger). Cleans up via the
 *     retention-transaction opt-in (`SET LOCAL app.allow_audit_delete`).
 *
 * Local run:
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/auditLogs.appendOnly.test.ts
 */

import { describe, it, expect } from 'vitest';
import pg from 'pg';

import {
  up,
  down,
  AUDIT_APP_ROLE,
  AUDIT_RETENTION_ROLE,
  AUDIT_GUARD_FUNCTION,
  AUDIT_GUARD_TRIGGER,
  AUDIT_DELETE_BYPASS_SETTING,
} from '../../migrations/1790208000000_audit-logs-append-only.js';

// ── Offline contract ──────────────────────────────────────────────────────────

/** Minimal MigrationBuilder double that records every `sql()` call. */
function recordingPgm() {
  const statements: string[] = [];
  return {
    statements,
    sql: (stmt: string) => {
      statements.push(stmt);
    },
  };
}

function joinedStatements(pgm: ReturnType<typeof recordingPgm>): string {
  return pgm.statements.join('\n');
}

describe('audit_logs append-only migration (offline contract)', () => {
  it('provisions separate application and retention roles', async () => {
    const pgm = recordingPgm();
    await up(pgm as never);
    const sql = joinedStatements(pgm);
    expect(sql).toContain(`CREATE ROLE ${AUDIT_APP_ROLE}`);
    expect(sql).toContain(`CREATE ROLE ${AUDIT_RETENTION_ROLE}`);
    expect(AUDIT_APP_ROLE).not.toBe(AUDIT_RETENTION_ROLE);
  });

  it('denies UPDATE and DELETE to the application role (grants only SELECT, INSERT)', async () => {
    const pgm = recordingPgm();
    await up(pgm as never);
    const sql = joinedStatements(pgm);

    // Convergence first: strip any previously granted write privileges.
    expect(sql).toMatch(/REVOKE ALL ON TABLE audit_logs FROM PUBLIC/);
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON TABLE audit_logs FROM ${AUDIT_APP_ROLE}`));

    // The app role's allow-list must be exactly SELECT + INSERT.
    expect(sql).toMatch(
      new RegExp(`GRANT SELECT, INSERT ON TABLE audit_logs TO ${AUDIT_APP_ROLE}`),
    );
    const appGrants = pgm.statements.filter((s) => s.includes(`TO ${AUDIT_APP_ROLE}`));
    for (const grant of appGrants) {
      if (/GRANT .* ON TABLE audit_logs/.test(grant)) {
        expect(grant).not.toMatch(/UPDATE/);
        expect(grant).not.toMatch(/DELETE/);
        expect(grant).not.toMatch(/TRUNCATE/);
      }
    }
  });

  it('grants DELETE — but never UPDATE — to the separate retention role', async () => {
    const pgm = recordingPgm();
    await up(pgm as never);
    const sql = joinedStatements(pgm);

    expect(sql).toMatch(
      new RegExp(
        `GRANT SELECT, INSERT, DELETE ON TABLE audit_logs TO ${AUDIT_RETENTION_ROLE}`,
      ),
    );
    const retentionGrants = pgm.statements.filter(
      (s) => s.includes(`TO ${AUDIT_RETENTION_ROLE}`) && s.includes('audit_logs'),
    );
    expect(retentionGrants.length).toBeGreaterThan(0);
    for (const grant of retentionGrants) {
      expect(grant).not.toMatch(/UPDATE/);
    }
  });

  it('installs a BEFORE UPDATE OR DELETE guard trigger that rejects mutations', async () => {
    const pgm = recordingPgm();
    await up(pgm as never);
    const sql = joinedStatements(pgm);

    // Guard function: UPDATE always raises; DELETE raises unless the session
    // is the retention role or carries the retention-transaction opt-in.
    expect(sql).toContain(`FUNCTION ${AUDIT_GUARD_FUNCTION}()`);
    expect(sql).toMatch(/TG_OP = 'UPDATE'/);
    expect(sql).toMatch(/TG_OP = 'DELETE'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'audit_logs is append-only: UPDATE not permitted'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'audit_logs is append-only: DELETE not permitted/);
    expect(sql).toContain(`current_user = '${AUDIT_RETENTION_ROLE}'`);
    expect(sql).toContain(AUDIT_DELETE_BYPASS_SETTING);

    // Trigger wiring: fires before every UPDATE or DELETE row mutation.
    expect(sql).toMatch(
      new RegExp(
        `CREATE TRIGGER ${AUDIT_GUARD_TRIGGER}[\\s\\S]*BEFORE UPDATE OR DELETE ON audit_logs`,
      ),
    );
    expect(sql).toContain(`EXECUTE FUNCTION ${AUDIT_GUARD_FUNCTION}()`);
  });

  it('down() removes the trigger and function but retains least-privilege roles', async () => {
    const pgm = recordingPgm();
    await down(pgm as never);
    const sql = joinedStatements(pgm);
    expect(sql).toMatch(
      new RegExp(`DROP TRIGGER IF EXISTS ${AUDIT_GUARD_TRIGGER} ON audit_logs`),
    );
    expect(sql).toMatch(new RegExp(`DROP FUNCTION IF EXISTS ${AUDIT_GUARD_FUNCTION}`));
    expect(sql).not.toContain(`DROP ROLE`);
  });
});

// ── Live enforcement ──────────────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

/** Refused writes surface as permission-denied or the trigger's raise_exception. */
function isRefused(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '42501' || code === 'P0001';
}

/**
 * Connect to the live database, skipping the test when Postgres is
 * unreachable (offline / CI without Postgres). Mirrors the repo convention
 * that DB-backed tests skip automatically without a database.
 */
async function connectOrSkip(ctx: { skip: (note?: string) => never }): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    ctx.skip('postgres unreachable — skipping live enforcement test');
  }
}

describe.skipIf(!isLiveDb)('audit_logs append-only (live DB enforcement)', () => {
  it('refuses UPDATE and DELETE at the database; retention opt-in deletes', async (ctx) => {
    const client = await connectOrSkip(ctx);
    try {
      const tableCheck = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = 'audit_logs'
         ) AS exists`,
      );
      if (!tableCheck.rows[0]?.exists) {
        throw new Error('audit_logs table not found — run migrations before enforcement tests');
      }

      const triggerCheck = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_trigger WHERE tgname = $1
         ) AS exists`,
        [AUDIT_GUARD_TRIGGER],
      );
      if (!triggerCheck.rows[0]?.exists) {
        throw new Error(
          `guard trigger ${AUDIT_GUARD_TRIGGER} not found — run migrations before enforcement tests`,
        );
      }

      // Probe row via the normal append path (INSERT must keep working).
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO audit_logs
           (timestamp, action, resource_type, resource_id, correlation_id, meta)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          new Date().toISOString(),
          'AUDIT_EXPORTED',
          'append-only-probe',
          `probe-${Date.now()}`,
          null,
          JSON.stringify({ probe: true }),
        ],
      );
      const probeId = inserted.rows[0]?.id;
      expect(probeId).toBeDefined();

      try {
        // 1. UPDATE as the application would issue it — must be refused
        //    by the database itself, not by application code.
        await expect(
          client.query(`UPDATE audit_logs SET action = $1 WHERE id = $2`, [
            'MUTATED',
            probeId,
          ]),
        ).rejects.toMatchObject({ code: 'P0001' });

        // 2. DELETE as the application would issue it — must be refused too.
        const deleteErr = await client
          .query(`DELETE FROM audit_logs WHERE id = $1`, [probeId])
          .then(
            () => null,
            (err: unknown) => err,
          );
        expect(deleteErr).not.toBeNull();
        expect(isRefused(deleteErr)).toBe(true);

        // 3. The row is still there — the refused writes changed nothing.
        const stillThere = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM audit_logs WHERE id = $1`,
          [probeId],
        );
        expect(stillThere.rows[0]?.count).toBe('1');
      } finally {
        // 4. Retention path: the per-transaction opt-in deletes the probe row.
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ${AUDIT_DELETE_BYPASS_SETTING} = 'on'`);
          await client.query(`DELETE FROM audit_logs WHERE id = $1`, [probeId]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }

      const gone = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_logs WHERE id = $1`,
        [probeId],
      );
      expect(gone.rows[0]?.count).toBe('0');
    } finally {
      await client.end();
    }
  });

  it('grants the application role no UPDATE/DELETE and the retention role DELETE', async (ctx) => {
    const client = await connectOrSkip(ctx);
    try {
      const grants = await client.query<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type
           FROM information_schema.role_table_grants
          WHERE table_name = 'audit_logs'
            AND grantee IN ($1, $2)`,
        [AUDIT_APP_ROLE, AUDIT_RETENTION_ROLE],
      );
      const byRole = new Map<string, Set<string>>();
      for (const row of grants.rows) {
        if (!byRole.has(row.grantee)) byRole.set(row.grantee, new Set());
        byRole.get(row.grantee)!.add(row.privilege_type);
      }

      const appPrivs = byRole.get(AUDIT_APP_ROLE) ?? new Set<string>();
      expect(appPrivs.has('SELECT')).toBe(true);
      expect(appPrivs.has('INSERT')).toBe(true);
      expect(appPrivs.has('UPDATE')).toBe(false);
      expect(appPrivs.has('DELETE')).toBe(false);

      const retentionPrivs = byRole.get(AUDIT_RETENTION_ROLE) ?? new Set<string>();
      expect(retentionPrivs.has('SELECT')).toBe(true);
      expect(retentionPrivs.has('INSERT')).toBe(true);
      expect(retentionPrivs.has('DELETE')).toBe(true);
      expect(retentionPrivs.has('UPDATE')).toBe(false);
    } finally {
      await client.end();
    }
  });
});
