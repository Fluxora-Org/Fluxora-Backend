/**
 * Migration: Create indexer_replay_progress table.
 *
 * Provides durable checkpoint tracking for IndexerService.
 * Tracks the overall status, total rows, start time, and last update time of a replay.
 * The primary key last_committed_cursor references replay_cursors(id), ensuring a 1:1 mapping.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    'indexer_replay_progress',
    {
      last_committed_cursor: {
        type: 'uuid',
        primaryKey: true,
        references: 'replay_cursors(id)',
        onDelete: 'CASCADE',
      },
      total: {
        type: 'integer',
        notNull: true,
      },
      status: {
        type: 'text',
        notNull: true,
      },
      started_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    },
    { ifNotExists: true },
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('indexer_replay_progress', { ifExists: true });
}
