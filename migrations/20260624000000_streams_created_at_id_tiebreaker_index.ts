import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Migration: Add composite index to support stable offset pagination ordering.
 *
 * Problem
 * -------
 * `streamRepository.find` orders by `created_at DESC, id DESC`.  `created_at`
 * defaults to `NOW()` and is not unique — multiple streams inserted in the same
 * transaction or millisecond share the same value.  Without a unique tiebreaker,
 * PostgreSQL may return the same row on two different OFFSET pages, or skip a
 * row entirely when ties straddle a page boundary.
 *
 * Solution
 * --------
 * A composite index on `(created_at DESC, id DESC)` lets the planner satisfy
 * the ORDER BY via an index scan rather than a sort, and — because `id` is the
 * primary key and therefore unique — the composite key is also unique, making
 * the ordering deterministic and stable across OFFSET pages.
 *
 * Relationship to existing indexes
 * ---------------------------------
 * The `idx_streams_created_at` index (single-column, default ASC) is kept for
 * range filter queries; this new index serves the ORDER BY path.
 *
 * The migration runs `CONCURRENTLY` to avoid blocking writes on large tables.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.createIndex(
    'streams',
    [
      { name: 'created_at', sort: 'DESC' },
      { name: 'id',         sort: 'DESC' },
    ],
    {
      name: 'idx_streams_created_at_id_desc',
      concurrently: true,
      ifNotExists: true,
    },
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.dropIndex(
    'streams',
    [
      { name: 'created_at', sort: 'DESC' },
      { name: 'id',         sort: 'DESC' },
    ],
    {
      name: 'idx_streams_created_at_id_desc',
      concurrently: true,
      ifExists: true,
    },
  );
}
