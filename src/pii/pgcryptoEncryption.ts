/**
 * pgcrypto helper utilities for stream PII encryption.
 *
 * This module centralizes the application-side pieces of the encryption
 * design so the repository layer can stay readable and safe.
 */

import crypto from 'crypto';

export const PGCRYPTO_KEY_MIN_LENGTH = 32;
export const PGP_SYM_ENCRYPT_OPTIONS = 'cipher-algo=aes256,compress-algo=0,armor';
export const PGP_MESSAGE_PREFIX = '-----BEGIN PGP MESSAGE-----';

export interface PgcryptoKeySet {
  current: string;
  previous?: string;
}

/**
 * Compute the deterministic HMAC digest used for address filters and indexes.
 * This preserves query efficiency while keeping the stored address ciphertext
 * unreadable without the key.
 */
export function computeAddressHash(address: string, key: string): string {
  return crypto.createHmac('sha256', key).update(address, 'utf8').digest('hex');
}

export function computeAddressHashes(address: string, keys: PgcryptoKeySet): {
  current: string;
  previous?: string;
} {
  return {
    current: computeAddressHash(address, keys.current),
    previous: keys.previous ? computeAddressHash(address, keys.previous) : undefined,
  };
}

/**
 * Build a pgcrypto encryption expression for a plaintext address parameter.
 */
export function pgpEncryptAddressParam(addressParamIndex: number, keyParamIndex: number): string {
  return `pgp_sym_encrypt($${addressParamIndex}, $${keyParamIndex}, '${PGP_SYM_ENCRYPT_OPTIONS}')`;
}

/**
 * Build a pgcrypto decryption expression for a stored address column.
 */
export function pgpDecryptAddressColumn(
  columnName: string,
  keyParamIndex: number,
  previousKeyParamIndex?: number,
): string {
  const previousArg = previousKeyParamIndex !== undefined ? `$${previousKeyParamIndex}` : 'NULL';
  return `decrypt_stream_address(${columnName}, $${keyParamIndex}, ${previousArg}) AS ${columnName}`;
}

/**
 * Build a filter expression that uses keyed hash lookup first, and falls back
 * to plaintext comparison for legacy rows that have not yet been backfilled.
 */
export function buildEncryptedAddressFilter(
  column: 'sender_address' | 'recipient_address',
  filterValueParamIndex: number,
  currentHashParamIndex: number,
  previousHashParamIndex?: number,
): string {
  const hashClauses = [`${column}_hash = $${currentHashParamIndex}`];
  if (previousHashParamIndex !== undefined) {
    hashClauses.push(`${column}_hash = $${previousHashParamIndex}`);
  }
  const hashCondition = hashClauses.length > 1 ? `(${hashClauses.join(' OR ')})` : hashClauses[0];
  return `(${hashCondition} OR ${column} = $${filterValueParamIndex})`;
}
