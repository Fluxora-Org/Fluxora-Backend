import { describe, it, expect } from 'vitest';
import {
  computeAddressHash,
  computeAddressHashes,
  pgpDecryptAddressColumn,
  pgpEncryptAddressParam,
  buildEncryptedAddressFilter,
} from '../../src/pii/pgcryptoEncryption.js';

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
});
