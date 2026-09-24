// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { PoolClient } from 'pg';
import { ReplayCursor, ReplayProgress } from '../types.js';
import { rowToReplayCursor, asDate } from './replayRowMappers.js';

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

// ── Progress-checkpoint repository (DB operations) ───────────────────────────

/**
 * DB operations for the `indexer_replay_progress` table — the checkpoint row
 * that startup crash-recovery scans for, and that `/status` falls back to
 * once no replay is active in-memory. Kept alongside {@link ReplayCursorRepository}
 * because every write here happens in lockstep with a `replay_cursors` write.
 *
 * All queries are fully parameterized — no user-supplied values are ever
 * interpolated into SQL strings.
 */
export class ReplayProgressCheckpointRepository {
  /**
   * Ensure a checkpoint row exists and is marked in-progress for a cursor
   * that is being resumed (e.g. a legacy cursor from before this table
   * existed).
   */
  async upsertResuming(client: PoolClient, cursorId: string, totalRows: number): Promise<void> {
    await client.query(
      `INSERT INTO indexer_replay_progress (last_committed_cursor, total, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (last_committed_cursor) DO UPDATE
          SET status = 'in-progress', updated_at = now()`,
      [cursorId, totalRows, 'in-progress'],
    );
  }

  /**
   * Initialize the checkpoint row for a freshly created cursor. A no-op if
   * the row somehow already exists.
   */
  async insertIfAbsent(client: PoolClient, cursorId: string, totalRows: number): Promise<void> {
    await client.query(
      `INSERT INTO indexer_replay_progress (last_committed_cursor, total, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (last_committed_cursor) DO NOTHING`,
      [cursorId, totalRows, 'in-progress'],
    );
  }

  /**
   * Touch the checkpoint's `updated_at`. Called atomic with each batch commit
   * so a stalled replay can be detected from the checkpoint's staleness.
   */
  async touchUpdatedAt(client: PoolClient, cursorId: string): Promise<void> {
    await client.query(
      `UPDATE indexer_replay_progress
          SET updated_at = now()
        WHERE last_committed_cursor = $1`,
      [cursorId],
    );
  }

  /**
   * Mark the checkpoint as completed. Called once all batches have committed.
   */
  async markCompleted(client: PoolClient, cursorId: string): Promise<void> {
    await client.query(
      `UPDATE indexer_replay_progress
          SET status = $1, updated_at = now()
        WHERE last_committed_cursor = $2`,
      ['completed', cursorId],
    );
  }

  /**
   * Find the most recent in-progress checkpoint, joined with its cursor's
   * replay parameters. Used on startup to resume a crash-interrupted replay.
   */
  async findMostRecentInProgress(client: PoolClient): Promise<{
    cursorId: string;
    contractId: string;
    ledger: number;
    fromBlock: number | undefined;
    toBlock: number | undefined;
  } | null> {
    const result = await client.query<Record<string, unknown>>(`
      SELECT p.last_committed_cursor, c.contract_id, c.ledger, c.from_block, c.to_block
        FROM indexer_replay_progress p
        JOIN replay_cursors c ON p.last_committed_cursor = c.id
       WHERE p.status = 'in-progress'
       ORDER BY p.started_at DESC
       LIMIT 1
    `);

    const row = result.rows[0];
    if (!row) return null;

    return {
      cursorId: row['last_committed_cursor'] as string,
      contractId: row['contract_id'] as string,
      ledger: Number(row['ledger']),
      fromBlock: row['from_block'] != null ? Number(row['from_block']) : undefined,
      toBlock: row['to_block'] != null ? Number(row['to_block']) : undefined,
    };
  }

  /**
   * Find the most recently updated checkpoint, joined with its cursor, mapped
   * straight into a {@link ReplayProgress} snapshot. Used by `/status` when no
   * replay is active in-memory on this instance.
   */
  async findLatestProgress(client: PoolClient): Promise<ReplayProgress | null> {
    const result = await client.query<Record<string, unknown>>(`
      SELECT p.status, p.total, p.started_at, p.updated_at,
             c.contract_id, c.ledger, c.id as cursor_id, c.last_committed_offset
        FROM indexer_replay_progress p
        JOIN replay_cursors c ON p.last_committed_cursor = c.id
       ORDER BY p.updated_at DESC
       LIMIT 1
    `);

    const row = result.rows[0];
    if (!row) return null;

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
}
