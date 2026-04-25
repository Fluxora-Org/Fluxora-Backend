/**
 * PII sanitization utilities.
 *
 * Provides functions to redact sensitive fields from arbitrary objects
 * before they are written to logs, included in error payloads, or
 * returned in non-public API responses.
 *
 * Security notes:
 * - Uses a deny-list sourced from `policy.ts` — the single source of truth.
 * - Decimal/amount strings are intentionally left untouched; the sanitizer
 *   never coerces strings to numbers, so financial precision is preserved.
 * - Stellar public keys receive a partial mask (first 4 + last 4 chars) so
 *   operators can correlate events without the full key appearing in logs.
 * - All other sensitive fields are fully replaced with `[REDACTED]`.
 * - The input object is never mutated; a deep clone is always returned.
 */

import { redactableFields } from './policy.js';

export const REDACTED = '[REDACTED]';

/** Matches a valid Stellar public key: starts with G, 56 base-32 chars total. */
const STELLAR_KEY_RE = /^G[A-Z2-7]{55}$/;

/** Global variant used for scanning free-form strings. */
const STELLAR_KEY_GLOBAL_RE = /G[A-Z2-7]{55}/g;

/**
 * Masks a Stellar public key, preserving the first 4 and last 4
 * characters so operators can still correlate events without
 * exposing the full key in logs.
 *
 * Non-matching strings are returned as the generic redaction marker.
 */
export function maskStellarKey(value: string): string {
  if (STELLAR_KEY_RE.test(value)) {
    return `${value.slice(0, 4)}..${value.slice(-4)}`;
  }
  return REDACTED;
}

/**
 * Returns true if the value looks like a Stellar public key.
 * Useful for opportunistic redaction of unstructured strings.
 */
export function isStellarKey(value: string): boolean {
  return STELLAR_KEY_RE.test(value);
}

/**
 * Scans a free-form string for Stellar public keys and replaces
 * each occurrence with a masked version. Handles keys embedded
 * in larger text (log lines, error messages).
 */
export function redactKeysInString(input: string): string {
  return input.replace(STELLAR_KEY_GLOBAL_RE, (match) => maskStellarKey(match));
}

/**
 * Deep-clones a plain object/array and replaces every field whose name
 * appears in the redactable set with a redacted placeholder.
 *
 * Key invariants:
 * - String values in sensitive fields that match the Stellar key pattern
 *   receive a partial mask; all others are fully redacted.
 * - Non-string sensitive values (numbers, booleans, objects, null,
 *   undefined) are replaced with `[REDACTED]` — no type coercion occurs.
 * - Non-sensitive string values (including decimal amount strings) are
 *   passed through as-is, preserving full precision.
 * - Error objects are specially handled to redact sensitive data in
 *   error messages and stack traces.
 *
 * @param obj - The object to sanitize. Must be a plain object or array.
 * @returns A new deep-cloned object with sensitive fields redacted.
 */
export function sanitize<T extends Record<string, unknown>>(obj: T): T {
  const fields = redactableFields();
  return sanitizeValue(obj, fields) as T;
}

/**
 * Sanitizes an error object, redacting sensitive data from error messages
 * and stack traces while preserving error structure.
 */
export function sanitizeError(error: Error): Record<string, unknown> {
  const fields = redactableFields();
  const result: Record<string, unknown> = {
    name: error.name,
    message: redactKeysInString(error.message),
  };

  // Redact sensitive data from stack traces
  if (error.stack) {
    result.stack = redactKeysInString(error.stack);
  }

  // Copy any additional error properties
  for (const [key, value] of Object.entries(error)) {
    if (!['name', 'message', 'stack'].includes(key)) {
      result[key] = sanitizeValue(value, fields);
    }
  }

  return result;
}

/**
 * Internal recursive worker. Handles objects, arrays, and primitives.
 * Deliberately avoids JSON.parse/stringify to preserve type fidelity
 * and avoid any implicit number coercion of decimal strings.
 */
function sanitizeValue(value: unknown, fields: Set<string>): unknown {
  // Primitives and null pass through unchanged (unless the caller
  // already decided to redact the field — handled one level up).
  if (value === null || value === undefined) return value;

  // Handle Error objects specially
  if (value instanceof Error) {
    return sanitizeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, fields));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (fields.has(key.toLowerCase())) {
        // Case-insensitive matching for field names
        // Sensitive field: apply masking or full redaction.
        // IMPORTANT: we never call Number() or parseFloat() here —
        // decimal strings must remain strings.
        if (typeof val === 'string') {
          result[key] = maskStellarKey(val);
        } else {
          result[key] = REDACTED;
        }
      } else {
        result[key] = sanitizeValue(val, fields);
      }
    }
    return result;
  }

  // Primitive (string, number, boolean, bigint, symbol) — pass through.
  return value;
}
