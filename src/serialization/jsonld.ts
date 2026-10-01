/**
 * JSON-LD Serialization for Fluxora Streams
 *
 * Produces a machine-readable, self-describing representation of a single
 * payment stream conforming to the Fluxora JSON-LD vocabulary
 * (`https://fluxora.dev/ns/v1`, the current version of
 * FLUXORA_JSONLD_CONTEXT_VERSION).
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
 * 3. The shape is versioned. The `@context` URI, the served context document,
 *    and the emitted properties are all pinned by
 *    `FLUXORA_JSONLD_CONTEXT_VERSION`; removing or renaming a property is a
 *    breaking change requiring a version bump.
 * 4. No PII beyond what is already present in the stream record is emitted.
 *    Stellar addresses are public by design.
 *
 * @module serialization/jsonld
 */

import type { StreamRecord } from '../db/types.js';
import { deriveStreamStatusFromSchedule, type ApiStreamStatus } from '../streams/status.js';
import { serializeToDecimalString } from './decimal.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Version of the Fluxora JSON-LD vocabulary.
 *
 * This integer is the single source of truth for the context URI, the
 * `@vocab` prefix, and the path the context document is served from. Bump it
 * whenever the emitted shape changes; every one of those is derived from it so
 * a bump cannot leave one behind.
 *
 * ⚠️  BREAKING-CHANGE RULE: removing or renaming a property, or changing the
 * datatype of an existing one, requires a new version. Documents already
 * published under `v1` resolve `v1` for their entire lifetime, so mutating
 * `v1` in place would silently reinterpret them. Additive properties that
 * existing consumers can ignore do not require a bump.
 */
export const FLUXORA_JSONLD_CONTEXT_VERSION = 1;

/**
 * Canonical JSON-LD `@context` URI for the Fluxora vocabulary.
 *
 * Derived from {@link FLUXORA_JSONLD_CONTEXT_VERSION} so the version segment
 * can never drift from the constant that defines the shape.
 */
export const FLUXORA_JSONLD_CONTEXT = `https://fluxora.dev/ns/v${FLUXORA_JSONLD_CONTEXT_VERSION}` as const;

/**
 * Path the context document is served from, i.e. the path component of
 * {@link FLUXORA_JSONLD_CONTEXT}. A version bump moves the document, so the
 * URL previously published in `@context` keeps resolving to the version it
 * named.
 */
export const FLUXORA_JSONLD_CONTEXT_PATH = `/ns/v${FLUXORA_JSONLD_CONTEXT_VERSION}`;

/**
 * The context document served at {@link FLUXORA_JSONLD_CONTEXT}.
 *
 * Every term maps to the XSD datatype the serializer emits for that property,
 * so a consumer that dereferences the context learns the type of each value
 * without having to guess it. `tests/serialization/jsonld.test.ts` asserts
 * that this term set matches the keys `toStreamJsonLd()` actually emits.
 */
export const FLUXORA_JSONLD_CONTEXT_DOCUMENT = {
  '@context': {
    '@version': 1.1,
    '@vocab': `${FLUXORA_JSONLD_CONTEXT}#`,
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    identifier: 'xsd:string',
    sender: 'xsd:string',
    recipient: 'xsd:string',
    depositAmount: 'xsd:decimal',
    streamedAmount: 'xsd:decimal',
    remainingAmount: 'xsd:decimal',
    ratePerSecond: 'xsd:decimal',
    startTime: 'xsd:integer',
    endTime: 'xsd:integer',
    status: 'xsd:string',
    contractId: 'xsd:string',
    transactionHash: 'xsd:string',
  },
} as const;

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
    status: deriveStreamStatusFromSchedule({
      startTime: record.start_time,
      endTime: record.end_time,
      status: record.status as ApiStreamStatus,
    }).status,
    contractId: record.contract_id,
    transactionHash: record.transaction_hash,
  };
}
