import { createHash } from 'node:crypto';

/**
 * Compute a SHA-256 hash of the given input string and return it as a hex string.
 *
 * GUARANTEE: Provides a non-reversible identification of sensitive values
 * (such as admin bearer tokens) suitable for audit logs.
 * LIMITS: This is a fast cryptographic hash and is NOT constant time.
 * It is NOT suitable for hashing passwords and MUST NOT be used for
 * comparing secrets where timing attacks are a concern.
 */
export function hashStringSHA256(input: string): string {
  // Ensure input is a string; if undefined convert to empty string to avoid errors.
  const data = input ?? '';
  return createHash('sha256').update(data).digest('hex');
}
