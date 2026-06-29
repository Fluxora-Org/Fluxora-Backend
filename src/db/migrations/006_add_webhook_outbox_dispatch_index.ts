/**
 * Migration: Add partial compound index on webhook_outbox(status, scheduled_at)
 *
 * The dispatcher query in src/webhooks/dispatcher.ts fetches the next batch of
 * due deliveries with a filter on `status = 'pending' AND scheduled_at <= NOW()`.
 * Without a compound index this query performs a full table scan, which degrades
 * to O(n) as the outbox grows and creates a latency feedback loop that causes
 * retries to pile up.
 *
 * The partial index (WHERE status = 'pending') keeps the index small — it only
 * covers the rows the dispatcher actually needs, so writes to delivered/failed
 * rows do not incur index maintenance overhead.
 *
 * CONCURRENTLY allows the index to be built without locking the table for writes,
 * making the migration safe to apply against a live production database.
 *
 * MIGRATION: 006_add_webhook_outbox_dispatch_index
 *
 * @module db/migrations/006_add_webhook_outbox_dispatch_index
 */

export const INDEX_NAME = 'webhook_outbox_dispatch_idx';

/**
 * Up migration: create the partial compound index on webhook_outbox.
 *
 * Uses CREATE INDEX CONCURRENTLY so the migration does not take an exclusive
 * table lock. Note: CONCURRENTLY cannot run inside a transaction block.
 */
export const up = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_outbox_dispatch_idx
  ON webhook_outbox (status, scheduled_at)
  WHERE status = 'pending';
`;

/**
 * Down migration: drop the partial compound index.
 *
 * Uses DROP INDEX CONCURRENTLY to avoid locking the table for reads/writes
 * during the rollback.
 */
export const down = `
DROP INDEX CONCURRENTLY IF EXISTS webhook_outbox_dispatch_idx;
`;
