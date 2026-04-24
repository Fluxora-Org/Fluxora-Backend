/**
 * Indexer domain types for Fluxora Backend.
 *
 * Design constraints
 * ------------------
 * - All amount / balance fields are `DecimalString` (a branded string alias).
 *   This prevents floating-point coercion at the type boundary and makes it
 *   impossible to accidentally pass a raw `number` where financial precision
 *   is required.
 * - Block identity uses both `ledger` (sequence number) and `ledgerHash`
 *   (content hash). The hash is the authoritative identity for reorg detection:
 *   two blocks at the same sequence number with different hashes mean a fork.
 * - `ingestedAt` is always set by the store, never trusted from the caller.
 */

// ---------------------------------------------------------------------------
// Primitive branded types
// ---------------------------------------------------------------------------

/**
 * A non-empty string that represents a decimal number (e.g. "100.0000000").
 * Using a branded type prevents raw `number` values from being assigned here
 * and makes precision-loss bugs a compile-time error.
 */
export type DecimalString = string & { readonly __brand: 'DecimalString' };

/**
 * Cast a plain string to DecimalString after validation.
 * Throws if the value does not match the decimal pattern.
 */
export function toDecimalString(value: string): DecimalString {
  if (!/^[+-]?\d+(\.\d+)?$/.test(value.trim())) {
    throw new TypeError(`Invalid decimal string: "${value}"`);
  }
  return value as DecimalString;
}

// ---------------------------------------------------------------------------
// Block / ledger types
// ---------------------------------------------------------------------------

/**
 * Minimal representation of a Stellar ledger header as seen by the indexer.
 * The indexer only needs the fields required for sequencing and reorg detection.
 */
export type LedgerHeader = {
  /** Stellar ledger sequence number (monotonically increasing). */
  ledger: number;
  /** SHA-256 hash of the ledger header — the canonical block identity. */
  ledgerHash: string;
  /** Previous ledger hash — used to verify chain continuity. */
  previousLedgerHash: string;
  /** ISO-8601 close time of the ledger. */
  closedAt: string;
};

/**
 * A transaction within a ledger, as seen by the indexer.
 * Amount fields use DecimalString to preserve Stellar's 7-decimal precision.
 */
export type IndexedTransaction = {
  txHash: string;
  ledger: number;
  ledgerHash: string;
  txIndex: number;
  /** Fee paid in XLM, serialised as a decimal string (e.g. "0.0000100"). */
  feePaid: DecimalString;
  /** ISO-8601 timestamp of the ledger that included this transaction. */
  happenedAt: string;
};

/**
 * A single contract event emitted within a transaction.
 * This is the primary unit of storage in the indexer.
 *
 * Security note: `payload` is an opaque JSON object sourced from the chain.
 * Any amount-like fields inside `payload` must be validated as DecimalString
 * by the consumer before arithmetic operations.
 */
export type ContractEventRecord = {
  eventId: string;
  ledger: number;
  contractId: string;
  topic: string;
  txHash: string;
  txIndex: number;
  operationIndex: number;
  eventIndex: number;
  /** Arbitrary chain-derived data. Amount fields inside must be strings. */
  payload: Record<string, unknown>;
  happenedAt: string;
  ledgerHash: string;
  /** Set by the store at write time; never trusted from the caller. */
  ingestedAt?: string;
};

// ---------------------------------------------------------------------------
// Ingest request / result types
// ---------------------------------------------------------------------------

export type IngestContractEventsRequest = {
  events: ContractEventRecord[];
};

export type IngestContractEventsResult = {
  insertedCount: number;
  duplicateCount: number;
  insertedEventIds: string[];
  duplicateEventIds: string[];
};

// ---------------------------------------------------------------------------
// Store / health types
// ---------------------------------------------------------------------------

export type IndexerStoreKind = 'memory' | 'postgres';

export type IndexerDependencyState = 'healthy' | 'degraded' | 'unavailable';

/**
 * Reorg undo-log entry.
 *
 * When the store detects a fork at `ledger`, it records the set of eventIds
 * that were removed so that:
 *  1. Operators can audit what was rolled back.
 *  2. Tests can assert the exact undo boundary.
 *  3. Double-counting is prevented — the same eventId cannot be re-inserted
 *     at a different ledger without first being rolled back.
 */
export type ReorgRecord = {
  /** The ledger sequence at which the fork was detected. */
  forkLedger: number;
  /** The hash that was stored before the rollback. */
  evictedHash: string;
  /** The new hash that triggered the rollback. */
  incomingHash: string;
  /** EventIds removed from the store during this rollback. */
  removedEventIds: string[];
  /** ISO-8601 timestamp of when the rollback was executed. */
  rolledBackAt: string;
};

export type IndexerHealthSnapshot = {
  dependency: IndexerDependencyState;
  store: IndexerStoreKind;
  lastSuccessfulIngestAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  acceptedBatchCount: number;
  acceptedEventCount: number;
  duplicateEventCount: number;
  lastSafeLedger: number;
  reorgDetected: boolean;
  reorgHeight?: number | undefined;
};
