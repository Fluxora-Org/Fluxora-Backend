/**
 * Migration: Add audit_logs and webhook_outbox tables
 *
 * audit_logs  — written atomically with stream operations so audit rows are
 *               always in sync with stream rows (transactional write path).
 *
 * webhook_outbox — transactional outbox pattern; a row is inserted here
 *                  atomically with the stream write so the dispatcher can
 *                  pick it up without risk of the stream being written but
 *                  the webhook being lost (or vice-versa).
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ── audit_logs ────────────────────────────────────────────────────────────
  pgm.createTable('audit_logs', {
    id:             { type: 'bigserial', primaryKey: true },
    seq:            { type: 'bigint',   notNull: true },
    timestamp:      { type: 'text',     notNull: true },
    action:         { type: 'text',     notNull: true },
    resource_type:  { type: 'text',     notNull: true },
    resource_id:    { type: 'text',     notNull: true },
    correlation_id: { type: 'text' },
    meta:           { type: 'jsonb' },   // NULL when no metadata
  });

  pgm.createIndex('audit_logs', 'resource_id');
  pgm.createIndex('audit_logs', 'action');
  pgm.createIndex('audit_logs', 'timestamp');

  // ── webhook_outbox ────────────────────────────────────────────────────────
  pgm.createTable('webhook_outbox', {
    id:         { type: 'bigserial', primaryKey: true },
    stream_id:  { type: 'text',    notNull: true },
    event_type: { type: 'text',    notNull: true },
    payload:    { type: 'jsonb',   notNull: true }, // amounts are decimal strings
    created_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
    processed:  { type: 'boolean', notNull: true, default: false },
  });

  pgm.createIndex('webhook_outbox', 'stream_id');
  pgm.createIndex('webhook_outbox', 'processed');
  pgm.createIndex('webhook_outbox', 'created_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('webhook_outbox');
  pgm.dropTable('audit_logs');
}
