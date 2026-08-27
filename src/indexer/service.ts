import pg, { PoolClient } from 'pg';
import { db } from '../db/client';
import { config } from '../config';
import { ContractEvent, ReplayProgress, ReplayCursor, ReplayRequest } from '../types';
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
  recordIndexerBatchSuccess,
} from '../metrics/indexerRed.js';
import {
  indexerLedgerLag,
  indexerCatchupEtaSeconds,
} from '../metrics/indexerLag.js';
import {
  indexerEventsIngestedTotal,
  indexerLagSeconds,
} from '../metrics/businessMetrics.js';
import { getStellarRpcService } from '../services/stellar-rpc.js';
import { rowReader, INT32_MAX, BIGINT_SAFE_MAX } from '../db/rowMapping.js';

/** Seconds elapsed since a `process.hrtime.bigint()` start mark. */
function elapsedSecondsSince(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

// ── Replay budget error ────────────────────────────────────────────────────────

/**
 * Thrown when a replay run exceeds the configured wall-clock budget
 * (`INDEXER_REPLAY_BUDGET_MS`). Already-committed batches are durable;
 * a re-run will resume from the last persisted cursor offset.
 */
export class ReplayBudgetExceededError extends Error {
  constructor(budgetMs: number, elapsedMs: number) {
    super(
      `Replay budget of ${budgetMs} ms exceeded (elapsed: ${elapsedMs} ms). ` +
        'Re-run to resume from the last committed cursor offset.',
    );
    this.name = 'ReplayBudgetExceededError';
  }
}

/**
 * Thrown when this instance could not acquire (or lost) the distributed
 * indexer leader-election lease. Another instance is currently the leader
 * and is expected to own replay; no data was lost, already-committed
 * batches remain durable, and a re-run resumes from the last committed
 * cursor offset once this instance becomes leader.
 */
export class IndexerNotLeaderError extends Error {
  constructor() {
    super(
      'This instance is not the indexer replay leader; another instance is ' +
        'currently running (or eligible to run) replay.',
    );
    this.name = 'IndexerNotLeaderError';
  }
}

/**
 * Thrown when a replay cancellation was requested but a single batch's
 * database wait (e.g. `fetch` or `COMMIT`) did not settle within
 * `INDEXER_REPLAY_STOP_FORCED_TIMEOUT_MS` of the request. The replay unwinds
 * cooperatively so the in-memory indexer lock and the leader lease are
 * released rather than being held indefinitely on a stuck connection.
 * Already-committed batches remain durable; a re-run resumes from the last
 * committed cursor offset.
 */
export class ReplayForcedStopError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Replay stop requested but the in-flight batch did not settle within ` +
        `${timeoutMs} ms; forcing cancellation to release the indexer lock.`,
    );
    this.name = 'ReplayForcedStopError';
  }
}

// ── In-memory concurrent-replay lock ──────────────────────────────────────────

/**
 * Lightweight in-memory flag that prevents two concurrent replay operations
 * from running at the same time on this process instance.
 *
 * All durable progress is stored in the `replay_cursors` DB table — this flag
 * is intentionally reset to `false` on process restart so a crash-interrupted
 * replay can be resumed immediately.
 *
 * For multi-process deployments a distributed lock (e.g. Redis SETNX) would
 * be required instead; this flag handles the single-process case.
 */
class ReplayLock {
  private _isReplaying = false;

  isHeld(): boolean {
    return this._isReplaying;
  }

  acquire(): void {
    this._isReplaying = true;
  }

  release(): void {
    this._isReplaying = false;
  }
}

export const replayLock = new ReplayLock();

// ── Graceful stop signal ───────────────────────────────────────────────────────

let _stopRequested = false;
let _stopRequestedAt: number | null = null;

/**
 * Resolved the moment a stop is requested so that in-flight database waits
 * (inside `processBatch`) can be force-bounded by a timer instead of blocking
 * forever on a stuck connection while holding the indexer lock.
 */
function createStopTriggered(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let _stopTriggered = createStopTriggered();

/**
 * Request that an in-progress replay stops at the next safe batch boundary.
 * Already-committed batches remain durable; a re-run resumes from the last
 * committed cursor offset.
 */
export function requestStopReplay(): void {
  if (!_stopRequested) {
    _stopRequested = true;
    _stopRequestedAt = Date.now();
    _stopTriggered.resolve();
  }
}

/** Reset stop flag — for testing only. */
export function _resetStopReplay(): void {
  _stopRequested = false;
  _stopRequestedAt = null;
  _stopTriggered = createStopTriggered();
}

// ── In-memory progress state (for low-latency /status polling) ────────────────

/**
 * In-memory replay progress state used exclusively for fast `/status` polling.
 * This state is ephemeral and is NOT relied upon for crash-resume durability —
 * that role belongs to the `replay_cursors` DB table.
 */
class ReplayState {
  private state: ReplayProgress = {
    isReplaying: false,
    rowsReplayed: 0,
    rowsRemaining: 0,
    totalRows: 0,
    estimatedCompletion: null,
    startedAt: null,
  };

  getState(): ReplayProgress {
    return { ...this.state };
  }

  startReplay(
    totalRows: number,
    contractId: string,
    ledger: number,
    replayCursorId: string,
    resumeFromOffset: number,
  ): void {
    this.state = {
      isReplaying: true,
      rowsReplayed: resumeFromOffset,
      rowsRemaining: Math.max(0, totalRows - resumeFromOffset),
      totalRows,
      estimatedCompletion: null,
      startedAt: new Date(),
      contractId,
      ledger,
      replayCursorId,
      currentOffset: resumeFromOffset,
    };
  }

  updateProgress(rowsProcessed: number, newOffset: number): void {
    const prevOffset = this.state.currentOffset ?? 0;
    const monotonicOffset = Math.max(prevOffset, newOffset);
    const actualAdded = Math.max(0, monotonicOffset - prevOffset);
    this.state.rowsReplayed += actualAdded;
    this.state.rowsRemaining = Math.max(0, this.state.totalRows - this.state.rowsReplayed);
    this.state.currentOffset = monotonicOffset;

    if (this.state.startedAt && this.state.rowsReplayed > 0) {
      const elapsed = Date.now() - this.state.startedAt.getTime();
      const rate = this.state.rowsReplayed / elapsed; // rows per ms
      const remainingTime = this.state.rowsRemaining / rate;
      this.state.estimatedCompletion = new Date(Date.now() + remainingTime);
    }
  }

  endReplay(): void {
    this.state.isReplaying = false;
    this.state.estimatedCompletion = null;
  }
}

export const replayState = new ReplayState();

// ── Row mappers (pg QueryResultRow → domain types) ────────────────────────────
//
// Never pass a bare domain interface to `client.query<T>()`.  pg requires
// `QueryResultRow` (an index signature); domain interfaces do not satisfy it.
// Query with `Record<string, unknown>` and map through these helpers instead.
// See `src/db/repositories/README.md`.

/**
 * Lenient timestamp coercion, retained only for `getReplayProgress`, whose
 * mapper is out of scope for issue #1316 and is guarded by its own try/catch.
 * New mappers must use the readers in `src/db/rowMapping.ts`.
 */
function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Map a raw `replay_cursors` row into a typed {@link ReplayCursor}.
 *
 * The nullability contract comes from
 * `migrations/1000000000002_create_replay_cursors.ts`:
 *
 * | Column                  | Type          | Nullable |
 * | ----------------------- | ------------- | -------- |
 * | `id`                    | `uuid` PK     | no       |
 * | `contract_id`           | `text`        | no       |
 * | `ledger`                | `integer`     | no       |
 * | `from_block`            | `integer`     | **yes**  |
 * | `to_block`              | `integer`     | **yes**  |
 * | `total_rows`            | `integer`     | no       |
 * | `last_committed_offset` | `integer`     | no       |
 * | `started_at`            | `timestamptz` | no       |
 * | `completed_at`          | `timestamptz` | **yes**  |
 *
 * Block heights, ledger sequences, row counts and offsets are non-negative by
 * construction, so the readers are bounded to `[0, INT32_MAX]`. A negative or
 * out-of-range value means the row is corrupt, and a corrupt cursor silently
 * read as `0` would restart a replay from the beginning and re-emit every
 * event — the exact failure this mapper now refuses to produce.
 *
 * @throws {RowMappingError} if any column violates the contract above.
 */
export function rowToReplayCursor(row: Record<string, unknown>): ReplayCursor {
  const r = rowReader('replay_cursors', row);
  const bounds = { min: 0, max: INT32_MAX };

  return {
    id:                    r.requireString('id'),
    contract_id:           r.requireString('contract_id'),
    ledger:                r.requireInt('ledger', bounds),
    from_block:            r.optionalInt('from_block', bounds),
    to_block:              r.optionalInt('to_block', bounds),
    total_rows:            r.requireInt('total_rows', bounds),
    last_committed_offset: r.requireInt('last_committed_offset', bounds),
    started_at:            r.requireDate('started_at'),
    completed_at:          r.optionalDate('completed_at'),
  };
}

/**
 * Map a raw `historical_events` row into a typed {@link ContractEvent}.
 *
 * The nullability contract comes from
 * `migrations/1000000000000_initial_schema.ts`:
 *
 * | Column             | Type        | Nullable |
 * | ------------------ | ----------- | -------- |
 * | `event_id`         | `text` PK   | no       |
 * | `contract_id`      | `text`      | no       |
 * | `ledger`           | `integer`   | no       |
 * | `event_type`       | `text`      | no       |
 * | `event_data`       | `jsonb`     | no       |
 * | `block_height`     | `bigint`    | no       |
 * | `transaction_hash` | `text`      | no       |
 * | `created_at`       | `timestamp` | **yes**  |
 *
 * `ingested_at` and `created_at` are read only when the column is present on
 * the row. That distinction is deliberate: `fetchEventBatch` does not select
 * them, and an absent column must stay absent from the domain object rather
 * than materialise as a fabricated timestamp. A column that *is* selected and
 * holds NULL maps to `null`, because the schema permits it.
 *
 * `block_height` is a `bigint`, so it is bounded by the safe-integer range
 * instead of int4 — `Number('9007199254740993')` rounds down silently, and a
 * replay ordered by a rounded block height would skip or repeat events.
 *
 * Failure policy: fail fast. The single caller is `fetchEventBatch`, whose
 * rows are inserted straight into `contract_events`. Today a corrupt row is
 * coerced and then either rejected by Postgres with an opaque `invalid input
 * syntax for type bigint: "NaN"` or — worse — inserted with a silently
 * defaulted `ledger` of 0. Throwing here surfaces the same batch failure with
 * the table, column and reason named, and prevents the second case entirely.
 *
 * @throws {RowMappingError} if any column violates the contract above.
 */
export function rowToContractEvent(row: Record<string, unknown>): ContractEvent {
  const r = rowReader('historical_events', row);

  return {
    event_id:         r.requireString('event_id'),
    contract_id:      r.requireString('contract_id'),
    ledger:           r.requireInt('ledger', { min: 0, max: INT32_MAX }),
    event_type:       r.requireString('event_type'),
    event_data:       r.requireJsonObject('event_data'),
    block_height:     r.requireInt('block_height', { min: 0, max: BIGINT_SAFE_MAX }),
    transaction_hash: r.requireString('transaction_hash'),
    ...(row['ingested_at'] !== undefined
      ? { ingested_at: r.optionalDate('ingested_at') }
      : {}),
    ...(row['created_at'] !== undefined
      ? { created_at: r.optionalDate('created_at') }
      : {}),
  };
}

// ── Cursor repository (DB operations) ─────────────────────────────────────────

/**
 * DB operations for the `replay_cursors` table.
 *
 * All queries are fully parameterized — no user-supplied values are ever
 * interpolated into SQL strings.
 */
export class ReplayCursorRepository {
  /**
   * Find an incomplete cursor for the given (contract_id, ledger) pair.
   * Returns the most recently started incomplete cursor so a resume attempt
   * picks up where the latest run left off.
   */
  async findActive(
    client: PoolClient,
    contractId: string,
    ledger: number,
  ): Promise<ReplayCursor | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, contract_id, ledger, from_block, to_block,
              total_rows, last_committed_offset, started_at, completed_at
         FROM replay_cursors
        WHERE contract_id = $1
          AND ledger      = $2
          AND completed_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [contractId, ledger],
    );
    return result.rows[0] ? rowToReplayCursor(result.rows[0]) : null;
  }

  /**
   * Create a fresh cursor row for a new replay run.
   */
  async create(
    client: PoolClient,
    contractId: string,
    ledger: number,
    fromBlock: number | undefined,
    toBlock: number | undefined,
    totalRows: number,
  ): Promise<ReplayCursor> {
    const result = await client.query<Record<string, unknown>>(
      `INSERT INTO replay_cursors
         (contract_id, ledger, from_block, to_block, total_rows, last_committed_offset)
       VALUES ($1, $2, $3, $4, $5, 0)
       RETURNING id, contract_id, ledger, from_block, to_block,
                 total_rows, last_committed_offset, started_at, completed_at`,
      [contractId, ledger, fromBlock ?? null, toBlock ?? null, totalRows],
    );
    return rowToReplayCursor(result.rows[0]!);
  }

  /**
   * Advance the cursor offset.  Called inside the SAME transaction as the
   * batch INSERT so the offset advance and the data commit are atomic — a crash
   * between the two can never happen.
   *
   * Uses GREATEST to ensure progress offset is strictly monotonic and never regresses.
   */
  async advanceOffset(
    client: PoolClient,
    cursorId: string,
    newOffset: number,
  ): Promise<void> {
    await client.query(
      `UPDATE replay_cursors
          SET last_committed_offset = GREATEST(last_committed_offset, $1)
        WHERE id = $2`,
      [newOffset, cursorId],
    );
  }

  /**
   * Mark the cursor as completed.  Called once all batches have committed.
   */
  async markCompleted(client: PoolClient, cursorId: string): Promise<void> {
    await client.query(
      `UPDATE replay_cursors
          SET completed_at = now()
        WHERE id = $1`,
      [cursorId],
    );
  }
}

// ── IndexerService ─────────────────────────────────────────────────────────────

/**
 * IndexerService handles contract event replay operations with per-batch
 * transactions.
 *
 * ## Per-batch commit contract
 *
 * Instead of holding a single long-lived transaction open for the entire
 * backfill, `replayEvents` commits once per batch of `batchSize` rows:
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
  private batchSize: number;
  private maxRangeBlocks: number;
  private replayBudgetMs: number;
  private replayStopForcedTimeoutMs: number;
  private cursorRepo: ReplayCursorRepository;
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
    this.batchSize = batchSize ?? config.indexer.replayBatchSize;
    this.maxRangeBlocks = maxRangeBlocks ?? config.indexer.maxRangeBlocks;
    this.replayBudgetMs = replayBudgetMs ?? config.indexer.replayBudgetMs;
    this.replayStopForcedTimeoutMs =
      replayStopForcedTimeoutMs ?? config.indexer.replayStopForcedTimeoutMs;
    this.cursorRepo = cursorRepo ?? new ReplayCursorRepository();
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

  /** True when a stop has been requested (cooperative cancellation signal). */
  private isStopRequested(): boolean {
    return _stopRequested;
  }

  /**
   * Cooperatively bound a database wait once a stop has been requested.
   *
   * - If no stop is requested, the operation runs unmodified.
   * - If a stop is requested (either before or while the operation is in
   *   flight), the wait is raced against a forced-timeout countdown. If the
   *   database call does not settle within `replayStopForcedTimeoutMs` of the
   *   stop being requested, a {@link ReplayForcedStopError} is thrown so the
   *   replay unwinds and releases the in-memory indexer lock and leader lease
   *   instead of hanging on a stuck connection.
   *
   * The forced timeout is a safety net; normal cancellation is handled by the
   * explicit checkpoints in `processBatch` (before fetch / before COMMIT) which
   * roll back the in-flight batch cleanly without waiting on a timer.
   */
  private async withStopGuard<T>(op: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => op();

    if (this.isStopRequested()) {
      return this.raceForcedTimeout(run());
    }

    // No stop yet: start the operation, but arm a forced timeout that only
    // fires if a stop is requested while the operation is in flight.
    const opPromise = run();
    let timer: NodeJS.Timeout | undefined;
    const forced = _stopTriggered.promise.then(
      () =>
        new Promise<never>((_, reject) => {
          const remaining = Math.max(
            0,
            (this.stopRequestedAt ?? Date.now()) + this.replayStopForcedTimeoutMs - Date.now(),
          );
          timer = setTimeout(
            () => reject(new ReplayForcedStopError(this.replayStopForcedTimeoutMs)),
            remaining,
          );
          if (typeof timer.unref === 'function') timer.unref();
        }),
    );
    // Avoid an unhandled rejection if the operation settles before the timer.
    forced.catch(() => undefined);

    try {
      return await Promise.race([opPromise, forced]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Race `opPromise` against the forced-stop timeout using the current deadline. */
  private raceForcedTimeout<T>(opPromise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const remaining = Math.max(
      0,
      (this.stopRequestedAt ?? Date.now()) + this.replayStopForcedTimeoutMs - Date.now(),
    );
    const forced = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ReplayForcedStopError(this.replayStopForcedTimeoutMs)),
        remaining,
      );
      if (typeof timer.unref === 'function') timer.unref();
    });
    // Avoid an unhandled rejection if the operation settles first.
    forced.catch(() => undefined);

    return Promise.race([opPromise, forced]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Timestamp (ms) at which the current stop was requested, or null if none. */
  private get stopRequestedAt(): number | null {
    return _stopRequestedAt;
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
    if (_stopRequested) {
      logger.info('replay_cancelled_before_start', undefined, {
        event: 'replay_cancelled_before_start',
        contract_id: request.contract_id,
        ledger: request.ledger,
      });
      _resetStopReplay();
      return;
    }

    // 1. Validate input (no DB access yet)
    this.validateReplayRequest(request);

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
      let lastBatchRowCount = 0;

      // 5. Per-batch loop — each iteration uses a fresh connection.
      while (offset < totalRows) {
        // Stop-requested guard: honour a shutdown signal at a safe batch boundary.
        if (_stopRequested) {
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
          batchResult = await this.processBatch(
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
        recordIndexerBatchSuccess(request.contract_id, elapsedSecondsSince(batchStartedAt));

        if (batchResult.aborted) {
          // A stop was requested mid-batch; the in-flight batch was rolled
          // back and not committed. Stop at this boundary.
          stoppedByRequest = true;
          break;
        }

        if (batchResult.rowsFetched === 0) {
          // Source exhausted ahead of totalRows count — safe to stop.
          break;
        }

        const newOffset = offset + batchResult.rowsFetched;
        offset = newOffset;
        batchIndex++;
        lastBatchRowCount = batchResult.rowsFetched;

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
      if (_stopRequested) {
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
        await client.query(
          `INSERT INTO indexer_replay_progress (last_committed_cursor, total, status)
           VALUES ($1, $2, $3)
           ON CONFLICT (last_committed_cursor) DO UPDATE
              SET status = 'in-progress', updated_at = now()`,
          [existing.id, existing.total_rows, 'in-progress'],
        );
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
      const totalRows = await this.countEventsToReplay(client, request);
      const cursor = await this.cursorRepo.create(
        client,
        request.contract_id,
        request.ledger,
        request.from_block,
        request.to_block,
        totalRows,
      );

      // Initialize progress checkpoint in the database.
      await client.query(
        `INSERT INTO indexer_replay_progress (last_committed_cursor, total, status)
         VALUES ($1, $2, $3)
         ON CONFLICT (last_committed_cursor) DO NOTHING`,
        [cursor.id, totalRows, 'in-progress'],
      );

      return { cursor, totalRows };
    } finally {
      client.release();
    }
  }

  /**
   * Fetch one batch, insert into `contract_events`, and advance the DB cursor
   * — all inside a single transaction on a fresh connection.
   *
   * The connection is acquired at the start and released in the `finally`
   * block so it is never held across multiple batches.
   *
   * Cooperative cancellation checkpoints: if a stop is requested before the
   * batch's `fetch` or before its `COMMIT`, the in-flight (empty or
   * not-yet-committed) transaction is rolled back and `{ aborted: true }` is
   * returned so the caller can stop without persisting partial progress. The
   * long-running `fetch` and `COMMIT` waits are additionally wrapped by
   * {@link withStopGuard} so a stop requested while they are in flight is
   * force-bounded by the configured timeout instead of holding the indexer
   * lock on a stuck connection.
   *
   * @returns `{ rowsFetched, aborted }` — `rowsFetched === 0` means the source
   *   is exhausted; `aborted === true` means a stop was honoured and the batch
   *   was rolled back.
   */
  private async processBatch(
    cursorId: string,
    request: ReplayRequest,
    offset: number,
    batchIndex: number,
  ): Promise<{ rowsFetched: number; aborted: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Cooperative checkpoint (before any work in this batch): roll back the
      // empty transaction and abort cleanly.
      if (this.isStopRequested()) {
        await client.query('ROLLBACK');
        return { rowsFetched: 0, aborted: true };
      }

      const events = await this.withStopGuard(() =>
        this.fetchEventBatch(client, request, offset, this.batchSize),
      );

      if (events.length === 0) {
        await client.query('ROLLBACK');
        return { rowsFetched: 0, aborted: false };
      }

      // Cooperative checkpoint (after fetch, before commit): a stop requested
      // during the fetch wait means we discard this batch (it will be
      // re-replayed on resume) rather than persisting partial progress.
      if (this.isStopRequested()) {
        await client.query('ROLLBACK');
        return { rowsFetched: 0, aborted: true };
      }

      await this.batchInsertEvents(client, events);

      // Advance the cursor offset inside the same transaction as the INSERT
      // so the two operations are always atomic.
      const newOffset = offset + events.length;
      await this.cursorRepo.advanceOffset(client, cursorId, newOffset);

      // Update the progress checkpoint atomic with the batch commit.
      await client.query(
        `UPDATE indexer_replay_progress
            SET updated_at = now()
          WHERE last_committed_cursor = $1`,
        [cursorId],
      );

      // Cooperative checkpoint (immediately before COMMIT).
      if (this.isStopRequested()) {
        await client.query('ROLLBACK');
        return { rowsFetched: 0, aborted: true };
      }

      await this.withStopGuard(() => client.query('COMMIT'));
      return { rowsFetched: events.length, aborted: false };
    } catch (error) {
      // Roll back the partial batch — already-committed batches are untouched.
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors; the connection will be released below.
      }
      throw error;
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
      await client.query(
        `UPDATE indexer_replay_progress
            SET status = $1, updated_at = now()
          WHERE last_committed_cursor = $2`,
        ['completed', cursorId],
      );
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
   * Validate replay request parameters.
   *
   * All validation runs before any database access — bad parameters are
   * rejected cheaply and do not waste pool connections.
   *
   * @throws {Error} For any invalid parameter.
   */
  private validateReplayRequest(request: ReplayRequest): void {
    if (!request.contract_id || typeof request.contract_id !== 'string') {
      throw new Error('Invalid contract_id');
    }
    if (typeof request.ledger !== 'number' || request.ledger < 0) {
      throw new Error('Invalid ledger');
    }
    if (
      request.from_block !== undefined &&
      (typeof request.from_block !== 'number' || request.from_block < 0)
    ) {
      throw new Error('Invalid from_block');
    }
    if (
      request.to_block !== undefined &&
      (typeof request.to_block !== 'number' || request.to_block < 0)
    ) {
      throw new Error('Invalid to_block');
    }
    if (
      request.from_block !== undefined &&
      request.to_block !== undefined &&
      request.from_block > request.to_block
    ) {
      throw new Error('from_block must be less than or equal to to_block');
    }

    // Guard against unbounded ranges that could run indefinitely.
    if (
      this.maxRangeBlocks > 0 &&
      request.from_block !== undefined &&
      request.to_block !== undefined
    ) {
      const range = request.to_block - request.from_block;
      if (range > this.maxRangeBlocks) {
        throw new Error(
          `Block range ${range} exceeds the maximum allowed range of ${this.maxRangeBlocks}. ` +
            'Reduce the range or increase INDEXER_MAX_REPLAY_RANGE_BLOCKS.',
        );
      }
    }
  }

  /**
   * Count total source rows matching the replay request.
   * Uses parameterized queries exclusively.
   */
  private async countEventsToReplay(
    client: PoolClient,
    request: ReplayRequest,
  ): Promise<number> {
    let query = `
      SELECT COUNT(*) as count
      FROM historical_events
      WHERE contract_id = $1 AND ledger = $2
    `;
    const params: unknown[] = [request.contract_id, request.ledger];

    if (request.from_block !== undefined) {
      query += ` AND block_height >= $${params.length + 1}`;
      params.push(request.from_block);
    }
    if (request.to_block !== undefined) {
      query += ` AND block_height <= $${params.length + 1}`;
      params.push(request.to_block);
    }

    const result = await client.query<Record<string, unknown>>(query, params);
    const first = result.rows[0];
    return parseInt(String(first?.['count'] ?? '0'), 10);
  }

  /**
   * Fetch a batch of source events ordered deterministically so pagination
   * via OFFSET produces stable results.
   * Uses parameterized queries exclusively.
   */
  private async fetchEventBatch(
    client: PoolClient,
    request: ReplayRequest,
    offset: number,
    limit: number,
  ): Promise<ContractEvent[]> {
    let query = `
      SELECT
        event_id,
        contract_id,
        ledger,
        event_type,
        event_data,
        block_height,
        transaction_hash
      FROM historical_events
      WHERE contract_id = $1 AND ledger = $2
    `;
    const params: unknown[] = [request.contract_id, request.ledger];

    if (request.from_block !== undefined) {
      query += ` AND block_height >= $${params.length + 1}`;
      params.push(request.from_block);
    }
    if (request.to_block !== undefined) {
      query += ` AND block_height <= $${params.length + 1}`;
      params.push(request.to_block);
    }

    query += ` ORDER BY block_height ASC, event_id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await client.query<Record<string, unknown>>(query, params);
    return result.rows.map(rowToContractEvent);
  }

  /**
   * Batch INSERT events into `contract_events` using a multi-row VALUES list.
   *
   * `ON CONFLICT (event_id) DO NOTHING` ensures idempotency: re-running a
   * partially completed replay never produces duplicate rows.
   * Uses positional parameters — no user values are string-interpolated.
   */
  private async batchInsertEvents(
    client: PoolClient,
    events: ContractEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];

    events.forEach((event, index) => {
      const baseIndex = index * 7;
      valuePlaceholders.push(
        `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`,
      );
      values.push(
        event.event_id,
        event.contract_id,
        event.ledger,
        event.event_type,
        JSON.stringify(event.event_data),
        event.block_height,
        event.transaction_hash,
      );
    });

    const query = `
      INSERT INTO contract_events (
        event_id,
        contract_id,
        ledger,
        event_type,
        event_data,
        block_height,
        transaction_hash
      ) VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
    `;

    await client.query(query, values);
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
      const result = await client.query<Record<string, unknown>>(`
        SELECT p.last_committed_cursor, c.contract_id, c.ledger, c.from_block, c.to_block
          FROM indexer_replay_progress p
          JOIN replay_cursors c ON p.last_committed_cursor = c.id
         WHERE p.status = 'in-progress'
         ORDER BY p.started_at DESC
         LIMIT 1
      `);

      if (result.rows.length === 0) {
        logger.info('No incomplete replays found to resume.');
        return;
      }

      const row = result.rows[0];
      const request: ReplayRequest = {
        contract_id: row['contract_id'] as string,
        ledger: Number(row['ledger']),
        from_block: row['from_block'] != null ? Number(row['from_block']) : undefined,
        to_block: row['to_block'] != null ? Number(row['to_block']) : undefined,
      };

      logger.info('Resuming incomplete replay from checkpoint', undefined, {
        event: 'replay_resume_startup',
        contract_id: request.contract_id,
        ledger: request.ledger,
        cursor_id: row['last_committed_cursor'] as string,
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
      const result = await client.query<Record<string, unknown>>(`
        SELECT p.status, p.total, p.started_at, p.updated_at,
               c.contract_id, c.ledger, c.id as cursor_id, c.last_committed_offset
          FROM indexer_replay_progress p
          JOIN replay_cursors c ON p.last_committed_cursor = c.id
         ORDER BY p.updated_at DESC
         LIMIT 1
      `);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const lastCommittedOffset = Number(row['last_committed_offset']);
        const total = Number(row['total']);
        return {
          isReplaying: row['status'] === 'in-progress',
          rowsReplayed: lastCommittedOffset,
          rowsRemaining: Math.max(0, total - lastCommittedOffset),
          totalRows: total,
          estimatedCompletion: null,
          startedAt: row['started_at'] != null ? asDate(row['started_at']) : null,
          contractId: row['contract_id'] as string,
          ledger: Number(row['ledger']),
          replayCursorId: row['cursor_id'] as string,
          currentOffset: lastCommittedOffset,
          status: row['status'] as string,
        };
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

// ── Ingest service (contract event ingestion from chain worker) ───────────────

import { ApiError, ApiErrorCode, conflictError, serviceUnavailable, validationError } from '../middleware/errorHandler.js';
import { debug, error, info, warn } from '../utils/logger.js';
import { ContractEventStore, InMemoryContractEventStore } from './store.js';
import {
  ContractEventRecord,
  IndexerDependencyState,
  IndexerHealthSnapshot,
  IngestContractEventsRequest,
  IngestContractEventsResult,
} from './types.js';
import { StreamEventReplayFilter, StreamEventReplayResult } from '../db/types.js';

const MAX_EVENTS_PER_BATCH = 100;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_TOPIC_LENGTH = 128;
const MAX_CONTRACT_ID_LENGTH = 128;
const MAX_TX_HASH_LENGTH = 128;
const MAX_RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const INDEXER_MAX_EVENTS_PER_BATCH = MAX_EVENTS_PER_BATCH;
export const INDEXER_RATE_LIMIT_REQUESTS = MAX_RATE_LIMIT_REQUESTS;
export const INDEXER_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;

type RateLimitBucket = { timestamps: number[] };
type IngestRequestContext = { actor: string; requestId?: string };

type IndexerState = {
  dependency: IndexerDependencyState;
  lastSuccessfulIngestAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  acceptedBatchCount: number;
  acceptedEventCount: number;
  duplicateEventCount: number;
  lastSafeLedger: number;
  reorgDetected: boolean;
  reorgHeight?: number;
  // Catch-up telemetry state
  lastIndexedLedger: number;
  ledgerLag: number;
  catchupEtaSeconds: number | null;
  ledgerThroughputSamples: number[]; // Rolling window of ledgers/second samples
  lastLedgerLagUpdateAt: number | null;
};

const rolledBackLedgers = new Set<number>();

export function isLedgerRolledBack(ledger: number): boolean {
  return rolledBackLedgers.has(ledger);
}

function clearRolledBackLedger(ledger: number): void {
  rolledBackLedgers.delete(ledger);
}

export function _resetRolledBackLedgers(): void {
  rolledBackLedgers.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw validationError(`${field} must not exceed ${maxLength} characters`);
  }
  return trimmed;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw validationError(`${field} must be a non-negative integer`);
  }
  return value;
}

function assertIsoTimestamp(value: unknown, field: string): string {
  const timestamp = assertNonEmptyString(value, field);
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw validationError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function validateEvent(rawEvent: unknown): ContractEventRecord {
  if (!isPlainObject(rawEvent)) {
    throw validationError('each event must be an object');
  }
  const payload = rawEvent.payload;
  if (!isPlainObject(payload)) {
    throw validationError('payload must be a JSON object');
  }
  return {
    eventId: assertNonEmptyString(rawEvent.eventId, 'eventId', MAX_EVENT_ID_LENGTH),
    ledger: assertNonNegativeInteger(rawEvent.ledger, 'ledger'),
    contractId: assertNonEmptyString(rawEvent.contractId, 'contractId', MAX_CONTRACT_ID_LENGTH),
    topic: assertNonEmptyString(rawEvent.topic, 'topic', MAX_TOPIC_LENGTH),
    txHash: assertNonEmptyString(rawEvent.txHash, 'txHash', MAX_TX_HASH_LENGTH),
    txIndex: assertNonNegativeInteger(rawEvent.txIndex, 'txIndex'),
    operationIndex: assertNonNegativeInteger(rawEvent.operationIndex, 'operationIndex'),
    eventIndex: assertNonNegativeInteger(rawEvent.eventIndex, 'eventIndex'),
    payload,
    happenedAt: assertIsoTimestamp(rawEvent.happenedAt, 'happenedAt'),
    ledgerHash: assertNonEmptyString(rawEvent.ledgerHash, 'ledgerHash', MAX_TX_HASH_LENGTH),
  };
}

function validateBatch(body: unknown): IngestContractEventsRequest {
  if (!isPlainObject(body)) {
    throw validationError('request body must be an object');
  }
  if (!Array.isArray(body.events)) {
    throw validationError('events must be an array');
  }
  if (body.events.length < 1) {
    throw validationError('events must contain at least one contract event');
  }
  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    throw validationError(`events must not contain more than ${MAX_EVENTS_PER_BATCH} items`);
  }
  const events = body.events.map((event) => validateEvent(event));
  const seenIds = new Set<string>();
  for (const event of events) {
    if (seenIds.has(event.eventId)) {
      throw conflictError('request batch contains duplicate eventId values', { eventId: event.eventId });
    }
    seenIds.add(event.eventId);
  }
  return { events };
}

export class IndexerIngestionService {
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  private readonly state: IndexerState;

  constructor(private store: ContractEventStore) {
    this.state = {
      dependency: 'healthy',
      lastSuccessfulIngestAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      acceptedBatchCount: 0,
      acceptedEventCount: 0,
      duplicateEventCount: 0,
      lastSafeLedger: 0,
      reorgDetected: false,
      // Catch-up telemetry initialization
      lastIndexedLedger: 0,
      ledgerLag: 0,
      catchupEtaSeconds: null,
      ledgerThroughputSamples: [],
      lastLedgerLagUpdateAt: null,
    };
  }

  setStore(store: ContractEventStore): void { this.store = store; }

  setDependencyState(state: IndexerDependencyState, reason?: string): void {
    this.state.dependency = state;
    if (state !== 'healthy') {
      this.state.lastFailureAt = new Date().toISOString();
      this.state.lastFailureReason = reason ?? 'dependency marked degraded';
    } else {
      this.state.lastFailureReason = null;
    }
  }

  resetRuntimeState(): void {
    this.rateLimits.clear();
    Object.assign(this.state, {
      dependency: 'healthy',
      lastSuccessfulIngestAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      acceptedBatchCount: 0,
      acceptedEventCount: 0,
      duplicateEventCount: 0,
      lastSafeLedger: 0,
      reorgDetected: false,
      reorgHeight: undefined,
      // Reset catch-up telemetry state
      lastIndexedLedger: 0,
      ledgerLag: 0,
      catchupEtaSeconds: null,
      ledgerThroughputSamples: [],
      lastLedgerLagUpdateAt: null,
    });
    rolledBackLedgers.clear();
  }

  getHealthSnapshot(): IndexerHealthSnapshot {
    return {
      dependency: this.state.dependency,
      store: this.store.kind,
      lastSuccessfulIngestAt: this.state.lastSuccessfulIngestAt,
      lastFailureAt: this.state.lastFailureAt,
      lastFailureReason: this.state.lastFailureReason,
      acceptedBatchCount: this.state.acceptedBatchCount,
      acceptedEventCount: this.state.acceptedEventCount,
      duplicateEventCount: this.state.duplicateEventCount,
      lastSafeLedger: this.state.lastSafeLedger,
      reorgDetected: this.state.reorgDetected,
    };
  }

  /**
   * Get catch-up telemetry including ledger lag and ETA.
   * This provides visibility into how far behind the indexer is and
   * estimated time to catch up when lagging.
   */
  getCatchupTelemetry(): {
    ledgerLag: number;
    catchupEtaSeconds: number | null;
    lastIndexedLedger: number;
    lastLedgerLagUpdateAt: string | null;
  } {
    return {
      ledgerLag: this.state.ledgerLag,
      catchupEtaSeconds: this.state.catchupEtaSeconds,
      lastIndexedLedger: this.state.lastIndexedLedger,
      lastLedgerLagUpdateAt: this.state.lastLedgerLagUpdateAt
        ? new Date(this.state.lastLedgerLagUpdateAt).toISOString()
        : null,
    };
  }

  /**
   * Compute ledger lag and ETA using the Stellar RPC tip.
   * This should be called periodically (e.g., on each successful ingest)
   * to update catch-up telemetry without making redundant RPC calls.
   *
   * Uses a rolling average of ledger throughput samples to estimate ETA,
   * avoiding naive linear extrapolation from a single sample.
   */
  private async updateCatchupTelemetry(maxLedger: number): Promise<void> {
    try {
      const rpcService = getStellarRpcService();
      const tip = await rpcService.getLatestLedger();
      const tipLedger = tip.sequence;

      // Store previous values before updating
      const previousLedger = this.state.lastIndexedLedger;
      const previousUpdateTime = this.state.lastLedgerLagUpdateAt;

      // Compute ledger lag (tip - last indexed)
      const lag = Math.max(0, tipLedger - maxLedger);
      this.state.ledgerLag = lag;
      this.state.lastIndexedLedger = maxLedger;
      const now = Date.now();
      this.state.lastLedgerLagUpdateAt = now;

      // Update Prometheus gauge
      indexerLedgerLag.set(lag);

      // Compute ETA if lagging and we have throughput data
      if (lag > 0) {
        // Calculate throughput if we have previous data
        if (previousUpdateTime && previousLedger > 0) {
          const timeSinceLastUpdate = (now - previousUpdateTime) / 1000; // seconds
          
          if (timeSinceLastUpdate > 0) {
            const ledgersProcessed = maxLedger - previousLedger;
            const throughput = ledgersProcessed / timeSinceLastUpdate; // ledgers/second

            // Maintain rolling window of last 10 samples
            this.state.ledgerThroughputSamples.push(throughput);
            if (this.state.ledgerThroughputSamples.length > 10) {
              this.state.ledgerThroughputSamples.shift();
            }

            // Compute average throughput from samples
            const avgThroughput =
              this.state.ledgerThroughputSamples.reduce((sum, sample) => sum + sample, 0) /
              this.state.ledgerThroughputSamples.length;

            // Estimate ETA using average throughput
            if (avgThroughput > 0) {
              const etaSeconds = lag / avgThroughput;
              this.state.catchupEtaSeconds = etaSeconds;
              indexerCatchupEtaSeconds.set(etaSeconds);
            } else {
              this.state.catchupEtaSeconds = null;
              indexerCatchupEtaSeconds.set(0);
            }
          }
        } else {
          // Not enough data for ETA estimation yet
          this.state.catchupEtaSeconds = null;
          indexerCatchupEtaSeconds.set(0);
        }
      } else {
        // Caught up - reset ETA
        this.state.catchupEtaSeconds = null;
        indexerCatchupEtaSeconds.set(0);
      }
    } catch (err) {
      // If RPC fails, we can't compute lag - log but don't fail the ingest
      warn('Failed to update catch-up telemetry (RPC error)', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't update telemetry on RPC failure - keep last known values
    }
  }

  private enforceRateLimit(actor: string): void {
    const now = Date.now();
    const bucket = this.rateLimits.get(actor) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (bucket.timestamps.length >= MAX_RATE_LIMIT_REQUESTS) {
      warn('Indexer ingest rate limit exceeded', { actor, limit: MAX_RATE_LIMIT_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS });
      throw new ApiError(429, ApiErrorCode.TOO_MANY_REQUESTS, 'indexer ingest rate limit exceeded', {
        retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
    }
    bucket.timestamps.push(now);
    this.rateLimits.set(actor, bucket);
  }

  async getEvents(filter?: StreamEventReplayFilter): Promise<StreamEventReplayResult> {
    return this.store.getEvents(filter);
  }

  async ingest(body: unknown, context: IngestRequestContext): Promise<IngestContractEventsResult> {
    if (this.state.dependency !== 'healthy') {
      warn('Indexer dependency unavailable', { actor: context.actor, requestId: context.requestId, state: this.state.dependency });
      throw serviceUnavailable('Indexer event ingestion is temporarily unavailable while the durable store is unhealthy.');
    }
    this.enforceRateLimit(context.actor);
    const request = validateBatch(body);
    const events = request.events;
    const ledgersInBatch = new Set(events.map((e) => e.ledger));

    for (const ledger of ledgersInBatch) {
      const incomingHash = events.find((e) => e.ledger === ledger)!.ledgerHash;
      const existingHash = await this.store.getLedgerHash(ledger);
      if (existingHash && existingHash !== incomingHash) {
        warn('Indexer detected chain reorg', { ledger, existingHash, incomingHash, requestId: context.requestId });
        this.state.reorgDetected = true;
        this.state.reorgHeight = ledger;
        rolledBackLedgers.add(ledger);
        await this.store.rollbackBeforeLedger(ledger);
        this.state.lastFailureAt = new Date().toISOString();
        this.state.lastFailureReason = `Reorg detected at ledger ${ledger}`;
      }
    }

    try {
      const result = await this.store.insertMany(request.events);
      const now = new Date().toISOString();
      const maxLedger = Math.max(...events.map((e) => e.ledger));
      const safeLedger = Math.max(this.state.lastSafeLedger, maxLedger - 1);
      this.state.lastSuccessfulIngestAt = now;
      this.state.acceptedBatchCount += 1;
      this.state.acceptedEventCount += result.insertedEventIds.length;
      this.state.duplicateEventCount += result.duplicateEventIds.length;
      this.state.lastSafeLedger = safeLedger;

      if (this.state.reorgDetected && this.state.reorgHeight !== undefined && maxLedger > this.state.reorgHeight + 5) {
        clearRolledBackLedger(this.state.reorgHeight);
        this.state.reorgDetected = false;
        this.state.reorgHeight = undefined;
      }

      info('Indexer contract event batch persisted', {
        actor: context.actor, requestId: context.requestId, store: this.store.kind,
        batchSize: request.events.length, insertedCount: result.insertedEventIds.length,
        duplicateCount: result.duplicateEventIds.length, lastSafeLedger: this.state.lastSafeLedger,
      });
      debug('Indexer contract event ids processed', {
        requestId: context.requestId, insertedEventIds: result.insertedEventIds, duplicateEventIds: result.duplicateEventIds,
      });

      if (result.insertedEventIds.length > 0) {
        indexerEventsIngestedTotal.inc(result.insertedEventIds.length);

        const latestHappenedAtMs = events.reduce((max, event) => {
          const happenedAtMs = Date.parse(event.happenedAt);
          return Number.isFinite(happenedAtMs) && happenedAtMs > max ? happenedAtMs : max;
        }, 0);
        if (latestHappenedAtMs > 0) {
          indexerLagSeconds.set(Math.max(0, (Date.now() - latestHappenedAtMs) / 1000));
        }

        // Update catch-up telemetry (ledger lag and ETA)
        // This uses the same Stellar RPC tip-fetching path to avoid redundant calls
        await this.updateCatchupTelemetry(maxLedger);
      }

      return {
        insertedCount: result.insertedEventIds.length,
        duplicateCount: result.duplicateEventIds.length,
        insertedEventIds: result.insertedEventIds,
        duplicateEventIds: result.duplicateEventIds,
      };
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error('Unknown indexer ingest failure');
      this.state.lastFailureAt = new Date().toISOString();
      this.state.lastFailureReason = err.message;
      error('Indexer contract event ingest failed', { actor: context.actor, requestId: context.requestId, store: this.store.kind }, err);
      throw serviceUnavailable('Indexer event ingestion could not persist the batch to the durable store.');
    }
  }
}

export const defaultIndexerEventStore = new InMemoryContractEventStore();
export const indexerIngestionService = new IndexerIngestionService(defaultIndexerEventStore);
