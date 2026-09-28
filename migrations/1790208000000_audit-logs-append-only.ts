/**
 * Migration: enforce append-only audit_logs at the storage layer.
 *
 * Problem (issue #1481): the append-only audit trail was enforced only in
 * application code (`src/lib/auditLog.ts` never issues UPDATE/DELETE, and
 * `auditRepository.ts` is read-only). Any future code path — or any SQL
 * console — could UPDATE or DELETE audit rows without the database refusing.
 *
 * Fix (defence in depth, two independent layers):
 *
 *  1. Least-privilege grants. Two NOLOGIN roles are provisioned:
 *       - `fluxora_app`       — the application role: SELECT + INSERT only.
 *                               No UPDATE, DELETE, or TRUNCATE on audit_logs.
 *       - `fluxora_retention` — the retention role: SELECT + INSERT + DELETE.
 *                               No UPDATE. Only this role may purge expired
 *                               audit rows (see `PURGEABLE_RETENTION_SCHEDULE`).
 *     Both roles get USAGE/SELECT on the `audit_seq` sequence so INSERTs that
 *     rely on the `nextval('audit_seq')` default keep working.
 *
 *  2. Row-level trigger. The table owner (e.g. `indexer_user`, which runs
 *     migrations and — in single-role deployments — the app itself) bypasses
 *     GRANT checks, so grants alone cannot stop an owner session. The
 *     `audit_logs_no_update_delete` trigger fires BEFORE UPDATE OR DELETE for
 *     *every* role, including the owner:
 *       - UPDATE is always rejected (no legitimate update path exists).
 *       - DELETE is rejected unless it runs as `fluxora_retention` or the
 *         enclosing transaction explicitly opts in with
 *         `SET LOCAL app.allow_audit_delete = 'on'`. The retention purge job
 *         sets that flag only for the `audit_logs` rule inside its short
 *         batch transaction (see `src/jobs/retentionPurge.ts`); normal
 *         request paths never set it, so accidental or malicious deletes
 *         fail at the database with SQLSTATE P0001 (raise_exception).
 *
 * Idempotency: every statement is guarded (DO blocks for roles, DROP/CREATE
 * for the function and trigger, REVOKE/GRANT are naturally idempotent) so
 * the migration is safe to re-run and safe against partially-applied state.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/** Application role: may append and read audit rows, never mutate them. */
export const AUDIT_APP_ROLE = 'fluxora_app';
/** Retention role: the only role permitted to delete expired audit rows. */
export const AUDIT_RETENTION_ROLE = 'fluxora_retention';
/** Guard function and trigger enforcing append-only. */
export const AUDIT_GUARD_FUNCTION = 'audit_logs_prevent_mutation';
export const AUDIT_GUARD_TRIGGER = 'audit_logs_no_update_delete';
/** Transaction-local opt-in flag the retention job sets for audit purges. */
export const AUDIT_DELETE_BYPASS_SETTING = 'app.allow_audit_delete';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ── 1. Provision least-privilege roles (idempotent) ──────────────────────
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUDIT_APP_ROLE}') THEN
        CREATE ROLE ${AUDIT_APP_ROLE} WITH NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUDIT_RETENTION_ROLE}') THEN
        CREATE ROLE ${AUDIT_RETENTION_ROLE} WITH NOLOGIN;
      END IF;
    END
    $$;
  `);

  // ── 2. Grants: app role is append-only, retention role may also delete ───
  // REVOKE first so a previously over-privileged role converges to least
  // privilege; GRANTs below are the complete allow-list.
  pgm.sql(`REVOKE ALL ON TABLE audit_logs FROM PUBLIC;`);
  pgm.sql(`REVOKE ALL ON TABLE audit_logs FROM ${AUDIT_APP_ROLE};`);
  pgm.sql(`REVOKE ALL ON TABLE audit_logs FROM ${AUDIT_RETENTION_ROLE};`);

  pgm.sql(`GRANT SELECT, INSERT ON TABLE audit_logs TO ${AUDIT_APP_ROLE};`);
  pgm.sql(`GRANT SELECT, INSERT, DELETE ON TABLE audit_logs TO ${AUDIT_RETENTION_ROLE};`);

  // INSERTs use the nextval('audit_seq') column default — both writers need it.
  pgm.sql(
    `GRANT USAGE, SELECT ON SEQUENCE audit_seq TO ${AUDIT_APP_ROLE}, ${AUDIT_RETENTION_ROLE};`,
  );

  // ── 3. Storage-layer guard: trigger fires for ALL roles incl. owner ──────
  pgm.sql(`
    CREATE OR REPLACE FUNCTION ${AUDIT_GUARD_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $func$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'audit_logs is append-only: UPDATE not permitted'
          USING ERRCODE = 'P0001';
      ELSIF TG_OP = 'DELETE' THEN
        -- Retention path: dedicated role, or an explicit per-transaction
        -- opt-in used by the retention purge job (SET LOCAL
        -- app.allow_audit_delete = 'on'). TRUNCATE is not reachable here —
        -- it requires the TRUNCATE privilege, which neither role holds.
        IF current_user = '${AUDIT_RETENTION_ROLE}' THEN
          RETURN OLD;
        END IF;
        IF current_setting('${AUDIT_DELETE_BYPASS_SETTING}', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_logs is append-only: DELETE not permitted (use ${AUDIT_RETENTION_ROLE} role or SET LOCAL ${AUDIT_DELETE_BYPASS_SETTING} = ''on'' in a retention transaction)'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NULL;
    END;
    $func$;
  `);

  pgm.sql(`DROP TRIGGER IF EXISTS ${AUDIT_GUARD_TRIGGER} ON audit_logs;`);
  pgm.sql(`
    CREATE TRIGGER ${AUDIT_GUARD_TRIGGER}
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION ${AUDIT_GUARD_FUNCTION}();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS ${AUDIT_GUARD_TRIGGER} ON audit_logs;`);
  pgm.sql(`DROP FUNCTION IF EXISTS ${AUDIT_GUARD_FUNCTION}();`);
  // Roles and grants are intentionally retained on rollback: other objects or
  // environments may reference them, and leaving least-privilege grants in
  // place is the safe direction.
}
