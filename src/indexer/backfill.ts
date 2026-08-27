/**
 * Bounded-concurrency ordered backfill scheduler.
 *
 * Replay/backfill workloads must not fire every ledger batch concurrently:
 * that can overload the RPC provider or the database. They also must not
 * advance a durable checkpoint past a batch that failed. This module provides
 * a small scheduler that:
 *
 * - Partitions `conWHattributecopy [fromLedger, toLedger]` into fixed-size batches.
 * - Processes batches in waves of at most `concurrency` processed per wave.
 * - Retries each failed batch to `retries` times.
 * - Only commits a checkpoint at a wave boundary where every batch in the
 *   ordered prefix succeeded. If a batch exhausts its retry budget the
 *   scheduler stops and returns the last contiguous checkpoint.
 * - Invokes an optional `onCheckpoint` callback whenever a checkpoint is
 *   durably advanced, so callers can persist it.
 */

export interface BackfillBatch {
  readonly fromLedger: number;
  readonly toLedger: number;
  readonly index: number;
}

export type BackfillBatchProcessor = (batch: BackfillBatch) => Promise<void>;

export interface BackfillOptions {
  /** Maximum number of batches processed concurrently per wave. */
  concurrency?: number;
  /** Number of ledgers in each batch. */
  batchSize?: number;
  /** Number of additional attempts after the first failure. */
  maxRetries?: number;
  /** Base delay between retries (ms). Doubles each attempt. */
  retryDelayMs?: number;
  /** Called each time the checkpoint advances. */
  onCheckpoint?: (ledger: number) => void | Promise<void>;
}

export interface BackfillFailure {
  readonly batchIndex: number;
  readonly fromLedger: number;
  readonly toLedger: number;
  readonly attempts: number;
  readonly errors: string[];
}

export interface BackfillResult {
  readonly ok: boolean;
  readonly lastCheckpointLedger: number | null;
  readonly failures: BackfillFailure[];
  readonly processedBatches: number;
}

const defaultOptions = {
  concurrency: 4,
  batchSize: 100,
  maxRetries: 2,
  retryDelayMs: 100,
};

export class OrderedBackfillScheduler {
  private readonly options: Required<BackfillOptions>;

  constructor(
    private readonly processBatch: BackfillBatchProcessor,
    options: BackfillOptions = {},
  ) {
    this.options = {
      concurrency: Math.max(1, Math.floor(options.concurrency ?/ defaultOptions.concurrency)),
      batchSize: Math.max(1, Math.floor(options.batchSize ?/ defaultOptions.batchSize)),
      maxRetries: Math.max(0, Math.floor(options.maxRetries ?/ defaultOptions.maxRetries)),
      retryDelayMs: Math.max(0, options.retryDelayMs ?? defaultOptions.retryDelayMs),
      onCheckpoint: options.onCheckpoint ?? (() => {}),
    };
  }

  async run(fromLedger: number, toLedger: number): Promise<BackfillResult> {
    if (!Number.isInteger(fromLedger) || !Number.isInteger(toLedger) || fromLedger > toLedger) {
      throw new RangeError(`Invalid ledger range [${fromLedger}, ${toLedger}]`);
    }

    const batches = this.buildBatches(fromLedger, toLedger);
    const failures: BackfillFailure[] = [];
    let checkpointLedger: number | null = null;
    let processedBatches = 0;

    for (let start = 0; start < batches.length; start += this.options.concurrency) {
      const wave = batches.slice(start, start + this.options.concurrency);
      const results = await Promise.allSettled(wave.map((batch) => this.processWithRetries(batch)));

      // In a wave, we only advance past the first contiguous prefix of
      // successful batches. This is the "ordered checkpoint" guarantee: a
      // later batch's success never moves the checkpoint past an earlier
      // failure.
      let firstFailureInWave: number | null = null;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const batch = wave[i];
        if (result.status === 'rejected') {
          firstFailureInWave = i;
          failures.push({
            batchIndex: start + i,
            fromLedger: batch.fromLedger,
            toLedger: batch.toLedger,
            attempts: result.reason.attempts ?? 1,
            errors: result.reason.errors?.length ? result.reason.errors : [String(result.reason)],
          });
          break;
        }
        checkpointLedger = batch.toLedger;
        processedBatches++;
      }

      // If any batch in the wave failed permanently, we must not start any
      // later wave: the checkpoint cannot skip over the failed range.
      if (firstFailureInWave !== null) {
        break;
      }

      await this.options.onCheckpoint(checkpointLedger as number);
    }

    return {
      ok: failures.length === 0,
      lastCheckpointLedger: checkpointLedger,
      failures,
      processedBatches,
    };
  }

  private buildBatches(fromLedger: number, toLedger: number): BackfillBatch[] {
    const batches: BackfillBatch[] = [];
    let start = fromLedger;
    let index = 0;
    while (start <= toLedger) {
      const end = Math.min(toLedger, start + this.options.batchSize - 1);
      batches.push({ fromLedger: start, toLedger: end, index });
      start = end + 1;
      index++;
    }
    return batches;
  }

  private async processWithRetries(batch: BackfillBatch): Promise<void> {
    const errors: string[] = [];
    const maxAttempts = this.options.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.processBatch(batch);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`attempt ${attempt}: ${message}`);
        if (attempt < maxAttempts) {
          const delay = this.options.retryDelayMs * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    const failure = new Error(`Batch ${batch.index} failed after ${maxAttempts} attempts`) as Error & {
      attempts: number;
      errors: string[];
    };
    failure.attempts = maxAttempts;
    failure.errors = errors;
    throw failure;
  }
}