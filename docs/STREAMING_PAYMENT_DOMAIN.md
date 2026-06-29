# Fluxora Streaming Payment Domain Model

## Overview

Fluxora implements a **streaming payment** model on Stellar Soroban where funds flow continuously from a sender to a recipient at a fixed rate per second. This document describes the core domain concepts and the event types that represent state transitions.

## Core Entities

### Stream

A `Stream` represents a payment channel between two Stellar accounts. Key fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Derived from `transaction_hash + event_index` (deterministic) |
| `contract_id` | string | Soroban contract address owning this stream |
| `sender_address` | string | Stellar account funding the stream |
| `recipient_address` | string | Stellar account receiving the funds |
| `amount` | string (decimal) | Total locked amount in base units |
| `streamed_amount` | string (decimal) | Amount already released to recipient |
| `remaining_amount` | string (decimal) | Amount still locked |
| `rate_per_second` | string (decimal) | Flow rate in base units per second |
| `start_time` | bigint | Unix timestamp (seconds) when streaming begins |
| `end_time` | bigint | Unix timestamp (seconds) when stream completes |
| `status` | enum | `active` | `completed` | `cancelled` |
| `event_index` | number | Position of the originating event within the transaction |

All monetary amounts are stored as decimal strings to preserve precision above `Number.MAX_SAFE_INTEGER`.

## Event Types

Event types are defined in `src/services/streamEventService.ts` and correspond to Soroban contract events.

### `StreamCreated`

Emitted when a new stream is opened on-chain.

```ts
interface StreamCreatedEvent {
  type: "StreamCreated";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  sender: string;
  recipient: string;
  amount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
}
```

**Effect:** Creates a new `streams` row with `status = active`.

### `StreamUpdated`

Emitted when the chain updates progress on an existing stream (e.g. partial withdrawal).

```ts
interface StreamUpdatedEvent {
  type: "StreamUpdated";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  streamId: string;
  streamedAmount?: string;
  remainingAmount?: string;
  status?: StreamStatus;
  endTime?: number;
}
```

**Effect:** Upserts `streamed_amount`, `remaining_amount`, `status`, and/or `end_time`.

### `StreamCancelled`

Emitted when the sender cancels the stream before completion.

```ts
interface StreamCancelledEvent {
  type: "StreamCancelled";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  streamId: string;
}
```

**Effect:** Sets `status = cancelled`.

## Idempotency

Every event is keyed by `(transaction_hash, event_index)`. The `streams` table has a `UNIQUE` constraint on this pair, so re-processing the same event is a no-op. This makes the ingestion pipeline safe to replay.

## Querying

- Contract-scoped queries use `idx_streams_contract_event (contract_id, event_index)`.
- Status + time range queries use `idx_streams_status_start_time`.

See `src/db/repositories/streamRepository.ts` for the full query interface.
