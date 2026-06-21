import type { QueryResultRow } from 'pg';

/**
 * Contract event structure
 */
export interface ContractEvent extends QueryResultRow {
  event_id: string;
  contract_id: string;
  ledger: number;
  event_type: string;
  event_data: unknown;
  block_height: number;
  transaction_hash: string;
  ingested_at?: Date | null;
  created_at?: Date;
}

/**
 * Replay progress tracking (in-memory, for low-latency status polling).
 * Durable crash-resume state is kept in the `replay_cursors` DB table.
 */
export interface ReplayProgress {
  isReplaying: boolean;
  rowsReplayed: number;
  rowsRemaining: number;
  totalRows: number;
  estimatedCompletion: Date | null;
  startedAt: Date | null;
  contractId?: string;
  ledger?: number;
  /** ID of the associated DB-backed cursor row (present while a replay is active). */
  replayCursorId?: string;
  /** Offset of the last committed batch boundary (matches last_committed_offset in DB). */
  currentOffset?: number;
}

/**
 * Durable DB-backed cursor that persists replay progress across process crashes.
 * Stored in the `replay_cursors` table; updated atomically within each batch transaction.
 */
export interface ReplayCursor extends QueryResultRow {
  /** UUID primary key */
  id: string;
  contract_id: string;
  ledger: number;
  from_block?: number | null;
  to_block?: number | null;
  /** Total number of source rows discovered at replay start. */
  total_rows: number;
  /** Rows consumed so far; updated at the end of every committed batch. */
  last_committed_offset: number;
  started_at: Date;
  /** Set once all batches have been committed; null while in progress. */
  completed_at: Date | null;
}

/**
 * Replay request parameters
 */
export interface ReplayRequest {
  contract_id: string;
  ledger: number;
  from_block?: number;
  to_block?: number;
}

