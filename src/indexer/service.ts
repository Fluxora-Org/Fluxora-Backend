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
    this.state.rowsReplayed += rowsProcessed;
    this.state.rowsRemaining = Math.max(0, this.state.totalRows - this.state.rowsReplayed);
    this.state.currentOffset = newOffset;

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
    const result = await client.query<ReplayCursor>(
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
    return result.rows[0] ?? null;
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
    const result = await client.query<ReplayCursor>(
      `INSERT INTO replay_cursors
         (contract_id, ledger, from_block, to_block, total_rows, last_committed_offset)
       VALUES ($1, $2, $3, $4, $5, 0)
       RETURNING id, contract_id, ledger, from_block, to_block,
                 total_rows, last_committed_offset, started_at, completed_at`,
      [contractId, ledger, fromBlock ?? null, toBlock ?? null, totalRows],
    );
    return result.rows[0]!;
  }

  /**
   * Advance the cursor offset.  Called inside the SAME transaction as the
   * batch INSERT so the offset advance and the data commit are atomic — a crash
   * between the two can never happen.
   */
  async advanceOffset(
    client: PoolClient,
    cursorId: string,
    newOffset: number,
  ): Promise<void> {
    await client.query(
      `UPDATE replay_cursors
          SET last_committed_offset = $1
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
  private cursorRepo: ReplayCursorRepository;
  private pool: pg.Pool;
  private stopRequested = false;
  private replayDone: Promise<void> | null = null;
  private resolveReplayDone: (() => void) | null = null;

  constructor(
    pool?: pg.Pool,
    batchSize?: number,
    maxRangeBlocks?: number,
    replayBudgetMs?: number,
    cursorRepo?: ReplayCursorRepository,
  ) {
    // Use the injected pool or fall back to the shared db pool.
    // Accessing db.pool directly is avoided to keep the service testable.
    this.pool = pool ?? (db as unknown as { pool: pg.Pool }).pool;
    this.batchSize = batchSize ?? config.indexer.replayBatchSize;
    this.maxRangeBlocks = maxRangeBlocks ?? config.indexer.maxRangeBlocks;
    this.replayBudgetMs = replayBudgetMs ?? config.indexer.replayBudgetMs;
    this.cursorRepo = cursorRepo ?? new ReplayCursorRepository();
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
   * @throws {Error}                    If a replay is already in progress.
   * @throws {ReplayBudgetExceededError} If the wall-clock budget is exceeded.
   */
  async replayEvents(request: ReplayRequest): Promise<void> {
    // 1. Validate input (no DB access yet)
    this.validateReplayRequest(request);

    // 2. Concurrent-replay guard
    if (replayLock.isHeld()) {
      throw new Error('Replay operation already in progress');
    }
    if (this.stopRequested) {
      throw new Error('Replay service is stopping for shutdown');
    }
    replayLock.acquire();
    this.stopRequested = false;
    this.replayDone = new Promise<void>((resolve) => {
      this.resolveReplayDone = resolve;
    });

    const replayStart = Date.now();
    let cursor: ReplayCursor | null = null;

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
        if (this.stopRequested) {
          logger.info('replay_stop_requested', undefined, {
            event: 'replay_stop_requested',
            contract_id: request.contract_id,
            ledger: request.ledger,
            cursor_id: cursor.id,
            offset,
            total_rows: totalRows,
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
        const batchResult = await this.processBatch(
          cursor.id,
          request,
          offset,
          batchIndex,
        );

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

        if (this.stopRequested) {
          logger.info('replay_stop_requested', undefined, {
            event: 'replay_stop_requested',
            contract_id: request.contract_id,
            ledger: request.ledger,
            cursor_id: cursor.id,
            offset: newOffset,
            total_rows: totalRows,
          });
          break;
        }
      }

      // 6. Mark cursor as complete only when all rows have committed. A
      // shutdown stop leaves the cursor incomplete so the next replay resumes
      // from the last transactionally persisted offset.
      const completed = offset >= totalRows;

      if (completed) {
        await this.completeCursor(cursor.id);
      }
      replayState.endReplay();

      const durationSec = (Date.now() - replayStart) / 1_000;
      indexerReplayDurationSeconds.observe(
        { contract_id: request.contract_id.slice(0, 64) },
        durationSec,
      );
      indexerReplayRowsPerSecond.set({ contract_id: request.contract_id.slice(0, 64) }, 0);

      if (completed) {
        logger.info('replay_completed', undefined, {
          event: 'replay_completed',
          contract_id: request.contract_id,
          ledger: request.ledger,
          cursor_id: cursor.id,
          total_rows: totalRows,
          duration_sec: Math.round(durationSec * 100) / 100,
        });
      } else {
        logger.info('replay_stopped', undefined, {
          event: 'replay_stopped',
          contract_id: request.contract_id,
          ledger: request.ledger,
          cursor_id: cursor.id,
          committed_offset: offset,
          total_rows: totalRows,
          duration_sec: Math.round(durationSec * 100) / 100,
        });
      }
    } catch (error) {
      replayState.endReplay();
      indexerReplayRowsPerSecond.set({ contract_id: request.contract_id.slice(0, 64) }, 0);
      throw error;
    } finally {
      replayLock.release();
      this.resolveReplayDone?.();
      this.replayDone = null;
      this.resolveReplayDone = null;
    }
  }

  /**
   * Request that the replay loop stops at the next safe batch boundary.
   *
   * Already committed batches have advanced the durable cursor inside the same
   * transaction as their inserts; leaving the cursor incomplete allows a later
   * replay to resume without marking partial work as complete.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.replayDone;
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
   * @returns `{ rowsFetched }` — 0 means the source is exhausted.
   */
  private async processBatch(
    cursorId: string,
    request: ReplayRequest,
    offset: number,
    batchIndex: number,
  ): Promise<{ rowsFetched: number }> {
    void batchIndex;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const events = await this.fetchEventBatch(client, request, offset, this.batchSize);

      if (events.length === 0) {
        await client.query('ROLLBACK');
        return { rowsFetched: 0 };
      }

      await this.batchInsertEvents(client, events);

      // Advance the cursor offset inside the same transaction as the INSERT
      // so the two operations are always atomic.
      const newOffset = offset + events.length;
      await this.cursorRepo.advanceOffset(client, cursorId, newOffset);

      await client.query('COMMIT');
      return { rowsFetched: events.length };
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
      await this.cursorRepo.markCompleted(client, cursorId);
    } finally {
      client.release();
    }
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

    const result = await client.query<{ count: string }>(query, params);
    return parseInt(result.rows[0]?.count ?? '0', 10);
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

    const result = await client.query<ContractEvent>(query, params);
    return result.rows;
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
   * Get current replay progress (in-memory snapshot for fast polling).
   */
  getReplayProgress(): ReplayProgress {
    return replayState.getState();
  }
}

export const indexerService = new IndexerService();
