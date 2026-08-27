/**
 * Unified, network-aware Stellar StrKey validation.
 *
 * This module is the single source of truth for Stellar address validation
 * across every API boundary in Fluxora-Backend:
 *   - REST routes        (src/validation/schemas.ts)
 *   - WebSocket frames   (src/ws/messageHandler.ts)
 *   - Indexer ingestion  (src/validation/schemas.ts StreamBatchCreateSchema)
 *   - On-chain existence (src/validation/stellarAddressValidator.ts)
 *
 * Previously these boundaries each carried a private copy of the StrKey
 * decoding / CRC logic, which drifted over time. Consolidating here guarantees
 * identical behavior everywhere.
 *
 * ── Network source of truth ──────────────────────────────────────────────────
 * The configured network (testnet | mainnet | local) is the authority for what
 * counts as a "valid" address at runtime. It is supplied by the caller (the
 * `StellarNetwork` resolved from `STELLAR_NETWORK` in src/config).
 *
 * Stellar Ed25519 account StrKeys (`G…`, version byte 0x30) are
 * network-agnostic: the *string* alone cannot tell testnet from mainnet. A
 * well-formed account address that simply does not exist on the configured
 * network is therefore treated as **wrong-network** and rejected. That check is
 * necessarily asynchronous (it requires an on-chain lookup) and lives in
 * `StellarAddressValidator`, which is bound to the configured network's RPC.
 *
 * What THIS module can decide synchronously (format + type) is enough to reject
 * the bulk of unsafe input before any RPC call:
 *   - malformed length / alphabet (rejects lowercase / case-variant input)
 *   - bad checksum
 *   - wrong StrKey type: muxed (`M…`, version 0x60), contract (`C…`, 0x10),
 *     seed (`S…`), pre-auth tx (`T…`), hash (`X…`) where an account is expected.
 *
 * @module validation/stellarAddress
 */

import type { StellarNetwork } from '../config/stellar.js';

// SEP-23 StrKey constants shared by every Stellar address type.
export const STELLAR_STRKEY_LENGTH = 56;
export const STELLAR_STRKEY_DECODED_LENGTH = 35;
export const STELLAR_STRKEY_PAYLOAD_LENGTH = 33;
export const STELLAR_STRKEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Version bytes (the first decoded byte) for the well-known StrKey kinds. */
export const STELLAR_STRKEY_VERSION = {
  account: 6 << 3, // 0x30 → G… (56 chars)
  muxed: 12 << 3, // 0x60 → M… (69 chars)
  contract: 2 << 3, // 0x10 → C… (56 chars)
  seed: 18 << 3, // 0x90 → S… (56 chars)
  preAuthTx: 19 << 3, // 0x98 → T… (56 chars)
  hashX: 23 << 3, // 0xB8 → X… (56 chars)
} as const;

/**
 * StrKey frame sizes. Account/contract/seed/tx/hash StrKeys are 56 chars
 * (35 decoded bytes: 1 version + 32 payload + 2 checksum). Muxed (`M…`)
 * addresses carry an 8-byte memo id, making them 69 chars (43 decoded bytes:
 * 1 version + 40 payload + 2 checksum).
 */
export const STELLAR_MUXED_STRKEY_LENGTH = 69;
export const STELLAR_MUXED_STRKEY_DECODED_LENGTH = 43;
export const STELLAR_MUXED_STRKEY_PAYLOAD_LENGTH = 40;

/**
 * Fast structural regex used at synchronous boundaries. It rejects:
 *   - anything that is not 56 chars,
 *   - lowercase / non-base32 chars (the alphabet is uppercase only),
 *   - any StrKey type other than an account (`G` prefix).
 * Checksum verification is intentionally NOT part of the regex; callers that
 * need full validation should use {@link isValidStellarAccountAddress}.
 */
export const STELLAR_ACCOUNT_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

/** All known StrKey kinds plus the catch-all for unrecognized versions. */
export type StellarAddressKind =
  | 'account'
  | 'muxed'
  | 'contract'
  | 'seed'
  | 'preAuthTx'
  | 'hashX'
  | 'invalid';

export interface AddressClassification {
  /** The detected StrKey kind (or 'invalid' when structurally broken). */
  kind: StellarAddressKind;
  /**
   * True only when the value is a structurally valid StrKey of a *recognized*
   * version with a correct CRC16-XModem checksum.
   */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

/** Decode Stellar base32 (RFC 4648, no padding) into bytes, or null on bad char. */
export function decodeStellarBase32(value: string): number[] | null {
  const bytes: number[] = [];
  let bits = 0;
  let current = 0;

  for (const char of value) {
    const digit = STELLAR_STRKEY_ALPHABET.indexOf(char);
    if (digit === -1) return null;

    current = (current << 5) | digit;
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return bytes;
}

/** CRC16-XModem, as used by the Stellar StrKey checksum. */
export function crc16XModem(bytes: readonly number[]): number {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc;
}

const VERSION_TO_KIND: Record<number, StellarAddressKind> = {
  [STELLAR_STRKEY_VERSION.account]: 'account',
  [STELLAR_STRKEY_VERSION.muxed]: 'muxed',
  [STELLAR_STRKEY_VERSION.contract]: 'contract',
  [STELLAR_STRKEY_VERSION.seed]: 'seed',
  [STELLAR_STRKEY_VERSION.preAuthTx]: 'preAuthTx',
  [STELLAR_STRKEY_VERSION.hashX]: 'hashX',
};

/**
 * Classify a Stellar StrKey without any network context.
 *
 * Pure and synchronous. Returns whether the value is a structurally valid
 * StrKey and which kind it is. It does NOT know the configured network, so an
 * account that happens to be on the "wrong" network still classifies as a valid
 * account (use {@link StellarAddressValidator} for the network-aware check).
 */
export function classifyStellarAddress(value: unknown): AddressClassification {
  if (typeof value !== 'string') {
    return { kind: 'invalid', valid: false, reason: 'address must be a string' };
  }

  // Strict: no surrounding whitespace. Account-type StrKeys are exactly 56
  // chars; muxed (`M…`) StrKeys are 69. Anything else is malformed.
  const isMuxed = value.length === STELLAR_MUXED_STRKEY_LENGTH;
  const expectedLength = isMuxed ? STELLAR_MUXED_STRKEY_LENGTH : STELLAR_STRKEY_LENGTH;
  if (value.length !== expectedLength) {
    return {
      kind: 'invalid',
      valid: false,
      reason: `expected ${expectedLength} characters, got ${value.length}`,
    };
  }

  // Uppercase base32 alphabet only. Lowercase or other characters (case
  // variants, homoglyphs) are rejected here before decoding.
  if (!/^[A-Z2-7]+$/.test(value)) {
    return {
      kind: 'invalid',
      valid: false,
      reason: 'address contains characters outside the Stellar base32 alphabet (expected uppercase A-Z and 2-7)',
    };
  }

  const decoded = decodeStellarBase32(value);
  if (decoded === null) {
    return { kind: 'invalid', valid: false, reason: 'base32 decoding failed' };
  }

  const expectedDecodedLength = isMuxed
    ? STELLAR_MUXED_STRKEY_DECODED_LENGTH
    : STELLAR_STRKEY_DECODED_LENGTH;
  if (decoded.length !== expectedDecodedLength) {
    return { kind: 'invalid', valid: false, reason: 'base32 decoding failed' };
  }

  const versionByte = decoded[0]!;
  const kind = VERSION_TO_KIND[versionByte] ?? 'invalid';
  if (kind === 'invalid') {
    return {
      kind: 'invalid',
      valid: false,
      reason: `unrecognized StrKey version byte 0x${versionByte.toString(16)}`,
    };
  }

  const payloadLength = isMuxed
    ? STELLAR_MUXED_STRKEY_PAYLOAD_LENGTH
    : STELLAR_STRKEY_PAYLOAD_LENGTH;
  const payload = decoded.slice(0, payloadLength);
  const expectedChecksum = crc16XModem(payload);
  const actualChecksum =
    decoded[payloadLength]! | (decoded[payloadLength + 1]! << 8);

  if (expectedChecksum !== actualChecksum) {
    return { kind, valid: false, reason: 'StrKey checksum mismatch' };
  }

  return { kind, valid: true };
}

/**
 * Synchronous, format-level validation for an Ed25519 account address
 * (`G…`). Returns true only when the value is a structurally valid account
 * StrKey: correct length, uppercase base32 alphabet, account version byte, and
 * valid CRC16-XModem checksum.
 *
 * This rejects:
 *   - malformed / wrong-length input,
 *   - lowercase / case-variant input,
 *   - muxed (`M…`), contract (`C…`), seed (`S…`), and other non-account types,
 *   - addresses with a corrupted checksum.
 *
 * Note: this cannot detect a *wrong-network* account (the string is
 * network-agnostic). Use {@link StellarAddressValidator} for the network-aware
 * on-chain existence check.
 */
export function isValidStellarAccountAddress(value: unknown): boolean {
  const classification = classifyStellarAddress(value);
  return classification.valid && classification.kind === 'account';
}

/**
 * Human-readable label for a configured network, used in error messages and
 * logs so operators can tell *which* network rejected an address.
 */
export function networkLabel(network: StellarNetwork): string {
  return network;
}
