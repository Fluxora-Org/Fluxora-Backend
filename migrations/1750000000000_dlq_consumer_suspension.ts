/**
 * Migration: dlq_consumer_suspension — per-topic replay failure tracking.
 *
 * Implements #349: after N consecutive failed replays to the same consumer
 * (identified by topic), the consumer is marked `suspended` and further
 * auto-replays are blocked until an operator explicitly re-enables it.
 *
 * Design:
 *  - One row per DLQ topic (consumer identifier).
 *  - `consecutive_failures` is incremented on each failed replay and reset
 *    to zero on a successful replay.
 *  - `suspended` is set to TRUE when consecutive_failures reaches the
 *    configured threshold (DLQ_SUSPENSION_THRESHOLD, default 5).
 *  - `suspended_at` / `resumed_at` provide an audit trail.
 *  - Re-enable requires an explicit operator action (POST /admin/dlq/consumers/:topic/resume).
 *
 * Security: only operators/admins may write to this state.  Public clients
 * and viewers have no access to the DLQ admin surface.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    'dlq_consumer_suspension',
    {
      topic: { type: 'text', primaryKey: true },
      consecutive_failures: { type: 'integer', notNull: true, default: 0 },
      suspended: { type: 'boolean', notNull: true, default: false },
      suspended_at: { type: 'timestamptz' },
      resumed_at: { type: 'timestamptz' },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    },
    { ifNotExists: true },
  );

  pgm.createIndex('dlq_consumer_suspension', 'suspended', { ifNotExists: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('dlq_consumer_suspension', { ifExists: true });
}
