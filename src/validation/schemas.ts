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
import {
  MAX_DECIMAL_INTEGER_PART,
  STELLAR_DECIMALS,
} from '../serialization/decimal.js';

/** Regex for valid decimal strings: optional sign, digits, optional fraction */
export const DECIMAL_STRING_REGEX = /^[+-]?\d+(\.\d+)?$/;

/** Regex for valid Stellar public keys: G followed by 55 base32 characters */
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

function getDecimalParts(value: string): { integerPart: string; fractionalPart: string } {
  const [integerPart = '', fractionalPart = ''] = value.split('.');
  return {
    integerPart: integerPart.replace(/^[+-]/, ''),
    fractionalPart,
  };
}

function isWithinDecimalMagnitude(value: string): boolean {
  try {
    const { integerPart } = getDecimalParts(value);
    return BigInt(integerPart) <= MAX_DECIMAL_INTEGER_PART;
  } catch {
    return false;
  }
}

function hasStellarPrecision(value: string): boolean {
  return getDecimalParts(value).fractionalPart.length <= STELLAR_DECIMALS;
}

/** Reusable decimal-string field schema */
function decimalStringField(fieldName: string) {
  return z
    .string({ error: `${fieldName} must be a decimal string, not a number` })
    .regex(DECIMAL_STRING_REGEX, `${fieldName} must be a valid decimal string (e.g. "100", "0.0000116")`)
    .refine(isWithinDecimalMagnitude, {
      message: `${fieldName} exceeds the maximum supported integer part`,
    })
    .refine(hasStellarPrecision, {
      message: `${fieldName} cannot exceed ${STELLAR_DECIMALS} fractional digits`,
    });
}

/** Reusable Stellar public key field schema */
function stellarPublicKeyField(fieldName: string) {
  return z
    .string({ error: `${fieldName} must be a string` })
    .min(1, `${fieldName} must be a non-empty string`)
    .regex(STELLAR_PUBLIC_KEY_REGEX, `${fieldName} must be a valid Stellar public key (G...)`);
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
  depositAmount: decimalStringField('depositAmount')
    .refine((val) => parseFloat(val) > 0, {
      message: 'depositAmount must be a positive numeric string',
    })
    .optional(),
  ratePerSecond: decimalStringField('ratePerSecond')
    .refine((val) => parseFloat(val) > 0, {
      message: 'ratePerSecond must be a positive numeric string',
    })
    .optional(),
  startTime: z
    .number({ error: 'startTime must be a number' })
    .int('startTime must be an integer')
    .nonnegative('startTime must be a non-negative number')
    .optional(),
  endTime: z
    .number({ error: 'endTime must be a number' })
    .int('endTime must be an integer')
    .nonnegative('endTime must be a non-negative integer')
    .optional(),
});

export type CreateStreamInput = z.infer<typeof CreateStreamSchema>;

export const StreamBatchCreateSchema = z.object({
  streams: z.array(CreateStreamSchema).max(100, { message: 'Maximum of 100 streams per batch' })
});

export type StreamBatchCreateInput = {
  streams: CreateStreamInput[];
};

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
