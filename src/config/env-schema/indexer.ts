/**
 * Indexer pipeline environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { z } from 'zod';
import { booleanEnv, integerEnv, optionalString } from './parsers.js';

export const indexerEnvSchema = {
  /**
   * When true, reject non-TLS indexer worker connections (fail-closed).
   * Defaults to true in production, false otherwise.
   */
  INDEXER_MTLS_REQUIRED: booleanEnv().optional(),
  /** Flag the indexer as stalled when no ledger progress for this long, in ms. @default 300000 (5 min) */
  INDEXER_STALL_THRESHOLD_MS: integerEnv('INDEXER_STALL_THRESHOLD_MS', 1000).default(
    5 * 60 * 1000
  ),
  /** Maximum number of backfill batches processed concurrently. @default 1 */
  INDEXER_BACKFILL_CONCURRENCY: integerEnv('INDEXER_BACKFILL_CONCURRENCY', 1, 64).default(1),
  /** Number of ledger ranges in a single backfill batch. @default 100 */
  INDEXER_BACKFILL_BATCH_SIZE: integerEnv('INDEXER_BACKFILL_BATCH_SIZE', 1, 100000).default(100),
  /** Require backfill checkpoints to advance in ledger order. @default true */
  INDEXER_BACKFILL_STRICT_ORDER: booleanEnv().default(true),
  /** Number of ordered batches completed before the checkpoint advances. @default 1 */
  INDEXER_BACKFILL_COMMIT_INTERVAL: integerEnv('INDEXER_BACKFILL_COMMIT_INTERVAL', 1, 10000).default(1),
  /** Maximum retries for a failed backfill batch. @default 3 */
  INDEXER_BACKFILL_MAX_RETRIES: integerEnv('INDEXER_BACKFILL_MAX_RETRIES', 0, 100).default(3),
  /** Delay between backfill batch retries in ms. @default 1000 */
  INDEXER_BACKFILL_RETRY_DELAY_MS: integerEnv('INDEXER_BACKFILL_RETRY_DELAY_MS', 0).default(1000),
  /**
   * Manually recorded timestamp of the last successful sync, surfaced in
   * status endpoints for operational dashboards.
   */
  INDEXER_LAST_SUCCESSFUL_SYNC_AT: optionalString('INDEXER_LAST_SUCCESSFUL_SYNC_AT'),
  /** Version stamp recorded against the deployment checklist. @default '2026-03-27' */
  DEPLOYMENT_CHECKLIST_VERSION: z.string().min(1).default('2026-03-27'),
  /** File path used to persist admin state (ban list) across restarts. */
  ADMIN_STATE_FILE: optionalString('ADMIN_STATE_FILE'),
};
