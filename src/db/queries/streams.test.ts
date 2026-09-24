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
  StreamQueryBuilder,
  buildStreamQuery,
  UnboundedStreamQueryError,
  DEFAULT_STREAM_LIMIT,
  MAX_STREAM_LIMIT,
  MIN_STREAM_LIMIT,
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

describe('StreamQueryBuilder & Boundedness Guarantees', () => {
  describe('Documented constants', () => {
    it('documents DEFAULT_STREAM_LIMIT as 50 (matching docs/STREAMS.md)', () => {
      expect(DEFAULT_STREAM_LIMIT).toBe(50);
    });

    it('documents MAX_STREAM_LIMIT as 100', () => {
      expect(MAX_STREAM_LIMIT).toBe(100);
    });

    it('documents MIN_STREAM_LIMIT as 1', () => {
      expect(MIN_STREAM_LIMIT).toBe(1);
    });
  });

  describe('Adversarial Limit Enforcement (Refusing Unbounded Queries)', () => {
    it('refuses construction when no limit is provided', () => {
      expect(() => new (StreamQueryBuilder as any)()).toThrow(UnboundedStreamQueryError);
      expect(() => new (StreamQueryBuilder as any)()).toThrow(/requires an explicit limit/);
    });

    it('refuses construction with undefined limit in options', () => {
      expect(() => new StreamQueryBuilder({} as any)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder({ limit: undefined } as any)).toThrow(UnboundedStreamQueryError);
    });

    it('refuses construction with null limit', () => {
      expect(() => new StreamQueryBuilder(null as any)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder({ limit: null } as any)).toThrow(UnboundedStreamQueryError);
    });

    it('refuses construction with non-number limit', () => {
      expect(() => new StreamQueryBuilder('50' as any)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder({ limit: '50' } as any)).toThrow(/expected a finite number/);
    });

    it('refuses construction with NaN or infinite limit', () => {
      expect(() => new StreamQueryBuilder(NaN)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder(Infinity)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder(-Infinity)).toThrow(UnboundedStreamQueryError);
    });

    it('refuses construction with limit <= 0', () => {
      expect(() => new StreamQueryBuilder(0)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder(0)).toThrow(/greater than 0/);
      expect(() => new StreamQueryBuilder(-1)).toThrow(UnboundedStreamQueryError);
      expect(() => new StreamQueryBuilder({ limit: -100 })).toThrow(UnboundedStreamQueryError);
    });

    it('buildStreamQuery functional helper refuses options without limit', () => {
      expect(() => buildStreamQuery({} as any)).toThrow(UnboundedStreamQueryError);
      expect(() => buildStreamQuery({ limit: 0 })).toThrow(UnboundedStreamQueryError);
      expect(() => buildStreamQuery({ limit: undefined as any })).toThrow(UnboundedStreamQueryError);
    });
  });

  describe('Server-Side Maximum Clamping', () => {
    it('accepts valid limits within bounds', () => {
      const b1 = new StreamQueryBuilder(20);
      expect(b1.limit).toBe(20);
      expect(b1.effectiveLimit).toBe(20);

      const b2 = new StreamQueryBuilder({ limit: 50 });
      expect(b2.limit).toBe(50);
      expect(b2.effectiveLimit).toBe(50);
    });

    it('clamps oversized limits to MAX_STREAM_LIMIT (100) server-side', () => {
      const b1 = new StreamQueryBuilder(99999);
      expect(b1.limit).toBe(99999);
      expect(b1.effectiveLimit).toBe(MAX_STREAM_LIMIT);

      const b2 = new StreamQueryBuilder({ limit: 500 });
      expect(b2.effectiveLimit).toBe(100);
    });

    it('floors fractional limits to integer', () => {
      const b = new StreamQueryBuilder(25.9);
      expect(b.effectiveLimit).toBe(25);
    });
  });

  describe('Query Emission and Mandatory LIMIT Clause', () => {
    it('build() emits SQL carrying a LIMIT clause with the effective limit', () => {
      const builder = new StreamQueryBuilder(25);
      const sql = builder.build();
      expect(sql).toMatch(/\bLIMIT 25\b/);
      expect(sql).toContain('FROM streams');
      expect(sql).toContain('ORDER BY id ASC');
    });

    it('build() emits SQL carrying a parameterized LIMIT clause when limitParamIndex provided', () => {
      const builder = new StreamQueryBuilder(25);
      const sql = builder.build({ limitParamIndex: 2 });
      expect(sql).toMatch(/\bLIMIT \$2\b/);
    });

    it('buildCursorQuery() emits SQL with cursor ordering and parameterized LIMIT', () => {
      const builder = new StreamQueryBuilder(50);
      const sql = builder.buildCursorQuery({
        keyIndex: 2,
        previousKeyIndex: 3,
        whereClause: 'WHERE id > $1',
        sortField: 'id',
        sortDirection: 'ASC',
        limitParamIndex: 4,
      });

      expect(sql).toMatch(/SELECT .+ FROM streams WHERE id > \$1 ORDER BY id ASC LIMIT \$4/);
      expect(sql).toContain('decrypt_stream_address(sender_address, $2, $3)');
    });

    it('buildOffsetQuery() emits SQL with offset ordering, LIMIT, and OFFSET clauses', () => {
      const builder = new StreamQueryBuilder(50);
      const sql = builder.buildOffsetQuery({
        keyIndex: 2,
        whereClause: 'WHERE status = $1',
        sortClause: 'created_at DESC, id DESC',
        limitParamIndex: 3,
        offsetParamIndex: 4,
      });

      expect(sql).toMatch(/SELECT .+ FROM streams WHERE status = \$1 ORDER BY created_at DESC, id DESC LIMIT \$3 OFFSET \$4/);
    });

    it('buildStreamQuery functional helper builds a bounded query', () => {
      const sql = buildStreamQuery({ limit: 30, limitParamIndex: 1 });
      expect(sql).toContain('LIMIT $1');
    });
  });
});