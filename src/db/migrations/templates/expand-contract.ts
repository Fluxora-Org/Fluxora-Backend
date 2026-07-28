/**
 * Expand/Contract Migration Template — Zero-Downtime Schema Changes
 *
 * This template demonstrates the three-phase expand/contract pattern for
 * performing breaking schema changes (column renames, type changes, etc.)
 * without service interruption during rolling deployments.
 *
 * ─── Pattern Overview ───────────────────────────────────────────────────
 *
 *   Phase 1 — EXPAND:    Add the new column alongside the old one.
 *                         Deploy application code that writes to BOTH
 *                         columns but reads from the OLD one.
 *
 *   Phase 2 — BACKFILL:  Copy data from the old column to the new column
 *                         for all existing rows. Deploy application code
 *                         that reads from the NEW column.
 *
 *   Phase 3 — CONTRACT:  Drop the old column once all application nodes
 *                         have been updated and the old column is no
 *                         longer referenced.
 *
 * ─── Safety Rules ───────────────────────────────────────────────────────
 *
 *   1. Each phase is a SEPARATE migration file so it can be deployed,
 *      verified, and rolled back independently.
 *   2. Never drop a column in the same deployment that stops reading it.
 *   3. Always backfill with batched UPDATEs to avoid locking the table.
 *   4. Use IF NOT EXISTS / IF EXISTS guards for idempotency.
 *   5. Wrap each phase in a transaction (node-pg-migrate does this by
 *      default) so partial failures are rolled back cleanly.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────
 *
 *   Copy this file into src/db/migrations/ with the appropriate numeric
 *   prefix and rename the column/table references to match your schema
 *   change.
 *
 *   Example for renaming `sender_address` → `sender_addr`:
 *
 *     migrations/
 *       002_expand_rename_sender_addr.ts     ← Phase 1
 *       003_backfill_sender_addr.ts          ← Phase 2
 *       004_contract_drop_sender_address.ts  ← Phase 3
 *
 * @module db/migrations/templates/expand-contract
 */

import type { MigrationBuilder } from 'node-pg-migrate';

// ─── Configuration ────────────────────────────────────────────────────────────
// Adjust these constants to match your specific schema change.

/** Name of the table being modified. */
const TABLE = 'streams';

/** The old column name that will eventually be dropped. */
const OLD_COLUMN = 'sender_address';

/** The new column name that will replace the old one. */
const NEW_COLUMN = 'sender_addr';

/** SQL type of the new column (must be compatible during transition). */
const NEW_COLUMN_TYPE = 'TEXT';

/** Batch size for the backfill UPDATE to avoid long-running locks. */
const BACKFILL_BATCH_SIZE = 1000;

// ─── Phase 1 — EXPAND ────────────────────────────────────────────────────────
//
// Add the new column. The old column remains in place.
// Application code deployed with this phase should:
//   - Write to BOTH old and new columns on INSERT/UPDATE.
//   - Read from the OLD column (for backward compat with nodes not yet updated).
//
// This phase is safe to deploy while the old application code is still running
// because the old code ignores the new column.

/**
 * @migration_phase expand
 * @migration_description Add new column alongside old column
 */
export async function up_phase1_expand(pgm: MigrationBuilder): Promise<void> {
  // Guard: only add if the column does not already exist.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${TABLE}' AND column_name = '${NEW_COLUMN}'
      ) THEN
        ALTER TABLE ${TABLE} ADD COLUMN ${NEW_COLUMN} ${NEW_COLUMN_TYPE};
      END IF;
    END $$;
  `);

  // Optional: add a trigger that keeps the two columns in sync during the
  // transition period. This ensures that writes from old application nodes
  // (that only know about the old column) are automatically mirrored.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION sync_${OLD_COLUMN}_to_${NEW_COLUMN}()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.${NEW_COLUMN} IS NULL THEN
        NEW.${NEW_COLUMN} := NEW.${OLD_COLUMN};
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_sync_${OLD_COLUMN} ON ${TABLE};
    CREATE TRIGGER trg_sync_${OLD_COLUMN}
      BEFORE INSERT OR UPDATE ON ${TABLE}
      FOR EACH ROW
      EXECUTE FUNCTION sync_${OLD_COLUMN}_to_${NEW_COLUMN}();
  `);
}

export async function down_phase1_expand(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_sync_${OLD_COLUMN} ON ${TABLE}`);
  pgm.sql(`DROP FUNCTION IF EXISTS sync_${OLD_COLUMN}_to_${NEW_COLUMN}()`);
  pgm.sql(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS ${NEW_COLUMN}`);
}

// ─── Phase 2 — BACKFILL ──────────────────────────────────────────────────────
//
// Copy data from old column → new column in batches to avoid full table locks.
// Application code deployed with this phase should:
//   - Write to BOTH columns.
//   - Read from the NEW column.
//
// Once this phase completes AND all application nodes read from the new column,
// Phase 3 is safe to execute.

/**
 * @migration_phase backfill
 * @migration_description Backfill new column from old column in batches
 */
export async function up_phase2_backfill(pgm: MigrationBuilder): Promise<void> {
  // Batched update — processes BACKFILL_BATCH_SIZE rows at a time.
  // The loop runs inside a DO block so it executes server-side.
  pgm.sql(`
    DO $$
    DECLARE
      rows_updated INTEGER;
    BEGIN
      LOOP
        UPDATE ${TABLE}
        SET ${NEW_COLUMN} = ${OLD_COLUMN}
        WHERE ${NEW_COLUMN} IS NULL
          AND id IN (
            SELECT id FROM ${TABLE}
            WHERE ${NEW_COLUMN} IS NULL
            LIMIT ${BACKFILL_BATCH_SIZE}
          );
        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        EXIT WHEN rows_updated = 0;
        -- Brief pause between batches to reduce lock contention.
        PERFORM pg_sleep(0.1);
      END LOOP;
    END $$;
  `);

  // After backfill, add a NOT NULL constraint if required.
  // Using a CHECK constraint with NOT VALID avoids a full table scan.
  pgm.sql(`
    ALTER TABLE ${TABLE}
    ADD CONSTRAINT ${TABLE}_${NEW_COLUMN}_not_null
    CHECK (${NEW_COLUMN} IS NOT NULL) NOT VALID;
  `);

  // Validate the constraint separately — this acquires a weaker lock.
  pgm.sql(`
    ALTER TABLE ${TABLE}
    VALIDATE CONSTRAINT ${TABLE}_${NEW_COLUMN}_not_null;
  `);
}

export async function down_phase2_backfill(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE ${TABLE}
    DROP CONSTRAINT IF EXISTS ${TABLE}_${NEW_COLUMN}_not_null;
  `);
  pgm.sql(`UPDATE ${TABLE} SET ${NEW_COLUMN} = NULL`);
}

// ─── Phase 3 — CONTRACT ─────────────────────────────────────────────────────
//
// Remove the old column and the sync trigger.
// Application code deployed with this phase should:
//   - Read and write ONLY the new column.
//   - NOT reference the old column at all.
//
// ⚠️  WARNING: This phase is IRREVERSIBLE in production.
//     Only run after confirming ALL application nodes use the new column.

/**
 * @migration_phase contract
 * @migration_description Drop old column and cleanup sync trigger
 */
export async function up_phase3_contract(pgm: MigrationBuilder): Promise<void> {
  // Remove the sync trigger (no longer needed).
  pgm.sql(`DROP TRIGGER IF EXISTS trg_sync_${OLD_COLUMN} ON ${TABLE}`);
  pgm.sql(`DROP FUNCTION IF EXISTS sync_${OLD_COLUMN}_to_${NEW_COLUMN}()`);

  // Drop the old column.
  pgm.sql(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS ${OLD_COLUMN}`);
}

export async function down_phase3_contract(pgm: MigrationBuilder): Promise<void> {
  // Re-create the old column for rollback.
  // ⚠️  Data in the old column will be lost after contract phase!
  // The backfill direction is reversed: new → old.
  pgm.sql(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${OLD_COLUMN} ${NEW_COLUMN_TYPE}`);
  pgm.sql(`UPDATE ${TABLE} SET ${OLD_COLUMN} = ${NEW_COLUMN}`);
}

// ─── Default export for node-pg-migrate compatibility ─────────────────────────
// When used as a real migration file, export the relevant phase's up/down.
// Copy and rename this file for each phase, exporting the correct functions.
//
// Example for Phase 1:
//   export { up_phase1_expand as up, down_phase1_expand as down };

export const up = up_phase1_expand;
export const down = down_phase1_expand;
