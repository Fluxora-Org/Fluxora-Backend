import { createHash } from 'node:crypto';

/**
 * Compute a SHA-256 hash of the given input string and return it as a hex string.
 * This function is used for non‑reversible identification of sensitive values
 * such as admin bearer tokens before they are written to audit logs.
 */
export function hashStringSHA256(input: string): string {
  // Ensure input is a string; if undefined convert to empty string to avoid errors.
  const data = input ?? '';
  return createHash('sha256').update(data).digest('hex');
}
