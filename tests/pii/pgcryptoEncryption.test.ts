import { describe, it, expect } from 'vitest';
import {
  computeAddressHash,
  computeAddressHashes,
  pgpDecryptAddressColumn,
  pgpEncryptAddressParam,
  buildEncryptedAddressFilter,
  PGCRYPTO_KEY_MIN_LENGTH,
  PGP_MESSAGE_PREFIX,
} from '../../src/pii/pgcryptoEncryption.js';
import { streamSelectColumns } from '../../src/db/queries/streams.js';

describe('PGCrypto PII encryption helpers', () => {
  const address = 'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY';
  const key = 'a'.repeat(32);
  const previousKey = 'b'.repeat(32);

  it('computes a stable hex digest for address hashing', () => {
    const hash = computeAddressHash(address, key);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeAddressHash(address, key)).toBe(hash);
  });

  it('produces different hashes for different keys', () => {
    const first = computeAddressHash(address, key);
    const second = computeAddressHash(address, previousKey);
    expect(first).not.toBe(second);
  });

  it('computes current and previous hash versions', () => {
    const hashes = computeAddressHashes(address, { current: key, previous: previousKey });
    expect(hashes.current).toHaveLength(64);
    expect(hashes.previous).toHaveLength(64);
    expect(hashes.current).not.toBe(hashes.previous);
  });

  it('omits previous hash when no previous key is provided', () => {
    const hashes = computeAddressHashes(address, { current: key });
    expect(hashes.current).toHaveLength(64);
    expect(hashes.previous).toBeUndefined();
  });

  it('builds pgcrypto encryption SQL with param placeholders', () => {
    expect(pgpEncryptAddressParam(2, 5)).toContain('$2');
    expect(pgpEncryptAddressParam(2, 5)).toContain('$5');
    expect(pgpEncryptAddressParam(2, 5)).toContain('pgp_sym_encrypt(');
  });

  it('builds pgcrypto decryption SQL with optional previous key', () => {
    expect(pgpDecryptAddressColumn('sender_address', 1)).toContain('decrypt_stream_address(sender_address, $1, NULL)');
    expect(pgpDecryptAddressColumn('recipient_address', 1, 2)).toContain('decrypt_stream_address(recipient_address, $1, $2)');
  });

  it('builds a hashed address filter with plaintext fallback', () => {
    const expr = buildEncryptedAddressFilter('sender_address', 2, 3, 4);
    expect(expr).toContain('sender_address_hash = $3');
    expect(expr).toContain('sender_address_hash = $4');
    expect(expr).toContain('sender_address = $2');
  });

  it('builds a hashed address filter with only the current hash (no rotation)', () => {
    const expr = buildEncryptedAddressFilter('recipient_address', 1, 2);
    expect(expr).toContain('recipient_address_hash = $2');
    // No previous hash clause when previousHashParamIndex is omitted
    expect(expr).not.toMatch(/recipient_address_hash = \$3/);
    expect(expr).toContain('recipient_address = $1');
  });

  // ── PGCRYPTO_KEY_MIN_LENGTH constant ──────────────────────────────────────

  it('exports a minimum key length of 32', () => {
    expect(PGCRYPTO_KEY_MIN_LENGTH).toBe(32);
  });

  // ── PGP_MESSAGE_PREFIX sentinel ───────────────────────────────────────────

  it('exports the PGP message prefix sentinel used by the DB function', () => {
    expect(PGP_MESSAGE_PREFIX).toBe('-----BEGIN PGP MESSAGE-----');
  });

  // ── streamSelectColumns SQL shape (encryption ENABLED) ────────────────────
  //
  // These tests lock down the exact SQL fragment that getById, getByEvent,
  // findWithCursor, and find all depend on.  Regression here means addresses
  // would be returned as ciphertext to callers.

  describe('streamSelectColumns — encryption enabled', () => {
    it('wraps sender_address with decrypt_stream_address using current key only', () => {
      const cols = streamSelectColumns(2);
      expect(cols).toContain('decrypt_stream_address(sender_address, $2, NULL) AS sender_address');
    });

    it('wraps recipient_address with decrypt_stream_address using current key only', () => {
      const cols = streamSelectColumns(2);
      expect(cols).toContain('decrypt_stream_address(recipient_address, $2, NULL) AS recipient_address');
    });

    it('includes both previous key args when rotation is active', () => {
      const cols = streamSelectColumns(2, 3);
      expect(cols).toContain('decrypt_stream_address(sender_address, $2, $3) AS sender_address');
      expect(cols).toContain('decrypt_stream_address(recipient_address, $2, $3) AS recipient_address');
    });

    it('uses parameter index $2 for key and $1 for id — matching getById contract', () => {
      // getById builds: params = [id, currentKey, ?previousKey]
      // and calls streamSelectColumns(2, 3?) where 2 = index of currentKey in params
      const colsNoPrev = streamSelectColumns(2);
      expect(colsNoPrev).toContain('$2');
      expect(colsNoPrev).not.toContain('$3');

      const colsWithPrev = streamSelectColumns(2, 3);
      expect(colsWithPrev).toContain('$2');
      expect(colsWithPrev).toContain('$3');
    });

    it('includes all non-address columns unchanged', () => {
      const cols = streamSelectColumns(2);
      for (const col of [
        'id', 'amount', 'streamed_amount', 'remaining_amount',
        'rate_per_second', 'start_time', 'end_time', 'status',
        'contract_id', 'transaction_hash', 'event_index',
        'created_at', 'updated_at',
      ]) {
        expect(cols).toContain(col);
      }
    });

    it('does not contain a bare undecorated sender_address or recipient_address column', () => {
      // A bare column reference would mean ciphertext leaks to the app layer
      const cols = streamSelectColumns(2);
      // Strip the decrypt_stream_address() wrappers, then confirm the raw
      // column names don't appear outside of them
      const stripped = cols.replace(/decrypt_stream_address\([^)]+\) AS \w+/g, '');
      expect(stripped).not.toMatch(/\bsender_address\b/);
      expect(stripped).not.toMatch(/\brecipient_address\b/);
    });
  });

  // ── streamSelectColumns SQL shape (encryption DISABLED / no key) ──────────
  //
  // When PGCRYPTO_KEY is absent the repository layer throws before any SQL is
  // built (resolvePgcryptoKeys fails closed).  These tests confirm the SQL
  // helper itself still produces a consistent structure regardless of caller
  // choice of param index, so the helper is not the source of silent failures.

  describe('streamSelectColumns — encryption disabled (helper-level contract)', () => {
    it('still produces a decrypt_stream_address wrapper regardless of key index value', () => {
      // Even if a caller somehow passed an arbitrary index, the SQL shape
      // is deterministic — decryption is always attempted in SQL.
      // The guard against missing keys lives in resolvePgcryptoKeys(), not here.
      const cols = streamSelectColumns(99);
      expect(cols).toContain('decrypt_stream_address(sender_address, $99, NULL)');
      expect(cols).toContain('decrypt_stream_address(recipient_address, $99, NULL)');
    });

    it('is a pure function — same inputs always produce the same SQL fragment', () => {
      expect(streamSelectColumns(2)).toBe(streamSelectColumns(2));
      expect(streamSelectColumns(2, 3)).toBe(streamSelectColumns(2, 3));
      expect(streamSelectColumns(2)).not.toBe(streamSelectColumns(2, 3));
    });
  });
});
