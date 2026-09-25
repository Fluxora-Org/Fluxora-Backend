# Indexer Domain Types — Chain Provenance

This document is the authoritative source for field provenance in
`src/indexer/types.ts`. Every field is classified as either:

- **Chain** — read directly from a Stellar ledger structure (the source
  structure is named); or
- **Computed** — derived by the indexer itself (the derivation is described).

Keep this file in sync with `types.ts`. If a field is added or removed,
update both files in the same commit.

---

## `DecimalString` (branded primitive)

A branded alias for `string`. Computed by the caller via `toDecimalString()`
after reading a raw numeric string from chain data. The branding exists
entirely within TypeScript — no runtime overhead. It enforces that
floating-point coercion cannot occur at the type boundary.

---

## `LedgerHeader`

Minimal representation of a Stellar ledger header. The indexer reads only
the fields it needs for sequencing and reorg detection; it does not store
the full header.

| Field | Origin | Source |
|---|---|---|
| `ledger` | **Chain** | `LedgerHeader.ledgerSeq` in the Stellar XDR ledger header. Monotonically increasing sequence number assigned by the network. |
| `ledgerHash` | **Chain** | SHA-256 hash of the serialised XDR ledger header. Exposed by Stellar RPC as the `hash` field of a ledger response. This is the canonical identity of a ledger — two entries at the same `ledger` sequence but with different hashes indicate a fork. |
| `previousLedgerHash` | **Chain** | `LedgerHeader.previousLedgerHash` in the XDR header. Used to verify chain continuity during sequential ingest. |
| `closedAt` | **Chain** | `LedgerHeader.scpValue.closeTime` in the XDR header, normalised to ISO-8601 by the chain worker before delivery. |

---

## `IndexedTransaction`

A transaction within a ledger, as seen by the indexer.

| Field | Origin | Source |
|---|---|---|
| `txHash` | **Chain** | SHA-256 hash of the transaction envelope XDR (`TransactionEnvelope`). Returned as `hash` in Stellar RPC `getTransaction` and `getTransactions` responses. |
| `ledger` | **Chain** | `LedgerHeader.ledgerSeq` of the ledger that closed with this transaction. Same source as `LedgerHeader.ledger`. |
| `ledgerHash` | **Chain** | Hash of the ledger that included this transaction. Same source as `LedgerHeader.ledgerHash`. Carried on `IndexedTransaction` so that each transaction record is self-contained for reorg detection without a separate ledger lookup. |
| `txIndex` | **Chain** | Zero-based position of the transaction within its ledger's transaction set (`GeneralizedTransactionSet` ordering). Exposed by the Stellar RPC as `applicationOrder` (minus one to zero-base it). |
| `feePaid` | **Chain** | Actual fee charged, in stroops, from `TransactionResult.feeCharged`. Serialised as a `DecimalString` (e.g. `"0.0000100"`) to preserve 7-decimal XLM precision. Conversion: `feeCharged stroops / 10_000_000`. |
| `happenedAt` | **Chain** | Close time of the enclosing ledger (`LedgerHeader.scpValue.closeTime`), normalised to ISO-8601. Same value as `LedgerHeader.closedAt`. Duplicated here so a transaction record is self-contained. |

---

## `ContractEventRecord`

The primary unit of storage. One record per contract event emitted within a
transaction.

| Field | Origin | Source |
|---|---|---|
| `eventId` | **Chain** | Globally unique identifier assigned by the Stellar network to the event. Corresponds to the `id` field returned by Stellar RPC `getEvents`. Its format encodes the ledger sequence, transaction order, and event position (e.g. `0000000171798691840-0000000001`). |
| `ledger` | **Chain** | `LedgerHeader.ledgerSeq` of the ledger that closed with the transaction that emitted this event. Same source as `LedgerHeader.ledger`. |
| `contractId` | **Chain** | Strkey-encoded contract address (`C…`) from the event's `contractId` field in the XDR `ContractEvent`. Returned by Stellar RPC as `contractId` on each event entry. |
| `topic` | **Chain** | First element of the XDR `ContractEvent.body.v0.topics` vector, decoded from SCVal to a string by the chain worker. Identifies the event type (e.g. `"transfer"`, `"mint"`). |
| `txHash` | **Chain** | SHA-256 hash of the transaction envelope that emitted this event. Same source as `IndexedTransaction.txHash`. |
| `txIndex` | **Chain** | Zero-based position of the containing transaction within its ledger's transaction set. Same source as `IndexedTransaction.txIndex`. |
| `operationIndex` | **Chain** | Zero-based position of the operation within the transaction that emitted the event. Derived from the event's `id` field or from the RPC event entry's position metadata. |
| `eventIndex` | **Chain** | Zero-based position of this event within the operation that emitted it. Derived from the event's `id` field or from the RPC event entry's position metadata. |
| `payload` | **Chain** | Decoded `ContractEvent.body.v0.data` SCVal, converted to a plain JSON object by the chain worker. Amount-like fields inside `payload` are strings; consumers must call `toDecimalString()` before arithmetic. The indexer stores this opaque blob without modification. |
| `happenedAt` | **Chain** | Close time of the enclosing ledger (`LedgerHeader.scpValue.closeTime`), normalised to ISO-8601. Same source as `LedgerHeader.closedAt`. |
| `ledgerHash` | **Chain** | Hash of the enclosing ledger. Same source as `LedgerHeader.ledgerHash`. Carried on every event record to make reorg detection self-contained: if the store already holds a different hash for the same `ledger` sequence, a fork is declared. |
| `ingestedAt` | **Computed** | ISO-8601 wall-clock timestamp set by the store (`InMemoryContractEventStore.insertMany` or `PostgresContractEventStore.insertMany`) at write time using `new Date().toISOString()`. Never accepted from the caller; any value supplied in the ingest request is silently ignored and overwritten. |

---

## `IngestContractEventsRequest`

Wrapper type used only at the HTTP/gRPC boundary. Not stored.

| Field | Origin | Source |
|---|---|---|
| `events` | **Chain** | Array of `ContractEventRecord` values. Each element is validated and mapped from the raw JSON body by `validateEvent()` in `ingestion.ts`. |

---

## `IngestContractEventsResult`

Ingest response summary. Entirely computed by the store; not derived from chain data.

| Field | Origin | Derivation |
|---|---|---|
| `insertedCount` | **Computed** | Number of records in the batch that did not already exist in the store (`insertedEventIds.length`). |
| `duplicateCount` | **Computed** | Number of records in the batch whose `eventId` already existed in the store (`duplicateEventIds.length`). |
| `insertedEventIds` | **Computed** | Ordered list of `eventId` values that were newly written. Populated by the store's `insertMany` implementation. |
| `duplicateEventIds` | **Computed** | Ordered list of `eventId` values that were skipped due to `ON CONFLICT DO NOTHING` (Postgres) or key collision (in-memory). |

---

## `IndexerStoreKind`

Discriminant string literal. Computed by each store implementation at
construction time (`'memory'` or `'postgres'`). Never derived from chain data.

---

## `IndexerDependencyState`

Runtime health classification. Computed by `IndexerIngestionService.setDependencyState()`
based on downstream health probe outcomes. Values: `'healthy'`, `'degraded'`,
`'unavailable'`.

---

## `ReorgRecord`

Undo-log entry written when the store detects a fork.

| Field | Origin | Source |
|---|---|---|
| `forkLedger` | **Computed** | The `ledger` value of the incoming event batch that triggered the reorg check. Set by `IndexerIngestionService.ingest()`. |
| `evictedHash` | **Chain** | The ledger hash previously stored for `forkLedger`. Read back from the store via `getLedgerHash(ledger)` immediately before rollback. Its ultimate source is `LedgerHeader.ledgerHash`. |
| `incomingHash` | **Chain** | The ledger hash carried by the first event in the new batch at `forkLedger`. Its ultimate source is `LedgerHeader.ledgerHash`. |
| `removedEventIds` | **Computed** | Set of `eventId` values evicted from the store by `rollbackBeforeLedger()`. Collected by the store implementation during the rollback sweep. |
| `rolledBackAt` | **Computed** | ISO-8601 wall-clock timestamp of when the rollback was applied, set by the store using `new Date().toISOString()`. |

---

## `IndexerHealthSnapshot`

Operational state snapshot. All fields are computed by the indexer service;
none are derived from chain data.

| Field | Origin | Derivation |
|---|---|---|
| `dependency` | **Computed** | Current `IndexerDependencyState`. Managed by `setDependencyState()`. |
| `store` | **Computed** | `IndexerStoreKind` of the active store implementation. |
| `lastSuccessfulIngestAt` | **Computed** | Wall-clock ISO-8601 timestamp of the most recent successfully committed ingest batch. |
| `lastFailureAt` | **Computed** | Wall-clock ISO-8601 timestamp of the most recent ingest or reorg failure. |
| `lastFailureReason` | **Computed** | Human-readable description of the last failure cause. |
| `acceptedBatchCount` | **Computed** | Running counter of accepted ingest batches since process start (or last `resetRuntimeState()`). |
| `acceptedEventCount` | **Computed** | Running counter of newly inserted events (excludes duplicates) since process start. |
| `duplicateEventCount` | **Computed** | Running counter of duplicate events skipped since process start. |
| `lastSafeLedger` | **Computed** | Highest ledger number considered safe for downstream consumers: `max(lastSafeLedger, maxBatchLedger - 1)`. The minus-one margin guards against partial batches. |
| `reorgDetected` | **Computed** | Boolean latch set `true` when a fork is detected; cleared after the indexer processes five ledgers beyond the fork point. |
| `reorgHeight` | **Computed** | Ledger sequence number at which the most recent fork was detected. Present only while `reorgDetected` is `true`. |

---

## `BackfillConfig`

Static configuration for the backfill scheduler. All fields are
operator-supplied at construction time; none are derived from chain data.

| Field | Origin | Derivation |
|---|---|---|
| `workerCount` | **Computed** | Maximum number of batches processed in parallel. Supplied by the caller. |
| `batchSize` | **Computed** | Number of ledgers (or events) per batch. Supplied by the caller. |
| `maxRetries` | **Computed** | Per-batch retry budget. Supplied by the caller. |

---

## `BackfillCheckpoint`

Durable marker for the highest fully ingested ledger.

| Field | Origin | Source |
|---|---|---|
| `ledger` | **Chain** | Sequence number of the highest ledger whose events have been fully committed. Its ultimate source is `LedgerHeader.ledgerSeq`. |
| `ledgerHash` | **Chain** | Hash of that ledger, used for consistency verification. Its ultimate source is `LedgerHeader.ledgerHash`. |
| `updatedAt` | **Computed** | ISO-8601 wall-clock timestamp of when this checkpoint was last written by the backfill scheduler. |

---

## `BackfillBatch`

A discrete unit of backfill work.

| Field | Origin | Source |
|---|---|---|
| `batchId` | **Computed** | Opaque identifier assigned by the backfill scheduler (e.g. a UUID or a `${startLedger}-${endLedger}` string). Not derived from chain data. |
| `startLedger` | **Computed** | First ledger sequence number in the batch's range. Derived by the scheduler by partitioning the requested ledger range. The values ultimately correspond to `LedgerHeader.ledgerSeq`. |
| `endLedger` | **Computed** | Last ledger sequence number (inclusive) in the batch's range. Same derivation as `startLedger`. |

---

## `BackfillBatchOutcome`

Result of processing a single `BackfillBatch`. All fields are computed.

| Field | Origin | Derivation |
|---|---|---|
| `batchId` | **Computed** | Echoed from the originating `BackfillBatch.batchId`. |
| `ok` | **Computed** | `true` if the batch completed without error; `false` otherwise. |
| `insertedCount` | **Computed** | Total newly inserted events across all ledgers in the batch. Sourced from `IngestContractEventsResult.insertedCount`. |
| `duplicateCount` | **Computed** | Total duplicate events skipped. Sourced from `IngestContractEventsResult.duplicateCount`. |
| `error` | **Computed** | Error message string if `ok` is `false`; absent otherwise. |

---

## `BackfillState`

In-progress backfill snapshot. All fields are computed by the scheduler.

| Field | Origin | Derivation |
|---|---|---|
| `config` | **Computed** | The `BackfillConfig` the scheduler was initialised with. |
| `checkpoint` | **Computed** | The most recently committed `BackfillCheckpoint`. |
| `inFlight` | **Computed** | Batches currently being processed. Managed by the scheduler. |
| `completed` | **Computed** | Successfully processed batch outcomes accumulated so far. |
| `failed` | **Computed** | Failed batch outcomes accumulated so far. |

---

## Validation checklist

To confirm that no field of an indexed record is unaccounted for:

1. `ContractEventRecord.eventId` — traceable to `id` in Stellar RPC `getEvents` response.
2. `ContractEventRecord.ledger` — traceable to `LedgerHeader.ledgerSeq` in XDR.
3. `ContractEventRecord.contractId` — traceable to `ContractEvent.contractId` in XDR.
4. `ContractEventRecord.topic` — traceable to `ContractEvent.body.v0.topics[0]` in XDR.
5. `ContractEventRecord.txHash` — traceable to `TransactionEnvelope` hash in XDR.
6. `ContractEventRecord.txIndex` — traceable to `applicationOrder` in RPC event metadata.
7. `ContractEventRecord.operationIndex` — traceable to event `id` position encoding or RPC metadata.
8. `ContractEventRecord.eventIndex` — traceable to event `id` position encoding or RPC metadata.
9. `ContractEventRecord.payload` — traceable to `ContractEvent.body.v0.data` SCVal in XDR.
10. `ContractEventRecord.happenedAt` — traceable to `LedgerHeader.scpValue.closeTime` in XDR.
11. `ContractEventRecord.ledgerHash` — traceable to SHA-256 of the XDR ledger header.
12. `ContractEventRecord.ingestedAt` — **computed** by the store; not present in any chain structure.
