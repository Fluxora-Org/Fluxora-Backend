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

/** Reusable decimal-string field schema */
function decimalStringField(fieldName: string) {
  return z
    .string({
      required_error: `${fieldName} is required`,
      invalid_type_error: `${fieldName} must be a decimal string, not a number`,
    })
    .regex(DECIMAL_STRING_REGEX, `${fieldName} must be a valid decimal string (e.g. "100", "0.0000116")`);
}

/**
 * Schema for POST /api/streams body.
 *
 * Service-level invariants enforced here:
 * - sender / recipient: non-empty strings
 * - depositAmount / ratePerSecond: decimal strings only (not numbers)
 * - startTime / endTime: non-negative integers when provided
 */
export const CreateStreamSchema = z.object({
  sender: z.string().min(1, 'sender must be a non-empty string'),
  recipient: z.string().min(1, 'recipient must be a non-empty string'),
  depositAmount: decimalStringField('depositAmount').optional(),
  ratePerSecond: decimalStringField('ratePerSecond').optional(),
  startTime: z
    .number({ invalid_type_error: 'startTime must be a number' })
    .int('startTime must be an integer')
    .nonnegative('startTime must be a non-negative integer')
    .optional(),
  endTime: z
    .number({ invalid_type_error: 'endTime must be a number' })
    .int('endTime must be an integer')
    .nonnegative('endTime must be a non-negative integer')
    .optional(),
});

export type CreateStreamInput = z.infer<typeof CreateStreamSchema>;

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
    errorMap: () => ({ message: 'include_total must be true or false' }),
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
