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

// ─── API Key Management ───────────────────────────────────────────────────────

/**
 * A stored API key record. The raw key is never persisted — only its SHA-256
 * hex digest is stored so a database breach does not expose live credentials.
 */
export interface ApiKeyRecord {
  /** Stable opaque identifier (cuid2) */
  id: string;
  /** Human-readable label supplied at creation time */
  name: string;
  /** SHA-256 hex digest of the raw key */
  keyHash: string;
  /** Key prefix (first 8 chars) for display / lookup without exposing the full key */
  prefix: string;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-rotated timestamp, or null if never rotated */
  rotatedAt: string | null;
  /** Whether the key is still active */
  active: boolean;
}

/**
 * Returned once at creation / rotation time. The caller must store `key`
 * immediately — it will never be retrievable again.
 */
export interface ApiKeyCreated {
  id: string;
  name: string;
  /** The raw key — shown exactly once */
  key: string;
  prefix: string;
  createdAt: string;
}

// ─── Stream Event Store ───────────────────────────────────────────────────────

/**
 * An append-only record of a contract event as ingested from the chain.
 * Used for replay and debugging. Amounts in payload must follow the
 * decimal-string serialization policy.
 */
export interface StreamEventRecord {
  /** Stable unique identifier for this event (chain-derived) */
  eventId: string;
  /** Ledger sequence number */
  ledger: number;
  /** Ledger hash for reorg detection */
  ledgerHash: string;
  /** Soroban contract ID */
  contractId: string;
  /** Event topic (e.g. "stream.created") */
  topic: string;
  /** Transaction hash */
  txHash: string;
  /** Transaction index within the ledger */
  txIndex: number;
  /** Operation index within the transaction */
  operationIndex: number;
  /** Event index within the operation */
  eventIndex: number;
  /**
   * Arbitrary event payload. Amount fields (depositAmount, ratePerSecond, etc.)
   * MUST be decimal strings per the serialization policy.
   */
  payload: Record<string, unknown>;
  /** ISO-8601 timestamp when the event occurred on-chain */
  happenedAt: string;
  /** ISO-8601 timestamp when the event was ingested into the store */
  ingestedAt: string;
}

/** Filter options for replaying events from the store */
export interface StreamEventReplayFilter {
  /** Only return events at or after this ledger (inclusive) */
  fromLedger?: number;
  /** Only return events at or before this ledger (inclusive) */
  toledger?: number;
  /** Only return events for this contract */
  contractId?: string;
  /** Only return events with this topic */
  topic?: string;
  /** Maximum number of events to return (default 100, max 1000) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/** Result of a replay query */
export interface StreamEventReplayResult {
  events: StreamEventRecord[];
  total: number;
  limit: number;
  offset: number;
}
