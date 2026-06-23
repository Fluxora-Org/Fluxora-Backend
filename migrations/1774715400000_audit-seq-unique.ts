/**
 * Migration: enforce a UNIQUE constraint on audit_logs.seq
 *
 * Problem: seq was populated by a process-local counter (++seq in auditLog.ts).
 * Under concurrent admin writes two connections could race and insert the same
 * value, breaking ordering and tamper-evidence guarantees.
 *
 * Fix:
 *  1. Create a dedicated Postgres sequence (audit_seq) that is the single
 *     source of truth for seq values — nextval() is atomic.
 *  2. Backfill any existing rows that share a seq value by reassigning them
 *     from the new sequence before adding the constraint.
 *  3. Add a UNIQUE constraint on audit_logs.seq.
 *  4. Set the column default to nextval('audit_seq') so inserts that omit seq
 *     (the new write path in auditLog.ts) get a correct value automatically.
 *
 * Conflict behaviour: the DB will raise a unique-violation (PG 23505) on any
 * INSERT that supplies a seq already in use.  The pool helper in pool.ts
 * converts that to DuplicateEntryError, which the caller must handle.
 * The recommended approach is to omit seq entirely and rely on the default.
 *
 * down() removes the constraint, default, and sequence — restoring the old
 * schema exactly.
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Create the authoritative sequence.
  pgm.createSequence('audit_seq', { ifNotExists: true });

  // 2. Backfill: reassign seq for any rows that have duplicate values so the
  //    upcoming UNIQUE constraint does not fail on existing data.
  //    We do this by rewriting every row's seq from the sequence in id order,
  //    which preserves relative ordering while guaranteeing uniqueness.
  pgm.sql(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
      FROM audit_logs
    )
    UPDATE audit_logs al
    SET seq = ranked.rn
    FROM ranked
    WHERE al.id = ranked.id
  `);

  // Advance the sequence past the highest seq we just wrote so future
  // nextval() calls do not collide with back-filled values.
  pgm.sql(`
    SELECT setval('audit_seq', COALESCE((SELECT MAX(seq) FROM audit_logs), 0) + 1, false)
  `);

  // 3. Attach the sequence as the column default.
  pgm.alterColumn('audit_logs', 'seq', {
    default: pgm.func("nextval('audit_seq')"),
  });

  // 4. Add the UNIQUE constraint.
  pgm.addConstraint('audit_logs', 'audit_logs_seq_unique', { unique: ['seq'] });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('audit_logs', 'audit_logs_seq_unique');
  pgm.alterColumn('audit_logs', 'seq', { default: null });
  pgm.dropSequence('audit_seq', { ifExists: true });
}
