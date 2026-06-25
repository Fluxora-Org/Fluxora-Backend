/**
 * Zod validation schemas for Fluxora Backend JSON bodies.
 *
 * Issue #6 — Input validation layer (zod/io-ts) for JSON bodies
 *
 * All schemas validate at the trust boundary (public internet → API).
 * Amount fields MUST be decimal strings; numeric types are rejected to
 * prevent floating-point precision loss across the chain/API boundary.
 *
 * @module validation/schemas
 */
import { z } from 'zod';
import { MAX_DECIMAL_INTEGER_PART, STELLAR_DECIMALS } from '../serialization/decimal.js';

/** Regex for valid decimal strings: optional sign, digits, optional fraction */
export const DECIMAL_STRING_REGEX = /^[+-]?\d+(\.\d+)?$/;

/** Regex for valid Stellar public keys: G followed by 55 base32 characters */
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Reusable decimal-string field schema.
 * Validates decimal format, and enforces magnitude and precision bounds:
 * - Magnitude: The integer part must not exceed MAX_DECIMAL_INTEGER_PART (int64 max).
 * - Precision: The fractional part must not exceed STELLAR_DECIMALS (7 decimal places).
 *
 * @param fieldName - The name of the field, used in validation error messages.
 * @returns A Zod string schema with regex and magnitude/precision refinements.
 */
export function decimalStringField(fieldName: string) {
  return z
    .string({ error: `${fieldName} must be a decimal string, not a number` })
    .regex(DECIMAL_STRING_REGEX, `${fieldName} must be a valid decimal string (e.g. "100", "0.0000116")`)
    .refine(
      (val) => {
        // Enforce magnitude limits by validating the integer part against MAX_DECIMAL_INTEGER_PART
        const dotIndex = val.indexOf('.');
        const integerPart = dotIndex === -1 ? val : val.slice(0, dotIndex);
        const absIntegerPart = integerPart.replace(/^[+-]/, '');
        try {
          if (BigInt(absIntegerPart) > MAX_DECIMAL_INTEGER_PART) {
            return false;
          }
        } catch {
          return false;
        }
        return true;
      },
      {
        message: `${fieldName} integer part exceeds maximum supported value`,
      }
    )
    .refine(
      (val) => {
        // Enforce precision limits by checking that the fractional part has at most STELLAR_DECIMALS places
        const dotIndex = val.indexOf('.');
        if (dotIndex !== -1) {
          const decimalPart = val.slice(dotIndex + 1);
          if (decimalPart.length > STELLAR_DECIMALS) {
            return false;
          }
        }
        return true;
      },
      {
        message: `${fieldName} exceeds maximum Stellar precision of ${STELLAR_DECIMALS} decimal places`,
      }
    );
}

/** Reusable Stellar public key field schema */
function stellarPublicKeyField(fieldName: string) {
  return z
    .string({ error: `${fieldName} must be a string` })
    .min(1, `${fieldName} must be a non-empty string`)
    .regex(STELLAR_PUBLIC_KEY_REGEX, `${fieldName} must be a valid Stellar public key (G...)`);
}

/** Reusable non-negative integer field schema */
function nonNegativeIntegerField(fieldName: string) {
  return z
    .number({ error: `${fieldName} must be a number` })
    .int(`${fieldName} must be an integer`)
    .nonnegative(`${fieldName} must be non-negative`);
}

/**
 * Schema for POST /api/streams body.
 *
 * Service-level invariants enforced here:
 * - sender / recipient: valid Stellar public keys (G followed by 55 base32 chars)
 * - depositAmount / ratePerSecond: decimal strings only (not numbers)
 * - startTime / endTime: non-negative integers when provided
 */
export const CreateStreamSchema = z.object({
  sender: stellarPublicKeyField('sender'),
  recipient: stellarPublicKeyField('recipient'),
  depositAmount: decimalStringField('depositAmount').optional(),
  ratePerSecond: decimalStringField('ratePerSecond').optional(),
  startTime: nonNegativeIntegerField('startTime').optional(),
  endTime: nonNegativeIntegerField('endTime').optional(),
});

export type CreateStreamInput = z.infer<typeof CreateStreamSchema>;

/**
 * Schema for batch stream creation at the indexing boundary.
 *
 * The duplicate guard keys entries by the same per-row idempotency coordinates
 * enforced by the streams table: `(transaction_hash, event_index)`.
 */
export const StreamBatchCreateSchema = z.object({
  streams: z
    .array(z.object({
      id: z.string({ error: 'id must be a string' }).min(1, 'id must be a non-empty string'),
      sender_address: stellarPublicKeyField('sender_address'),
      recipient_address: stellarPublicKeyField('recipient_address'),
      amount: decimalStringField('amount'),
      streamed_amount: decimalStringField('streamed_amount'),
      remaining_amount: decimalStringField('remaining_amount'),
      rate_per_second: decimalStringField('rate_per_second'),
      start_time: nonNegativeIntegerField('start_time'),
      end_time: nonNegativeIntegerField('end_time'),
      contract_id: z
        .string({ error: 'contract_id must be a string' })
        .min(1, 'contract_id must be a non-empty string'),
      transaction_hash: z
        .string({ error: 'transaction_hash must be a string' })
        .min(1, 'transaction_hash must be a non-empty string'),
      event_index: nonNegativeIntegerField('event_index'),
    }))
    .max(100, { message: 'Maximum of 100 streams per batch' })
}).superRefine((batch, ctx) => {
  // superRefine lets the validation error identify the offending duplicate row.
  const seen = new Map<string, number>();

  batch.streams.forEach((stream, index) => {
    const identityKey = JSON.stringify([stream.transaction_hash, stream.event_index]);
    const firstIndex = seen.get(identityKey);

    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['streams', index],
        message: `Duplicate stream identity tuple at index ${index}; first seen at index ${firstIndex}`,
      });
      return;
    }

    seen.set(identityKey, index);
  });
});

export type StreamBatchCreateInput = z.infer<typeof StreamBatchCreateSchema>;

/**
 * Schema for GET /api/streams query parameters.
 */
export const ListStreamsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be an integer between 1 and 100')
    .optional(),
  cursor: z.string().optional(),
  include_total: z.enum(['true', 'false'], {
    error: 'include_total must be true or false',
  }).optional(),
});

/**
 * Schema for POST /internal/indexer/events/replay body.
 *
 * Validates the parameters required to trigger a historical contract-event
 * replay. These endpoints trigger expensive DB backfills — the schema
 * enforces sane ranges to prevent absurd workloads from reaching the service.
 *
 * Rules:
 * - contract_id: non-empty string
 * - ledger: non-negative integer
 * - from_block / to_block: optional non-negative integers where from <= to
 */
export const ReplayRequestSchema = z
  .object({
    contract_id: z
      .string({ error: 'contract_id must be a string' })
      .min(1, 'contract_id must be a non-empty string'),
    ledger: nonNegativeIntegerField('ledger'),
    from_block: nonNegativeIntegerField('from_block').optional(),
    to_block: nonNegativeIntegerField('to_block').optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.from_block !== undefined &&
      data.to_block !== undefined &&
      data.from_block > data.to_block
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['from_block'],
        message: 'from_block must be less than or equal to to_block',
      });
    }
  });

export type ReplayRequestInput = z.infer<typeof ReplayRequestSchema>;

/**
 * Schema for DLQ list query parameters.
 */
export const DlqListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be an integer between 1 and 100')
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .optional(),
  topic: z.string().optional(),
});

/**
 * Parse unknown data with a Zod schema.
 * Returns a discriminated union for clean caller-side handling.
 */
export function parseBody<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; issues: z.ZodIssue[] } {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues };
}

/**
 * Known contract event topics emitted by the Fluxora smart-contract.
 *
 * @see ContractEventSchema
 */
export const CONTRACT_EVENT_TOPICS = [
  'stream.created',
  'stream.updated',
  'stream.cancelled',
  'stream.completed',
  'stream.funded',
  'stream.withdrawn',
] as const;

export type ContractEventTopic = (typeof CONTRACT_EVENT_TOPICS)[number];

/**
 * Typed schema for a single contract event delivered to
 * POST /internal/indexer/contract-events.
 *
 * @remarks
 * - `topic` is constrained to the {@link CONTRACT_EVENT_TOPICS} enum so
 *   unrecognised topics are rejected at the ingest boundary.
 * - `payload` must be an object (not a primitive, array, or null) to prevent
 *   ingesting structurally malformed chain data.
 * - `strictObject` is used intentionally: unknown extra keys on the top-level
 *   event are rejected, preventing forged or malformed event shapes from
 *   reaching the store. `payload` is kept open so contract-specific fields
 *   can evolve without breaking the ingest schema.
 */
export const ContractEventSchema = z.strictObject({
  /** Application-level deduplication key for this event. */
  eventId: z.string().min(1, 'eventId must be a non-empty string'),
  /** Stellar ledger sequence number in which the event was emitted. */
  ledger: z.number().int().nonnegative('ledger must be a non-negative integer'),
  /** Soroban contract address that emitted the event. */
  contractId: z.string().min(1, 'contractId must be a non-empty string'),
  /** Semantic event type; must be one of the known Fluxora contract topics. */
  topic: z.enum(CONTRACT_EVENT_TOPICS),
  /** Hash of the transaction that emitted this event. */
  txHash: z.string().min(1, 'txHash must be a non-empty string'),
  /** Position of the transaction within the ledger. */
  txIndex: z.number().int().nonnegative('txIndex must be a non-negative integer'),
  /** Position of the operation within the transaction. */
  operationIndex: z.number().int().nonnegative('operationIndex must be a non-negative integer'),
  /** Position of the event within the operation. */
  eventIndex: z.number().int().nonnegative('eventIndex must be a non-negative integer'),
  /** Arbitrary chain-derived event data; amount-like fields must be decimal strings. */
  payload: z.record(z.string(), z.unknown()).refine(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    'payload must be a non-null object',
  ),
  /** ISO-8601 close time of the ledger that included this event. */
  happenedAt: z.string().min(1, 'happenedAt must be a non-empty string'),
  /** Content hash of the ledger header — used for reorg detection. */
  ledgerHash: z.string().min(1, 'ledgerHash must be a non-empty string'),
});

export type ContractEventInput = z.infer<typeof ContractEventSchema>;

/**
 * Batch wrapper for POST /internal/indexer/contract-events.
 * Rejects duplicate eventIds within a single batch at validation time.
 */
export const ContractEventBatchSchema = z
  .object({
    events: z.array(ContractEventSchema).min(1, 'events must not be empty').max(100, 'events must not exceed 100 per batch'),
  })
  .superRefine((batch, ctx) => {
    const seen = new Map<string, number>();
    batch.events.forEach((event, index) => {
      const prior = seen.get(event.eventId);
      if (prior !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', index, 'eventId'],
          message: `Duplicate eventId "${event.eventId}" at index ${index}; first seen at index ${prior}`,
        });
        return;
      }
      seen.set(event.eventId, index);
    });
  });

export type ContractEventBatchInput = z.infer<typeof ContractEventBatchSchema>;

/** Format Zod issues into a flat error array for API responses */
export function formatZodIssues(issues: z.ZodIssue[]): Array<{ field: string; message: string }> {
  return issues.map((issue) => ({
    field: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}
