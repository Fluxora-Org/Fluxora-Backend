/**
 * Contract event structure
 */
export interface ContractEvent {
  event_id: string;
  contract_id: string;
  ledger: number;
  event_type: string;
  event_data: any;
  block_height: number;
  transaction_hash: string;
  ingested_at?: Date | null;
  created_at?: Date;
}

/**
 * Replay progress tracking
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
