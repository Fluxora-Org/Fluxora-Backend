/**
 * JSON-LD Serialization for Fluxora Streams
 *
 * Produces a machine-readable, self-describing representation of a single
 * payment stream conforming to the Fluxora JSON-LD vocabulary
 * (`https://fluxora.dev/ns/v1`).
 *
 * Purpose
 * ───────
 * The plain `GET /api/streams/:id` endpoint returns an application/json
 * envelope optimised for API consumers. This module produces an
 * `application/ld+json` document for data-portability use-cases: archives,
 * semantic-web tooling, compliance exports, and cross-system interoperability.
 *
 * Design invariants
 * ─────────────────
 * 1. All monetary amount fields are serialised as decimal strings via
 *    `serializeToDecimalString()` to preserve full precision across the
 *    chain/API boundary. Floating-point conversion is never applied.
 * 2. The `@id` field uses a resolvable URI so the document is self-describing
 *    when dereferenced by linked-data processors.
 * 3. The shape is stable — removing or renaming properties is a breaking change
 *    requiring a new context version.
 * 4. No PII beyond what is already present in the stream record is emitted.
 *    Stellar addresses are public by design.
 *
 * @module serialization/jsonld
 */

import type { StreamRecord } from '../db/types.js';
import { serializeToDecimalString } from './decimal.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical JSON-LD `@context` URI for the Fluxora vocabulary.
 *
 * This URI is intentionally versioned at `v1`. If breaking schema changes are
 * ever required, a new context URI (e.g. `https://fluxora.dev/ns/v2`) must be
 * minted rather than mutating this one so existing consumers do not silently
 * break.
 */
export const FLUXORA_JSONLD_CONTEXT = 'https://fluxora.dev/ns/v1';

/**
 * Base URI used to construct the `@id` of a stream document.
 *
 * Appending `/<id>` yields a resolvable REST path that linked-data processors
 * can dereference to retrieve the canonical JSON-LD representation.
 */
export const FLUXORA_STREAM_BASE_URI = 'https://fluxora.dev/streams';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/**
 * Shape of a Fluxora JSON-LD PaymentStream document.
 *
 * All amount fields are strings to preserve decimal precision.
 * `startTime` and `endTime` are Unix timestamps (seconds since epoch).
 * `endTime` of `0` denotes an indefinite stream.
 */
export interface StreamJsonLd {
  '@context': typeof FLUXORA_JSONLD_CONTEXT;
  '@type': 'PaymentStream';
  /** Resolvable URI uniquely identifying this stream document. */
  '@id': string;
  /** Opaque stream identifier derived from the on-chain event. */
  identifier: string;
  /** Stellar address of the fund sender. */
  sender: string;
  /** Stellar address of the fund recipient. */
  recipient: string;
  /** Total deposited amount as a decimal string. */
  depositAmount: string;
  /** Amount already streamed as a decimal string. */
  streamedAmount: string;
  /** Remaining amount yet to be streamed as a decimal string. */
  remainingAmount: string;
  /** Streaming rate expressed in tokens per second as a decimal string. */
  ratePerSecond: string;
  /** Unix timestamp (seconds) when the stream starts. */
  startTime: number;
  /** Unix timestamp (seconds) when the stream ends; `0` means indefinite. */
  endTime: number;
  /** Current lifecycle status of the stream. */
  status: string;
  /** Soroban smart-contract ID that governs this stream. */
  contractId: string;
  /** Transaction hash of the on-chain event that created or last updated this stream. */
  transactionHash: string;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Map a `StreamRecord` (database row) to a Fluxora JSON-LD document.
 *
 * All monetary fields are passed through `serializeToDecimalString()`, which
 * validates the stored decimal string and normalises trailing zeros (e.g.
 * `"100.50"` → `"100.5"`). An invalid stored value surfaces as a
 * `DecimalSerializationError` and propagates to the route's error handler,
 * which maps it to a `500 DECIMAL_ERROR` response. This is intentional —
 * bad data in the store is a server-side invariant violation, not a client
 * input error.
 *
 * @param record - A fully-populated `StreamRecord` from the database.
 * @returns      - A `StreamJsonLd` document ready for JSON serialisation.
 *
 * @example
 * ```typescript
 * const doc = toStreamJsonLd(record);
 * res.type('application/ld+json').send(JSON.stringify(doc));
 * ```
 */
export function toStreamJsonLd(record: StreamRecord): StreamJsonLd {
  return {
    '@context': FLUXORA_JSONLD_CONTEXT,
    '@type': 'PaymentStream',
    '@id': `${FLUXORA_STREAM_BASE_URI}/${record.id}`,
    identifier: record.id,
    sender: record.sender_address,
    recipient: record.recipient_address,
    depositAmount: serializeToDecimalString(record.amount, 'depositAmount'),
    streamedAmount: serializeToDecimalString(record.streamed_amount, 'streamedAmount'),
    remainingAmount: serializeToDecimalString(record.remaining_amount, 'remainingAmount'),
    ratePerSecond: serializeToDecimalString(record.rate_per_second, 'ratePerSecond'),
    startTime: record.start_time,
    endTime: record.end_time,
    status: record.status,
    contractId: record.contract_id,
    transactionHash: record.transaction_hash,
  };
}
