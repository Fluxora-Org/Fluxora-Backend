/**
 * Database schema types for the streams table.
 *
 * These types map directly to the on-chain streaming events with strong typing.
 * All monetary amounts are stored as decimal strings to preserve precision.
 *
 * @module db/types
 */

/**
 * Stream status values
 */
export type StreamStatus = "active" | "paused" | "completed" | "cancelled";

/**
 * Stream record from the database
 */
export interface StreamRecord {
  /** Unique identifier derived from chain event (transaction hash + event index) */
  id: string;

  /** Stellar address of the sender */
  sender_address: string;

  /** Stellar address of the recipient */
  recipient_address: string;

  /** Total streaming amount as decimal string (precision-critical) */
  amount: string;

  /** Amount streamed so far as decimal string */
  streamed_amount: string;

  /** Remaining amount as decimal string */
  remaining_amount: string;

  /** Rate per second as decimal string */
  rate_per_second: string;

  /** Unix timestamp when stream starts */
  start_time: number;

  /** Unix timestamp when stream ends (0 = indefinite) */
  end_time: number;

  /** Current stream status */
  status: StreamStatus;

  /** Soroban contract ID */
  contract_id: string;

  /** Transaction hash that created the stream */
  transaction_hash: string;

  /** Event index within the transaction */
  event_index: number;

  /** When the record was created in the database */
  created_at: string;

  /** When the record was last updated */
  updated_at: string;
}

/**
 * Input for creating a new stream from blockchain event
 */
export interface CreateStreamInput {
  id: string;
  sender_address: string;
  recipient_address: string;
  amount: string;
  streamed_amount: string;
  remaining_amount: string;
  rate_per_second: string;
  start_time: number;
  end_time: number;
  contract_id: string;
  transaction_hash: string;
  event_index: number;
}

/**
 * Update input for stream status or amounts
 */
export interface UpdateStreamInput {
  status?: StreamStatus;
  streamed_amount?: string;
  remaining_amount?: string;
  end_time?: number;
}

/**
 * Filtering options for stream queries
 */
export interface StreamFilter {
  status?: StreamStatus;
  sender_address?: string;
  recipient_address?: string;
  contract_id?: string;
  start_time_from?: number;
  start_time_to?: number;
  end_time_from?: number;
  end_time_to?: number;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  limit: number;
  offset: number;
}

/**
 * Paginated stream results
 */
export interface PaginatedStreams {
  streams: StreamRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Database invariants - guarantees about data correctness
 *
 * These are the service-level guarantees we enforce:
 * 1. Each stream has a unique ID derived deterministically from on-chain data
 * 2. Amounts are always stored as decimal strings (never floating point)
 * 3. Status transitions follow valid state machine: active -> paused/completed/cancelled
 * 4. created_at and updated_at are always populated and immutable after creation
 */
export const STREAM_INVARIANTS = {
  /** IDs are derived from transaction_hash + event_index */
  idPattern: /^stream-[a-f0-9]{64}-\d+$/,

  /** Valid status transitions */
  validTransitions: {
    active: ["paused", "completed", "cancelled"] as const,
    paused: ["active", "cancelled"] as const,
    completed: [] as const,
    cancelled: [] as const,
  },

  /** Amount constraints */
  amountConstraints: {
    maxPrecision: 19,
    maxScale: 7,
  },

  /** Timestamp constraints */
  timestampConstraints: {
    minTime: 0,
    maxTime: 4102444800, // Year 2100 in seconds
  },
} as const;

/** Type for valid status transitions */
export type ValidTransitions = typeof STREAM_INVARIANTS.validTransitions;
