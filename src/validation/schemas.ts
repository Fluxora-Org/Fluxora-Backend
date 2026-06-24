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

/** Regex for valid decimal strings: optional sign, digits, optional fraction */
export const DECIMAL_STRING_REGEX = /^[+-]?\d+(\.\d+)?$/;

/** Regex for valid Stellar public keys: G followed by 55 base32 characters */
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

/** Reusable decimal-string field schema */
function decimalStringField(fieldName: string) {
  return z
    .string({ error: `${fieldName} must be a decimal string, not a number` })
    .regex(DECIMAL_STRING_REGEX, `${fieldName} must be a valid decimal string (e.g. "100", "0.0000116")`);
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

/** Format Zod issues into a flat error array for API responses */
export function formatZodIssues(issues: z.ZodIssue[]): Array<{ field: string; message: string }> {
  return issues.map((issue) => ({
    field: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}
