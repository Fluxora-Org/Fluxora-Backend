/**
 * tests/pii/pgcryptoEncryption.legalHold.test.ts
 *
 * Regression tests for legal-hold precedence, encryption-state transitions,
 * and failure recovery in the PII erasure path (redactPiiForAddress).
 *
 * These tests use an in-process mock queryExecutor so they run without a real
 * Postgres connection while still exercising the CTE SQL shape and the
 * returned counts.
 *
 * Cases covered
 * ─────────────
 *  1. All rows erasable (no hold) — rowsErased matches, rowsSkippedLegalHold = 0
 *  2. All rows held              — rowsErased = 0, rowsSkippedLegalHold matches
 *  3. Mixed held / non-held      — each count correct
 *  4. No matching rows           — both counts zero
 *  5. Custom tombstone value     — tombstone is forwarded as $1
 *  6. address passed as $2       — recipientAddress forwarded correctly
 *  7. Query executor throws      — error propagates (no swallowing)
 *  8. Encryption-state column    — UPDATE sets encryption_state = 'redacted'
 */

import { describe, it, expect, vi } from 'vitest';
import { redactPiiForAddress, DEFAULT_ERASURE_TOMBSTONE } from '../../src/pii/pgcryptoEncryption.js';

// A minimal mock query executor that lets each test control what the DB returns.
function mockExecutor(rows: Array<{ rows_erased: number | string; rows_held: number | string }>) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: null }),
  };
}

const RECIPIENT = 'GDTEST12345678901234567890123456789012345678901234567890';

describe('redactPiiForAddress — legal-hold precedence', () => {
  it('returns rowsErased from CTE and rowsSkippedLegalHold = 0 when no rows are held', async () => {
    const executor = mockExecutor([{ rows_erased: 3, rows_held: 0 }]);
    const result = await redactPiiForAddress(executor, RECIPIENT);

    expect(result.rowsErased).toBe(3);
    expect(result.rowsSkippedLegalHold).toBe(0);
  });

  it('returns rowsErased = 0 and rowsSkippedLegalHold when all matching rows are held', async () => {
    const executor = mockExecutor([{ rows_erased: 0, rows_held: 5 }]);
    const result = await redactPiiForAddress(executor, RECIPIENT);

    expect(result.rowsErased).toBe(0);
    expect(result.rowsSkippedLegalHold).toBe(5);
  });

  it('returns correct split counts for a mixed batch of held and non-held rows', async () => {
    const executor = mockExecutor([{ rows_erased: 2, rows_held: 3 }]);
    const result = await redactPiiForAddress(executor, RECIPIENT);

    expect(result.rowsErased).toBe(2);
    expect(result.rowsSkippedLegalHold).toBe(3);
  });

  it('returns both counts as 0 when no rows match the address', async () => {
    const executor = mockExecutor([{ rows_erased: 0, rows_held: 0 }]);
    const result = await redactPiiForAddress(executor, RECIPIENT);

    expect(result.rowsErased).toBe(0);
    expect(result.rowsSkippedLegalHold).toBe(0);
  });

  it('handles string-typed counts returned by Postgres (bigint coercion)', async () => {
    // Postgres COUNT(*) returns bigint which pg driver gives as strings
    const executor = mockExecutor([{ rows_erased: '7', rows_held: '2' }]);
    const result = await redactPiiForAddress(executor, RECIPIENT);

    expect(result.rowsErased).toBe(7);
    expect(result.rowsSkippedLegalHold).toBe(2);
  });
});

describe('redactPiiForAddress — single CTE query (no TOCTOU)', () => {
  it('issues exactly ONE query (not two separate SELECT/UPDATE)', async () => {
    const executor = mockExecutor([{ rows_erased: 1, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT);

    // The critical regression: the old implementation made two round-trips.
    // The new CTE collapses them into a single parameterised statement.
    expect(executor.query).toHaveBeenCalledOnce();
  });

  it('passes tombstone as first parameter ($1)', async () => {
    const executor = mockExecutor([{ rows_erased: 1, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT, '[CUSTOM_TOMBSTONE]');

    const [_sql, params] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('[CUSTOM_TOMBSTONE]');
  });

  it('passes recipientAddress as second parameter ($2)', async () => {
    const executor = mockExecutor([{ rows_erased: 1, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT);

    const [_sql, params] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(RECIPIENT);
  });

  it('uses the default tombstone when none is specified', async () => {
    const executor = mockExecutor([{ rows_erased: 1, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT);

    const [_sql, params] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(DEFAULT_ERASURE_TOMBSTONE);
  });
});

describe('redactPiiForAddress — encryption_state transition', () => {
  it('SQL includes encryption_state = \'redacted\' in the UPDATE clause', async () => {
    const executor = mockExecutor([{ rows_erased: 1, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT);

    const [sql] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("encryption_state       = 'redacted'");
  });

  it('SQL clears sender_address_hash and recipient_address_hash to NULL', async () => {
    const executor = mockExecutor([{ rows_erased: 1, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT);

    const [sql] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('sender_address_hash    = NULL');
    expect(sql).toContain('recipient_address_hash = NULL');
  });

  it('SQL excludes rows where COALESCE(legal_hold, FALSE) = TRUE from the UPDATE', async () => {
    const executor = mockExecutor([{ rows_erased: 0, rows_held: 0 }]);
    await redactPiiForAddress(executor, RECIPIENT);

    const [sql] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('COALESCE(legal_hold, FALSE) = FALSE');
  });
});

describe('redactPiiForAddress — failure recovery', () => {
  it('propagates a query error without swallowing it', async () => {
    const executor = {
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
    };

    await expect(redactPiiForAddress(executor, RECIPIENT)).rejects.toThrow('connection lost');
  });

  it('does not issue a second query after a failure on the first', async () => {
    const executor = {
      query: vi.fn().mockRejectedValue(new Error('DB error')),
    };

    try {
      await redactPiiForAddress(executor, RECIPIENT);
    } catch {
      // expected
    }

    expect(executor.query).toHaveBeenCalledOnce();
  });
});

describe('redactPiiForAddress — boundary values', () => {
  it('handles an empty recipient address without throwing', async () => {
    const executor = mockExecutor([{ rows_erased: 0, rows_held: 0 }]);
    // Validation of the address format is the caller's responsibility;
    // redactPiiForAddress itself must not throw on any non-null string.
    const result = await redactPiiForAddress(executor, '');
    expect(result.rowsErased).toBe(0);
    expect(result.rowsSkippedLegalHold).toBe(0);
  });

  it('handles a 256-char address without throwing', async () => {
    const longAddr = 'G' + 'A'.repeat(255);
    const executor = mockExecutor([{ rows_erased: 0, rows_held: 0 }]);
    const result = await redactPiiForAddress(executor, longAddr);
    expect(result).toEqual({ rowsErased: 0, rowsSkippedLegalHold: 0 });
  });
});
