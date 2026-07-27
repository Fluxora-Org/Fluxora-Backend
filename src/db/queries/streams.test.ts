/**
 * Unit tests for SQL query fragment builders in src/db/queries/streams.ts
 *
 * These tests verify the SQL fragment shape and parameter indices produced by
 * the helper functions, without requiring a database connection.
 *
 * They serve as regression guards for the `previousKeyParamIndex` /
 * `previousHashParamIndex` code paths used during pgcrypto key rotation.
 */

import { describe, it, expect } from 'vitest';
import {
  streamSelectColumns,
  senderAddressFilterCondition,
  recipientAddressFilterCondition,
  encryptAddressValue,
} from './streams.js';
import {
  pgpDecryptAddressColumn,
  pgpEncryptAddressParam,
  buildEncryptedAddressFilter,
} from '../../pii/pgcryptoEncryption.js';

describe('streamSelectColumns', () => {
  it('wraps sender_address with decrypt_stream_address using current key only', () => {
    const cols = streamSelectColumns(2);
    expect(cols).toContain('decrypt_stream_address(sender_address, $2, NULL) AS sender_address');
  });

  it('wraps recipient_address with decrypt_stream_address using current key only', () => {
    const cols = streamSelectColumns(2);
    expect(cols).toContain('decrypt_stream_address(recipient_address, $2, NULL) AS recipient_address');
  });

  it('includes both previous key args when rotation is active (previousKeyParamIndex provided)', () => {
    const cols = streamSelectColumns(2, 3);
    expect(cols).toContain('decrypt_stream_address(sender_address, $2, $3) AS sender_address');
    expect(cols).toContain('decrypt_stream_address(recipient_address, $2, $3) AS recipient_address');
  });

  it('uses parameter index $2 for key and $1 for id — matching getById contract', () => {
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
      'id',
      'amount',
      'streamed_amount',
      'remaining_amount',
      'rate_per_second',
      'start_time',
      'end_time',
      'status',
      'contract_id',
      'transaction_hash',
      'event_index',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(col);
    }
  });

  it('does not contain bare undecorated sender_address or recipient_address column', () => {
    const cols = streamSelectColumns(2);
    const stripped = cols.replace(/decrypt_stream_address\([^)]+\) AS \w+/g, '');
    expect(stripped).not.toMatch(/\bsender_address\b/);
    expect(stripped).not.toMatch(/\brecipient_address\b/);
  });

  it('is a pure function — same inputs always produce the same SQL fragment', () => {
    expect(streamSelectColumns(2)).toBe(streamSelectColumns(2));
    expect(streamSelectColumns(2, 3)).toBe(streamSelectColumns(2, 3));
    expect(streamSelectColumns(2)).not.toBe(streamSelectColumns(2, 3));
  });

  it('produces correct SQL shape even with arbitrary key index (encryption disabled contract)', () => {
    const cols = streamSelectColumns(99);
    expect(cols).toContain('decrypt_stream_address(sender_address, $99, NULL)');
    expect(cols).toContain('decrypt_stream_address(recipient_address, $99, NULL)');
  });
});

describe('encryptAddressValue', () => {
  it('delegates to pgpEncryptAddressParam with correct param indices', () => {
    expect(encryptAddressValue(2, 5)).toBe('pgp_sym_encrypt($2, $5, \'cipher-algo=aes256,compress-algo=0,armor\')');
  });
});

describe('senderAddressFilterCondition', () => {
  it('builds a hashed address filter with plaintext fallback and previous hash when provided', () => {
    const expr = senderAddressFilterCondition(2, 3, 4);
    expect(expr).toContain('sender_address_hash = $3');
    expect(expr).toContain('sender_address_hash = $4');
    expect(expr).toContain('sender_address = $2');
  });

  it('builds a hashed address filter with only current hash when no previous hash', () => {
    const expr = senderAddressFilterCondition(1, 2);
    expect(expr).toContain('sender_address_hash = $2');
    expect(expr).not.toMatch(/sender_address_hash = \$3/);
    expect(expr).toContain('sender_address = $1');
  });

  it('uses correct parameter indices for filter value, current hash, previous hash', () => {
    const expr = senderAddressFilterCondition(5, 10, 15);
    expect(expr).toContain('sender_address_hash = $10');
    expect(expr).toContain('sender_address_hash = $15');
    expect(expr).toContain('sender_address = $5');
  });
});

describe('recipientAddressFilterCondition', () => {
  it('mirrors sender filter structure with recipient_address column', () => {
    const expr = recipientAddressFilterCondition(1, 2, 3);
    expect(expr).toContain('recipient_address_hash = $2');
    expect(expr).toContain('recipient_address_hash = $3');
    expect(expr).toContain('recipient_address = $1');
  });

  it('omits previous hash clause when previousRecipientHashParamIndex omitted', () => {
    const expr = recipientAddressFilterCondition(1, 2);
    expect(expr).toContain('recipient_address_hash = $2');
    expect(expr).not.toMatch(/recipient_address_hash = \$3/);
    expect(expr).toContain('recipient_address = $1');
  });
});

describe('Low-level pgcryptoEncryption helpers (re-exported for query building)', () => {
  it('pgpDecryptAddressColumn generates correct parameter references', () => {
    expect(pgpDecryptAddressColumn('sender_address', 1)).toContain('decrypt_stream_address(sender_address, $1, NULL)');
    expect(pgpDecryptAddressColumn('recipient_address', 1, 2)).toContain('decrypt_stream_address(recipient_address, $1, $2)');
  });

  it('pgpEncryptAddressParam generates correct parameter references', () => {
    expect(pgpEncryptAddressParam(2, 5)).toContain('pgp_sym_encrypt($2, $5');
  });

  it('buildEncryptedAddressFilter includes previous hash when previousHashParamIndex provided', () => {
    const expr = buildEncryptedAddressFilter('sender_address', 1, 2, 3);
    expect(expr).toContain('sender_address_hash = $2');
    expect(expr).toContain('sender_address_hash = $3');
    expect(expr).toContain('sender_address = $1');
  });

  it('buildEncryptedAddressFilter omits previous hash clause when previousHashParamIndex omitted', () => {
    const expr = buildEncryptedAddressFilter('recipient_address', 1, 2);
    expect(expr).toContain('recipient_address_hash = $2');
    expect(expr).not.toContain('recipient_address_hash = $3');
    expect(expr).toContain('recipient_address = $1');
  });
});