/**
 * PII sanitization utilities.
 *
 * Provides functions to redact sensitive fields from arbitrary objects
 * before they are written to logs, included in error payloads, or
 * returned in non-public API responses.
 */

import { redactableFields } from './policy.js';

const REDACTED = '[REDACTED]';
const STELLAR_KEY_RE = /^G[A-Z2-7]{55}$/;

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
 * Deep-clones a plain object and replaces every field whose name
 * appears in the redactable set with a redacted placeholder.
 *
 * Stellar public keys receive a partial mask; all other sensitive
 * fields are fully redacted.
 */
export function sanitize<T extends Record<string, unknown>>(obj: T): T {
  const fields = redactableFields();
  return sanitizeInner(obj, fields) as T;
}

function sanitizeInner(
  value: unknown,
  fields: Set<string>,
): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInner(item, fields));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (fields.has(key)) {
        result[key] = typeof val === 'string' ? maskStellarKey(val) : REDACTED;
      } else {
        result[key] = sanitizeInner(val, fields);
      }
    }
    return result;
  }

  return value;
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
  const globalRe = /G[A-Z2-7]{55}/g;
  return input.replace(globalRe, (match) => maskStellarKey(match));
}
