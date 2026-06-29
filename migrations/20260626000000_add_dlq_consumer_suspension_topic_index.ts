/**
 * Migration: Add explicit index on dlq_consumer_suspension.topic
 *
 * Issue #499: Add an index on dlq_consumer_suspension.topic to avoid full scans
 * in dlqRepository suspension lookups.
 *
 * Although `topic` is the primary key and has an implicit index, this migration
 * adds an explicit, named index for clarity and to ensure query planners use it
 * optimally for the getConsumerSuspension(topic) lookups that run on the
 * webhook-delivery path.
 *
 * Suspension lookups occur frequently during webhook delivery processing and
 * must perform at index speed even as the suspension table grows.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create an explicit index on topic for the suspension lookup query.
  // The index name uses the project convention: idx_<table>_<columns>
  pgm.createIndex(
    'dlq_consumer_suspension',
    'topic',
    { ifNotExists: true, name: 'idx_dlq_consumer_suspension_topic' },
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('dlq_consumer_suspension', 'topic', {
    ifExists: true,
    name: 'idx_dlq_consumer_suspension_topic',
  });
}
