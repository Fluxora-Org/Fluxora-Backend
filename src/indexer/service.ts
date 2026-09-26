// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import pg from 'pg';
import { db } from '../db/client.js';
import { config } from '../config.js';
import { ReplayCursor, ReplayProgress, ReplayRequest } from '../types/index.js';
import { logger } from '../lib/logger.js';
import {
  indexerReplayBatchesCommittedTotal,
  indexerReplayRowsCommittedTotal,
  indexerReplayRowsPerSecond,
  indexerReplayDurationSeconds,
} from '../metrics/indexerMetrics.js';
import {
  getIndexerLeaderElection,
  type IndexerLeaderElection,
} from './leaderElection.js';
import { checkReplayIntegrity } from './replayIntegrity.js';
import {
  recordIndexerBatchFailure,
  recordIndexerBatchPartialFailure,
  recordIndexerBatchSuccess,
} from '../metrics/indexerRed.js';
import { ReplayBudgetExceededError, IndexerNotLeaderError } from './replayErrors.js';
import {
  replayLock,
  replayState,
  isReplayStopRequested,
  _resetStopReplay,
} from './replayRuntimeState.js';
import { ReplayCursorRepository, ReplayProgressCheckpointRepository } from './replayCursorRepository.js';
import { ReplayBatchRunner } from './replayBatchRunner.js';
import { validateReplayRequest } from './replayValidation.js';

export { ReplayBudgetExceededError, IndexerNotLeaderError, ReplayForcedStopError } from './replayErrors.js';
export { replayLock, replayState, requestStopReplay, _resetStopReplay } from './replayRuntimeState.js';
export { rowToReplayCursor, rowToContractEvent } from './replayRowMappers.js';
export { ReplayCursorRepository } from './replayCursorRepository.js';

/** Seconds elapsed since a `process.hrtime.bigint()` start mark. */
function elapsedSecondsSince(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

// ── IndexerService ─────────────────────────────────────────────────────────────

/**
 * IndexerService handles contract event replay operations with per-batch
 * transactions.
 *
 * ## Per-batch commit contract
 *
 * Instead of holding a single long-lived transaction open for the entire
 * backfill, `replayEvents` commits once per batch of `batchSize` rows (the
 * mechanics of a single batch live in {@link ReplayBatchRunner}):
 *
 * ```
 * for each batch:
 *   acquire connection
 *   BEGIN
 *     INSERT … ON CONFLICT (event_id) DO NOTHING   ← idempotent
 *     UPDATE replay_cursors SET last_committed_offset = …  ← atomic with data
 *   COMMIT
 *   release connection
 * ```
 *
 * ## Crash-resume semantics
 *
 * The cursor offset is updated inside the same transaction as the batch
 * INSERT.  After a crash, a re-run reads `last_committed_offset` from the
 * `replay_cursors` table and resumes from exactly that point.  Because every
 * INSERT uses `ON CONFLICT (event_id) DO NOTHING`, rows from any partially
 * replayed batch that was rolled back will simply be re-inserted on the next
 * attempt without producing duplicates.
 *
 * ## Security
 *
 * - All SQL queries use positional parameters ($1, $2 …) — no user-supplied
 *   values are ever interpolated into query strings.
 * - The block range is validated and capped by `maxRangeBlocks` before any
 *   database work begins.
 * - Concurrent replays are rejected by an in-memory lock.
 */
export class IndexerService {
  private maxRangeBlocks: number;
  private replayBudgetMs: number;
  private cursorRepo: ReplayCursorRepository;
  private progressRepo: ReplayProgressCheckpointRepository;
  private batchRunner: ReplayBatchRunner;
  private pool: pg.Pool;
  private readonly leaderElectionOverride: IndexerLeaderElection | undefined;

  constructor(
    pool?: pg.Pool,
    batchSize?: number,
    maxRangeBlocks?: number,
    replayBudgetMs?: number,
    cursorRepo?: ReplayCursorRepository,
    leaderElection?: IndexerLeaderElection,
    replayStopForcedTimeoutMs?: number,
  ) {
    // Use the injected pool or fall back to the shared db pool.
    // Accessing db.pool directly is avoided to keep the service testable.
    this.pool = pool ?? (db as unknown as { pool: pg.Pool }).pool;
    this.maxRangeBlocks = maxRangeBlocks ?? config.indexer.maxRangeBlocks;
    this.replayBudgetMs = replayBudgetMs ?? config.indexer.replayBudgetMs;
    this.cursorRepo = cursorRepo ?? new ReplayCursorRepository();
    this.progressRepo = new ReplayProgressCheckpointRepository();
    this.batchRunner = new ReplayBatchRunner(
      this.pool,
      this.cursorRepo,
      this.progressRepo,
      batchSize ?? config.indexer.replayBatchSize,
      replayStopForcedTimeoutMs ?? config.indexer.replayStopForcedTimeoutMs,
    );
    // Only stored when explicitly injected (tests). Otherwise every call
    // resolves the *current* default via getLeaderElection() below —
    // this singleton is constructed at module load, before app.ts finishes
    // wiring Redis, so caching a resolved instance here would freeze it to
    // the NoOp default forever.
    this.leaderElectionOverride = leaderElection;
  }

  /** Resolves the current leader-election instance — never cached, see constructor note. */
  private getLeaderElection(): IndexerLeaderElection {
    return this.leaderElectionOverride ?? getIndexerLeaderElection();
  }

  /**
   * Replay historical contract events with per-batch transactions.
   *
   * Each batch of up to `batchSize` rows is fetched, inserted, and committed
   * in its own transaction.  The connection is released and re-acquired for
   * every batch so no single connection is held for the lifetime of the replay.
   *
   * If the replay crashes mid-way, a subsequent call with the same parameters
   * resumes from the last committed cursor offset without re-inserting already
   * committed rows.
   *
   * @param request  Validated replay parameters.
   * @throws {Error}                    If a replay is already in progress on this process.
   * @throws {IndexerNotLeaderError}     If another instance holds the distributed replay lease.
   * @throws {ReplayBudgetExceededError} If the wall-clock budget is exceeded.
   * @throws {ReplayForcedStopError}     If a stop was requested and a batch's DB wait did not settle within the forced timeout.
   */
  async replayEvents(request: ReplayRequest): Promise<void> {
    // 0. Cancel-before-start: if a stop was already requested (e.g. shutdown
    //    signalled before this replay began), do not acquire the in-memory
    //    lock or the leader lease. The flag is cleared so a later, genuine
    //    replay request is not permanently blocked by a stale cancellation.
    if (isReplayStopRequested()) {
      logger.info('replay_cancelled_before_start', undefined, {
        event: 'replay_cancelled_before_start',
        contract_id: request.contract_id,
        ledger: request.ledger,
      });
      _resetStopReplay();
      return;
    }

    // 1. Validate input (no DB access yet)
    validateReplayRequest(request, this.maxRangeBlocks);

    // 2. Concurrent-replay guard (same-process)
    if (replayLock.isHeld()) {
      throw new Error('Replay operation already in progress');
    }
    replayLock.acquire();

    // 2b. Distributed leader-election guard (cross-process/multi-replica).
    //     Acquired after the in-process lock so two concurrent calls into
    //     the same process still fail fast without touching Redis at all.
    const leaderElection = this.getLeaderElection();
    if (!(await leaderElection.tryAcquire())) {
      replayLock.release();
      throw new IndexerNotLeaderError();
    }

    const replayStart = Date.now();
    let cursor: ReplayCursor | null = null;
    let stoppedByRequest = false;

    try {
      // 3. Resolve or create the DB-backed cursor.
      //    Done in a short, single-statement transaction so we don't hold
      //    a connection open during the counting query.
      const { cursor: resolvedCursor, totalRows } =
        await this.resolveOrCreateCursor(request);
      cursor = resolvedCursor;

      if (totalRows === 0) {
        // Nothing to replay — mark complete and return.
        await this.completeCursor(cursor.id);
        replayState.endReplay();
        return;
      }

      // 4. Initialise in-memory progress (for /status polling).
      replayState.startReplay(
        totalRows,
        request.contract_id,
        request.ledger,
        cursor.id,
        cursor.last_committed_offset,
      );

      let offset = cursor.last_committed_offset;
      let batchIndex = 0;

      // 5. Per-batch loop — each iteration uses a fresh connection.
      while (offset < totalRows) {
        // Stop-requested guard: honour a shutdown signal at a safe batch boundary.
        if (isReplayStopRequested()) {
          stoppedByRequest = true;
          logger.warn('replay_stopped_by_shutdown', undefined, {
            event: 'replay_stopped_by_shutdown',
            contract_id: request.contract_id,
            ledger: request.ledger,
            cursor_id: cursor.id,
            offset,
          });
          break;
        }

        // Leadership guard: our lease may have expired (e.g. Redis outage)
        // and another instance may already be leading. Abort at this safe
        // batch boundary — already-committed batches are durable and a
        // future run (by whichever instance is leader) resumes from
        // last_committed_offset.
        if (!leaderElection.isLeader()) {
          logger.warn('replay_stopped_lost_leadership', undefined, {
            event: 'replay_stopped_lost_leadership',
            contract_id: request.contract_id,
            ledger: request.ledger,
            cursor_id: cursor.id,
            offset,
          });
          break;
        }

        // Budget guard: abort if the wall-clock limit has been exceeded.
        if (this.replayBudgetMs > 0) {
          const elapsed = Date.now() - replayStart;
          if (elapsed >= this.replayBudgetMs) {
            throw new ReplayBudgetExceededError(this.replayBudgetMs, elapsed);
          }
        }

        // Acquire a fresh connection for this batch.
        //
        // RED instrumentation wraps *only* this call so the histogram measures
        // the batch processing step itself (fetch → insert → cursor advance →
        // COMMIT) and nothing else. The loop guards above are control flow, not
        // work, and deliberately stay outside the measurement.
        const batchStartedAt = process.hrtime.bigint();
        let batchResult: { rowsFetched: number; aborted: boolean };
        try {
          batchResult = await this.batchRunner.processBatch(
            cursor.id,
            request,
            offset,
            batchIndex,
          );
        } catch (batchError) {
          const classification = recordIndexerBatchFailure(
            request.contract_id,
            elapsedSecondsSince(batchStartedAt),
            batchError,
          );
          logger.warn('replay_batch_failed', undefined, {
            event: 'replay_batch_failed',
            contract_id: request.contract_id,
            ledger: request.ledger,
            cursor_id: cursor.id,
            batch_index: batchIndex,
            offset,
            error_source: classification.source,
            error_type: classification.type,
          });
          throw batchError;
        }
        const batchDurationSeconds = elapsedSecondsSince(batchStartedAt);

        if (batchResult.aborted) {
          // A stop was requested mid-batch; the in-flight transaction was rolled
          // back, so every row this batch fetched was discarded and the ledger
          // range was NOT advanced. That is a partial failure — work was
          // performed, data was dropped — not a success. Recording it as a
          // success is what made `indexer_batch_errors_total` report a healthy
          // zero while rows were being thrown away.
          const classification = recordIndexerBatchPartialFailure(
            request.contract_id,
            batchDurationSeconds,
            'batch_aborted',
          );
          logger.warn('replay_batch_aborted', undefined, {
            event: 'replay_batch_aborted',
            contract_id: request.contract_id,
            ledger: request.ledger,
            cursor_id: cursor.id,
            batch_index: batchIndex,
            offset,
            error_source: classification.source,
            error_type: classification.type,
          });
          // Stop at this safe batch boundary.
          stoppedByRequest = true;
          break;
        }
        recordIndexerBatchSuccess(request.contract_id, batchDurationSeconds);

        if (batchResult.rowsFetched === 0) {
          // Source exhausted ahead of totalRows count — safe to stop.
          break;
        }

        const newOffset = offset + batchResult.rowsFetched;
        offset = newOffset;
        batchIndex++;

        // Update in-memory progress.
        replayState.updateProgress(batchResult.rowsFetched, newOffset);

        // Compute rows/sec for the gauge.
        const elapsedSec = (Date.now() - replayStart) / 1_000;
        const rowsPerSec = elapsedSec > 0 ? offset / elapsedSec : 0;

        // Emit metrics.
        indexerReplayBatchesCommittedTotal.inc({ contract_id: request.contract_id.slice(0, 64) });
        indexerReplayRowsCommittedTotal.inc(
          { contract_id: request.contract_id.slice(0, 64) },
          batchResult.rowsFetched,
        );
        indexerReplayRowsPerSecond.set(
          { contract_id: request.contract_id.slice(0, 64) },
          rowsPerSec,
        );

        // Structured log per batch.
        logger.info('replay_batch_committed', undefined, {
          event: 'replay_batch_committed',
          contract_id: request.contract_id,
          ledger: request.ledger,
          cursor_id: cursor.id,
          batch_index: batchIndex - 1,
          rows_in_batch: batchResult.rowsFetched,
          offset: newOffset,
          total_rows: totalRows,
          rows_remaining: Math.max(0, totalRows - newOffset),
          rows_per_sec: Math.round(rowsPerSec * 10) / 10,
        });
      }

      // 6. Finalize. If we stopped by request, leave the DB cursor as
      //    'in-progress' so a future replay resumes from the last committed
      //    offset; only mark it completed when the run finished naturally.
      if (!stoppedByRequest) {
        await this.completeCursor(cursor.id);
        replayState.endReplay();

        const durationSec = (Date.now() - replayStart) / 1_000;
        indexerReplayDurationSeconds.observe(
          { contract_id: request.contract_id.slice(0, 64) },
          durationSec,
        );
        indexerReplayRowsPerSecond.set({ contract_id: request.contract_id.slice(0, 64) }, 0);

        logger.info('replay_completed', undefined, {
          event: 'replay_completed',
          contract_id: request.contract_id,
          ledger: request.ledger,
          cursor_id: cursor.id,
          total_rows: totalRows,
          duration_sec: Math.round(durationSec * 100) / 100,
        });

        // ── Post-replay integrity check (fire-and-forget) ──────────────────
        // Scoped to the affected ledger range — never a full-table scan.
        // Runs asynchronously so the response path is never blocked.
        this.runPostReplayIntegrityCheck(request).catch((err) => {
          logger.warn('post_replay_integrity_check_failed', undefined, {
            event: 'post_replay_integrity_check_failed',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        // Cancellation: clear in-memory progress without marking the durable
        // cursor complete. The stop flag is reset in `finally` so subsequent
        // replays are not blocked by a stale cancellation request.
        replayState.endReplay();
        logger.info('replay_cancelled', undefined, {
          event: 'replay_cancelled',
          contract_id: request.contract_id,
          ledger: request.ledger,
          cursor_id: cursor.id,
          offset,
        });
      }
    } catch (error) {
      replayState.endReplay();
      indexerReplayRowsPerSecond.set({ contract_id: request.contract_id.slice(0, 64) }, 0);
      throw error;
    } finally {
      replayLock.release();
      await leaderElection.release();
      // Clear a stale cancellation request so a future replay is not blocked.
      if (isReplayStopRequested()) {
        _resetStopReplay();
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Look for an incomplete cursor that can be resumed; if none exists, count
   * the source rows and create a fresh cursor row.
   *
   * The count query and cursor creation each use their own short transaction
   * so no connection is held across the loop.
   */
  private async resolveOrCreateCursor(
    request: ReplayRequest,
  ): Promise<{ cursor: ReplayCursor; totalRows: number }> {
    const client = await this.pool.connect();
    try {
      // Check for an existing incomplete cursor first.
      const existing = await this.cursorRepo.findActive(
        client,
        request.contract_id,
        request.ledger,
      );

      if (existing) {
        // Ensure progress row exists (e.g. for legacy cursors during transition)
        await this.progressRepo.upsertResuming(client, existing.id, existing.total_rows);
        logger.info('replay_resuming', undefined, {
          event: 'replay_resuming',
          contract_id: request.contract_id,
          ledger: request.ledger,
          cursor_id: existing.id,
          resume_offset: existing.last_committed_offset,
          total_rows: existing.total_rows,
        });
        return { cursor: existing, totalRows: existing.total_rows };
      }

      // No existing cursor — count and create.
      const totalRows = await this.batchRunner.countEventsToReplay(client, request);
      const cursor = await this.cursorRepo.create(
        client,
        request.contract_id,
        request.ledger,
        request.from_block,
        request.to_block,
        totalRows,
      );

      // Initialize progress checkpoint in the database.
      await this.progressRepo.insertIfAbsent(client, cursor.id, totalRows);

      return { cursor, totalRows };
    } finally {
      client.release();
    }
  }

  /**
   * Mark the cursor as completed using its own short transaction.
   */
  private async completeCursor(cursorId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.cursorRepo.markCompleted(client, cursorId);
      await this.progressRepo.markCompleted(client, cursorId);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run the post-replay ledger-sequence integrity check in a fire-and-forget
   * manner.  This method is called inside the main `try` block of
   * `replayEvents` after the cursor has been marked complete, so it runs
   * outside any in-flight batch transaction.
   *
   * The check is scoped to a window around the replayed ledger (not using
   * `from_block`/`to_block`, which are block-height filters on the source
   * table).  A window of ±1000 ledgers ensures the check is efficient without
   * being a full-table scan.  It NEVER throws — all errors are caught and
   * logged internally.
   */
  private async runPostReplayIntegrityCheck(request: ReplayRequest): Promise<void> {
    const INTEGRITY_WINDOW_SIZE = 1000;
    const fromLedger = Math.max(0, request.ledger - INTEGRITY_WINDOW_SIZE);
    const toLedger = request.ledger + INTEGRITY_WINDOW_SIZE;

    await checkReplayIntegrity(this.pool, request.contract_id, fromLedger, toLedger);
  }

  /**
   * Scan the checkpoint table on startup to detect any incomplete replay
   * (status = 'in-progress') and resume it asynchronously.
   *
   * This facilitates automatic crash recovery when the server restarts.
   */
  async resumeIncompleteReplay(): Promise<void> {
    // Only the leader replica auto-resumes on startup — otherwise every
    // replica in a multi-instance deployment would race to resume the same
    // incomplete replay. replayEvents() re-confirms leadership itself
    // (idempotently, see leaderElection.ts) once an incomplete run is found.
    if (!(await this.getLeaderElection().tryAcquire())) {
      logger.info('Skipping incomplete-replay resume: not the indexer leader', undefined, {
        event: 'replay_resume_skipped_not_leader',
      });
      return;
    }

    const client = await this.pool.connect();
    try {
      const found = await this.progressRepo.findMostRecentInProgress(client);

      if (!found) {
        logger.info('No incomplete replays found to resume.');
        return;
      }

      const request: ReplayRequest = {
        contract_id: found.contractId,
        ledger: found.ledger,
        from_block: found.fromBlock,
        to_block: found.toBlock,
      };

      logger.info('Resuming incomplete replay from checkpoint', undefined, {
        event: 'replay_resume_startup',
        contract_id: request.contract_id,
        ledger: request.ledger,
        cursor_id: found.cursorId,
      });

      // Start the replay asynchronously so we do not block startup.
      this.replayEvents(request).catch((err) => {
        logger.error('Resumed replay failed', undefined, {
          contract_id: request.contract_id,
          ledger: request.ledger,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.error('Failed to check for incomplete replays on startup', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }

  /**
   * Get current replay progress, checking both in-memory state and the database checkpoint.
   *
   * If a replay is active in-memory, returns the active in-memory progress.
   * Otherwise, queries the database for the most recent replay progress and returns it.
   */
  async getReplayProgressExtended(): Promise<ReplayProgress> {
    const inMemory = this.getReplayProgress();
    if (inMemory.isReplaying) {
      return inMemory;
    }

    const client = await this.pool.connect();
    try {
      const latest = await this.progressRepo.findLatestProgress(client);
      if (latest) {
        return latest;
      }
    } catch (err) {
      logger.error('Failed to fetch replay progress from database', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }

    return inMemory;
  }

  /**
   * Get current replay progress (in-memory snapshot for fast polling).
   */
  getReplayProgress(): ReplayProgress {
    return replayState.getState();
  }
}

export const indexerService = new IndexerService();
