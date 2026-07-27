/**
 * Migration: Add webhook delivery-store tables for durable management routes
 *
 * Creates the three tables used by `PgWebhookDeliveryStore` (activated via
 * `WEBHOOK_DELIVERY_STORE=postgres`) to persist webhook delivery tracking,
 * outbound outbox items, and dead-letter queue entries across process restarts.
 *
 * These tables are SEPARATE from `webhook_outbox`, which is used by the
 * `WebhookDispatcher` for the transactional stream-event fanout path.
 *
 * Tables:
 *   webhook_deliveries   — delivery-status records (tracks attempts, status)
 *   webhook_outbox_items — outbound delivery queue (management /queue path)
 *   webhook_dlq          — dead-letter queue for permanently failed deliveries
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ── webhook_deliveries ────────────────────────────────────────────────────
  // Stores delivery-status records for webhook pushes initiated via the
  // management API (/queue, retry etc.).  Separate from webhook_outbox which
  // is the stream-event fanout path owned by WebhookDispatcher.
  pgm.createTable('webhook_deliveries', {
    id:           { type: 'text', primaryKey: true },
    delivery_id:  { type: 'text', notNull: true, unique: true },
    event_id:     { type: 'text', notNull: true },
    event_type:   { type: 'text', notNull: true },
    endpoint_url: { type: 'text', notNull: true },
    status:       { type: 'text', notNull: true, default: "'pending'" },
    attempts:     { type: 'jsonb', notNull: true, default: "'[]'::jsonb" },
    payload:      { type: 'text', notNull: true },
    created_at:   {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at:   {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('webhook_deliveries', 'delivery_id');
  pgm.createIndex('webhook_deliveries', 'event_id');
  pgm.createIndex('webhook_deliveries', 'status');
  pgm.createIndex('webhook_deliveries', 'updated_at');

  // ── webhook_outbox_items ──────────────────────────────────────────────────
  // Outbound delivery queue used by the management /queue route.
  // Persists items so they survive restarts and are visible across replicas
  // when WEBHOOK_DELIVERY_STORE=postgres is active.
  pgm.createTable('webhook_outbox_items', {
    id:           { type: 'text', primaryKey: true },
    delivery_id:  { type: 'text', notNull: true },
    event_id:     { type: 'text', notNull: true },
    event_type:   { type: 'text', notNull: true },
    endpoint_url: { type: 'text', notNull: true },
    payload:      { type: 'text', notNull: true },
    secret:       { type: 'text', notNull: true },
    priority:     { type: 'text', notNull: true, default: "'normal'" },
    created_at:   {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    scheduled_for: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    attempts:     { type: 'integer', notNull: true, default: 0 },
    max_attempts: { type: 'integer', notNull: true, default: 5 },
    status:       { type: 'text', notNull: true, default: "'pending'" },
    locked_at:    { type: 'timestamp with time zone' },
    locked_by:    { type: 'text' },
  });

  pgm.createIndex('webhook_outbox_items', 'status');
  pgm.createIndex('webhook_outbox_items', 'scheduled_for');
  pgm.createIndex('webhook_outbox_items', 'priority');
  // Partial index for efficient ready-item queries
  pgm.createIndex('webhook_outbox_items', ['scheduled_for', 'priority'], {
    name: 'idx_webhook_outbox_items_ready',
    where: "status = 'pending'",
  });

  // ── webhook_dlq ───────────────────────────────────────────────────────────
  // Dead-letter queue for permanently failed webhook deliveries.
  // Persisted so operators can inspect failures after a restart without data
  // loss (the primary motivation for issue #841).
  pgm.createTable('webhook_dlq', {
    id:                { type: 'text', primaryKey: true },
    delivery_id:       { type: 'text', notNull: true },
    event_id:          { type: 'text', notNull: true },
    event_type:        { type: 'text', notNull: true },
    endpoint_url:      { type: 'text', notNull: true },
    payload:           { type: 'text', notNull: true },
    original_delivery: { type: 'jsonb', notNull: true },
    failure_reason:    { type: 'text', notNull: true },
    reason_code:       { type: 'text', notNull: true, default: "'other'" },
    created_at:        {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    processed_at:      { type: 'timestamp with time zone' },
  });

  pgm.createIndex('webhook_dlq', 'delivery_id');
  pgm.createIndex('webhook_dlq', 'reason_code');
  pgm.createIndex('webhook_dlq', 'created_at');
  // Partial index for the common "show unprocessed DLQ items" query
  pgm.createIndex('webhook_dlq', 'created_at', {
    name: 'idx_webhook_dlq_unprocessed',
    where: 'processed_at IS NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('webhook_dlq');
  pgm.dropTable('webhook_outbox_items');
  pgm.dropTable('webhook_deliveries');
}
