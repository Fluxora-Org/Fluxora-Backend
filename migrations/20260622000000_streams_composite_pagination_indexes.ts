import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Migration: Composite indexes for filtered cursor and offset stream pagination.
 *
 * Index-to-query mapping
 * ----------------------
 * | Index                              | Repository method | Query pattern                                      |
 * |------------------------------------|-------------------|----------------------------------------------------|
 * | idx_streams_status_id              | findWithCursor    | WHERE status = $1 … ORDER BY id ASC                  |
 * | idx_streams_sender_id              | findWithCursor    | WHERE sender_address = $1 … ORDER BY id ASC          |
 * | idx_streams_contract_id            | findWithCursor    | WHERE contract_id = $1 … ORDER BY id ASC            |
 * | idx_streams_status_created_at_desc | find              | WHERE status = $1 ORDER BY created_at DESC           |
 *
 * Redundant single-column indexes dropped (left-prefix covered by composites):
 *   idx_streams_status, streams_status_index
 *   idx_streams_sender, streams_sender_address_index
 *   idx_streams_contract, streams_contract_id_index
 *
 * Kept: idx_streams_recipient (no composite in this migration), idx_streams_created_at
 * (unfiltered ORDER BY created_at DESC), idx_streams_start_time, idx_streams_end_time.
 *
 * Security: indexes do not change row visibility — they only affect scan order.
 * Address columns are not used as leading sort keys; no timing side-channel via
 * encrypted/hashed address ordering is introduced.
 *
 * Uses CREATE INDEX CONCURRENTLY inside a non-transactional migration so writes
 * are not blocked during index builds on large tables.
 */

/** Legacy names from node-pg-migrate defaults and the SQL reference migration. */
const REDUNDANT_INDEX_NAMES = [
  'idx_streams_status',
  'streams_status_index',
  'idx_streams_sender',
  'streams_sender_address_index',
  'idx_streams_contract',
  'streams_contract_id_index',
] as const;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.createIndex('streams', ['status', 'id'], {
    name: 'idx_streams_status_id',
    concurrently: true,
    ifNotExists: true,
  });

  pgm.createIndex('streams', ['sender_address', 'id'], {
    name: 'idx_streams_sender_id',
    concurrently: true,
    ifNotExists: true,
  });

  pgm.createIndex('streams', ['contract_id', 'id'], {
    name: 'idx_streams_contract_id',
    concurrently: true,
    ifNotExists: true,
  });

  pgm.createIndex(
    'streams',
    [
      { name: 'status' },
      { name: 'created_at', sort: 'DESC' },
    ],
    {
      name: 'idx_streams_status_created_at_desc',
      concurrently: true,
      ifNotExists: true,
    },
  );

  for (const indexName of REDUNDANT_INDEX_NAMES) {
    pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName};`);
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();

  pgm.dropIndex('streams', ['status', 'id'], {
    name: 'idx_streams_status_id',
    concurrently: true,
    ifExists: true,
  });

  pgm.dropIndex('streams', ['sender_address', 'id'], {
    name: 'idx_streams_sender_id',
    concurrently: true,
    ifExists: true,
  });

  pgm.dropIndex('streams', ['contract_id', 'id'], {
    name: 'idx_streams_contract_id',
    concurrently: true,
    ifExists: true,
  });

  pgm.dropIndex(
    'streams',
    [
      { name: 'status' },
      { name: 'created_at', sort: 'DESC' },
    ],
    {
      name: 'idx_streams_status_created_at_desc',
      concurrently: true,
      ifExists: true,
    },
  );

  pgm.createIndex('streams', 'status', {
    name: 'idx_streams_status',
    concurrently: true,
    ifNotExists: true,
  });

  pgm.createIndex('streams', 'sender_address', {
    name: 'idx_streams_sender',
    concurrently: true,
    ifNotExists: true,
  });

  pgm.createIndex('streams', 'contract_id', {
    name: 'idx_streams_contract',
    concurrently: true,
    ifNotExists: true,
  });
}
