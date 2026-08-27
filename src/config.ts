/**
 * Application Configuration
 *
 * All values are read from environment variables with sensible defaults so the
 * application can run in any environment without code changes.
 */

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  stellar: {
    rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    timeout: envInt('STELLAR_RPC_TIMEOUT', 10_000),
    retry: {
      maxRetries: envInt('STELLAR_RPC_MAX_RETRIES', 3),
      initialDelayMs: envInt('STELLAR_RPC_RETRY_DELAY', 1_000),
    },
  },
  indexer: {
    /**
     * Number of source rows fetched and inserted per batch transaction.
     * Smaller values release connections more frequently; larger values reduce
     * per-batch overhead. Default: 250 rows.
     */
    replayBatchSize: envInt('INDEXER_REPLAY_BATCH_SIZE', 250),

    /**
     * Maximum allowed `to_block - from_block` range. Requests that exceed this
     * limit are rejected before any database work to guard against runaway
     * replays. 0 = unlimited (not recommended in production). Default: 10 000 000.
     */
    maxRangeBlocks: envInt('INDEXER_MAX_REPLAY_RANGE_BLOCKS', 10_000_000),

    /**
     * Wall-clock budget (ms) for a single replay run. When > 0 the replay loop
     * will abort with an error after this many milliseconds have elapsed, leaving
     * committed batches intact so a re-run can resume from the cursor.
     * 0 = no budget (unlimited). Default: 0.
     */
    replayBudgetMs: envInt('INDEXER_REPLAY_BUDGET_MS', 0),

    /**
     * Forced-stop timeout (ms) used to bound a single batch's database wait
     * once a replay cancellation has been requested. Cooperatively, batches
     * already abort at the next safe checkpoint (before fetch / before commit);
     * this timeout guarantees the in-memory indexer lock and leader lease are
     * released even if a `fetch` or `COMMIT` call hangs on a stuck connection.
     * 0 = wait indefinitely (no forced timeout). Default: 10_000.
     */
    replayStopForcedTimeoutMs: envInt('INDEXER_REPLAY_STOP_FORCED_TIMEOUT_MS', 10_000),

    /** Maximum concurrent batches in a backfill worker pool. */
    backfillConcurrency: envInt('INDEXER_BACKFILL_CONCURRENCY', 5),

    /** Maximum attempts for a failed backfill batch. */
    backfillMaxRetries: envInt('INDEXER_BACKFILL_MAX_RETRIES', 3),
  },
  dlq: {
    /** Retention in days for terminal dead_letter_queue entries. Default 30. */
    retentionDays: envInt('DLQ_RETENTION_DAYS', 30),
    /** Max rows deleted per purge batch. Default 500. */
    purgeBatchSize: envInt('DLQ_PURGE_BATCH_SIZE', 500),
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost/fluxora',
  },
};
