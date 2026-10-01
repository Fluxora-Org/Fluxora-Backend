import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * Contract event structure
 */
export const ContractEventSchema = z.object({
  event_id: z.string(),
  contract_id: z.string(),
  ledger: z.number().int(),
  event_type: z.string(),
  event_data: z.unknown(),
  block_height: z.number().int(),
  transaction_hash: z.string(),
  ingested_at: z.date().nullable().optional(),
  created_at: z.date().nullable().optional(),
});
export type ContractEvent = z.infer<typeof ContractEventSchema>;

/**
 * Replay progress tracking (in-memory, for low-latency status polling).
 * Durable crash-resume state is kept in the `replay_cursors` DB table.
 */
export const ReplayProgressSchema = z.object({
  isReplaying: z.boolean(),
  rowsReplayed: z.number().int(),
  rowsRemaining: z.number().int(),
  totalRows: z.number().int(),
  estimatedCompletion: z.date().nullable(),
  startedAt: z.date().nullable(),
  contractId: z.string().optional(),
  ledger: z.number().int().optional(),
  /** ID of the associated DB-backed cursor row (present while a replay is active). */
  replayCursorId: z.string().optional(),
  /** Offset of the last committed batch boundary (matches last_committed_offset in DB). */
  currentOffset: z.number().int().optional(),
  /** Overall status of the replay from the checkpoint ('in-progress' | 'completed'). */
  status: z.string().optional(),
});
export type ReplayProgress = z.infer<typeof ReplayProgressSchema>;

/**
 * Durable DB-backed cursor that persists replay progress across process crashes.
 * Stored in the `replay_cursors` table; updated atomically within each batch transaction.
 */
export const ReplayCursorSchema = z.object({
  /** UUID primary key */
  id: z.string(),
  contract_id: z.string(),
  ledger: z.number().int(),
  from_block: z.number().int().nullable().optional(),
  to_block: z.number().int().nullable().optional(),
  /** Total number of source rows discovered at replay start. */
  total_rows: z.number().int(),
  /** Rows consumed so far; updated at the end of every committed batch. */
  last_committed_offset: z.number().int(),
  started_at: z.date(),
  /** Set once all batches have been committed; null while in progress. */
  completed_at: z.date().nullable(),
});
export type ReplayCursor = z.infer<typeof ReplayCursorSchema>;

/**
 * Replay request parameters
 */
export const ReplayRequestSchema = z.object({
  contract_id: z.string(),
  ledger: z.number().int(),
  from_block: z.number().int().optional(),
  to_block: z.number().int().optional(),
});
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

