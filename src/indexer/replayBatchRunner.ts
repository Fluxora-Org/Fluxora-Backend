// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import pg, { PoolClient } from 'pg';
import { ContractEvent, ReplayRequest } from '../types.js';
import { ReplayForcedStopError } from './replayErrors.js';
import {
  isReplayStopRequested,
  getReplayStopRequestedAt,
  getReplayStopTriggeredPromise,
} from './replayRuntimeState.js';
import { rowToContractEvent } from './replayRowMappers.js';
import { ReplayCursorRepository, ReplayProgressCheckpointRepository } from './replayCursorRepository.js';

/**
 * Runs a single replay batch — fetch from `historical_events`, insert into
 * `contract_events`, advance the cursor/checkpoint — with cooperative
 * cancellation support.
 *
 * Each batch acquires its own connection and commits its own transaction (see
 * the per-batch commit contract documented on `IndexerService`), so no
 * connection is ever held across batches.
 */
export class ReplayBatchRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly cursorRepo: ReplayCursorRepository,
    private readonly progressRepo: ReplayProgressCheckpointRepository,
    private readonly batchSize: number,
    private readonly replayStopForcedTimeoutMs: number,
  ) {}

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

    if (isReplayStopRequested()) {
      return this.raceForcedTimeout(run());
    }

    // No stop yet: start the operation, but arm a forced timeout that only
    // fires if a stop is requested while the operation is in flight.
    const opPromise = run();
    let timer: NodeJS.Timeout | undefined;
    const forced = getReplayStopTriggeredPromise().then(
      () =>
        new Promise<never>((_, reject) => {
          const remaining = Math.max(
            0,
            (getReplayStopRequestedAt() ?? Date.now()) + this.replayStopForcedTimeoutMs - Date.now(),
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
      (getReplayStopRequestedAt() ?? Date.now()) + this.replayStopForcedTimeoutMs - Date.now(),
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
   * {@link ReplayBatchRunner.withStopGuard} so a stop requested while they are
   * in flight is force-bounded by the configured timeout instead of holding
   * the indexer lock on a stuck connection.
   *
   * @returns `{ rowsFetched, aborted }` — `rowsFetched === 0` means the source
   *   is exhausted; `aborted === true` means a stop was honoured and the batch
   *   was rolled back.
   */
  async processBatch(
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
      if (isReplayStopRequested()) {
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
      if (isReplayStopRequested()) {
        await client.query('ROLLBACK');
        return { rowsFetched: 0, aborted: true };
      }

      await this.batchInsertEvents(client, events);

      // Advance the cursor offset inside the same transaction as the INSERT
      // so the two operations are always atomic.
      const newOffset = offset + events.length;
      await this.cursorRepo.advanceOffset(client, cursorId, newOffset);

      // Update the progress checkpoint atomic with the batch commit.
      await this.progressRepo.touchUpdatedAt(client, cursorId);

      // Cooperative checkpoint (immediately before COMMIT).
      if (isReplayStopRequested()) {
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
   * Count total source rows matching the replay request.
   * Uses parameterized queries exclusively.
   */
  async countEventsToReplay(
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
}
