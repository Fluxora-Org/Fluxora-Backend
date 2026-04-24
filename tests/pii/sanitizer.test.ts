/**
 * Unit tests for src/pii/sanitizer.ts
 *
 * Coverage targets (≥95%):
 *  - maskStellarKey: valid key, invalid key, empty string, wrong prefix
 *  - isStellarKey: valid, invalid, boundary lengths
 *  - redactKeysInString: embedded keys, no keys, empty string, multiple keys
 *  - sanitize: flat objects, nested objects, arrays, null/undefined sensitive
 *    fields, non-string sensitive fields, non-sensitive fields pass-through,
 *    large decimal strings (precision preservation), deeply nested structures,
 *    arrays of primitives, mixed arrays
 */

import { describe, it, expect } from 'vitest';
import {
  maskStellarKey,
  sanitize,
  isStellarKey,
  redactKeysInString,
  REDACTED,
} from '../../src/pii/sanitizer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Valid 56-char Stellar public key (G + 55 base-32 chars). */
const KEY_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const KEY_B = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

// ---------------------------------------------------------------------------
// maskStellarKey
// ---------------------------------------------------------------------------

describe('maskStellarKey()', () => {
  it('masks a valid key preserving first 4 and last 4 chars', () => {
    expect(maskStellarKey(KEY_A)).toBe('GAAZ..CWN7');
  });

  it('masks a second valid key correctly', () => {
    expect(maskStellarKey(KEY_B)).toBe('GBDE..DUXR');
  });

  it('returns [REDACTED] for an empty string', () => {
    expect(maskStellarKey('')).toBe(REDACTED);
  });

  it('returns [REDACTED] for a plain string', () => {
    expect(maskStellarKey('not-a-key')).toBe(REDACTED);
  });

  it('returns [REDACTED] for a key with wrong prefix (X instead of G)', () => {
    const bad = 'XAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    expect(maskStellarKey(bad)).toBe(REDACTED);
  });

  it('returns [REDACTED] for a key that is one char too short', () => {
    // 55 chars total (G + 54) — invalid
    expect(maskStellarKey('G' + 'A'.repeat(54))).toBe(REDACTED);
  });

  it('returns [REDACTED] for a key that is one char too long', () => {
    // 57 chars total (G + 56) — invalid
    expect(maskStellarKey('G' + 'A'.repeat(56))).toBe(REDACTED);
  });

  it('accepts a key made entirely of valid base-32 chars', () => {
    // G + 55 × 'A' = 56 chars, all valid base-32
    const allA = 'G' + 'A'.repeat(55);
    expect(maskStellarKey(allA)).toBe('GAAA..AAAA');
  });
});

// ---------------------------------------------------------------------------
// isStellarKey
// ---------------------------------------------------------------------------

describe('isStellarKey()', () => {
  it('returns true for a valid Stellar key', () => {
    expect(isStellarKey(KEY_A)).toBe(true);
  });

  it('returns true for another valid key', () => {
    expect(isStellarKey(KEY_B)).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isStellarKey('')).toBe(false);
  });

  it('returns false for a random string', () => {
    expect(isStellarKey('hello')).toBe(false);
  });

  it('returns false for a 55-char key (too short)', () => {
    expect(isStellarKey('G' + 'A'.repeat(54))).toBe(false);
  });

  it('returns true for a 56-char all-A key', () => {
    expect(isStellarKey('G' + 'A'.repeat(55))).toBe(true);
  });

  it('returns false for a 57-char key (too long)', () => {
    expect(isStellarKey('G' + 'A'.repeat(56))).toBe(false);
  });

  it('returns false for a key containing lowercase letters', () => {
    const lower = KEY_A.toLowerCase();
    expect(isStellarKey(lower)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// redactKeysInString
// ---------------------------------------------------------------------------

describe('redactKeysInString()', () => {
  it('returns an empty string unchanged', () => {
    expect(redactKeysInString('')).toBe('');
  });

  it('returns a plain string with no keys unchanged', () => {
    const s = 'No keys here, just normal text.';
    expect(redactKeysInString(s)).toBe(s);
  });

  it('masks a single embedded Stellar key', () => {
    const line = `sender is ${KEY_A}`;
    const result = redactKeysInString(line);
    expect(result).toContain('GAAZ..CWN7');
    expect(result).not.toContain(KEY_A);
  });

  it('masks multiple embedded Stellar keys', () => {
    const line = `sender=${KEY_A} recipient=${KEY_B}`;
    const result = redactKeysInString(line);
    expect(result).toContain('GAAZ..CWN7');
    expect(result).toContain('GBDE..DUXR');
    expect(result).not.toContain(KEY_A);
    expect(result).not.toContain(KEY_B);
  });

  it('preserves surrounding text when masking', () => {
    const line = `Created stream for ${KEY_A} at 2024-01-01`;
    const result = redactKeysInString(line);
    expect(result).toMatch(/^Created stream for GAAZ\.\.CWN7 at 2024-01-01$/);
  });
});

// ---------------------------------------------------------------------------
// sanitize() — flat objects
// ---------------------------------------------------------------------------

describe('sanitize() — flat objects', () => {
  it('redacts sender (Stellar key) with partial mask', () => {
    const result = sanitize({ sender: KEY_A, id: '1' });
    expect(result.sender).toBe('GAAZ..CWN7');
    expect(result.id).toBe('1');
  });

  it('redacts recipient (Stellar key) with partial mask', () => {
    const result = sanitize({ recipient: KEY_B, id: '2' });
    expect(result.recipient).toBe('GBDE..DUXR');
  });

  it('redacts ipAddress with [REDACTED]', () => {
    const result = sanitize({ ipAddress: '10.0.0.1', method: 'GET' });
    expect(result.ipAddress).toBe(REDACTED);
    expect(result.method).toBe('GET');
  });

  it('redacts authToken with [REDACTED]', () => {
    const result = sanitize({ authToken: 'Bearer abc123', path: '/api' });
    expect(result.authToken).toBe(REDACTED);
    expect(result.path).toBe('/api');
  });

  it('redacts userAgent with [REDACTED]', () => {
    const result = sanitize({ userAgent: 'Mozilla/5.0', path: '/api' });
    expect(result.userAgent).toBe(REDACTED);
  });

  it('does not mutate the original object', () => {
    const input = { sender: KEY_A, id: 'x' };
    sanitize(input);
    expect(input.sender).toBe(KEY_A);
  });

  it('passes through non-sensitive fields unchanged', () => {
    const input = { id: 'abc', status: 'active', depositAmount: '9999999.9999999' };
    const result = sanitize(input);
    expect(result.id).toBe('abc');
    expect(result.status).toBe('active');
    expect(result.depositAmount).toBe('9999999.9999999');
  });
});

// ---------------------------------------------------------------------------
// sanitize() — decimal / financial precision
// ---------------------------------------------------------------------------

describe('sanitize() — decimal string precision', () => {
  it('preserves a standard 7-decimal Stellar amount string', () => {
    const result = sanitize({ depositAmount: '1234567.8901234', id: '1' });
    expect(result.depositAmount).toBe('1234567.8901234');
  });

  it('preserves a very large decimal string without coercion', () => {
    const large = '99999999999999999.9999999';
    const result = sanitize({ ratePerSecond: large });
    expect(result.ratePerSecond).toBe(large);
  });

  it('preserves a zero amount string', () => {
    const result = sanitize({ depositAmount: '0', id: '1' });
    expect(result.depositAmount).toBe('0');
  });

  it('preserves a negative decimal string', () => {
    const result = sanitize({ ratePerSecond: '-0.0000001' });
    expect(result.ratePerSecond).toBe('-0.0000001');
  });

  it('does not convert decimal strings to numbers', () => {
    // If the sanitizer ever coerced to number, precision would be lost
    const precise = '123456789012345678.1234567';
    const result = sanitize({ depositAmount: precise });
    expect(typeof result.depositAmount).toBe('string');
    expect(result.depositAmount).toBe(precise);
  });
});

// ---------------------------------------------------------------------------
// sanitize() — null / undefined / non-string sensitive fields
// ---------------------------------------------------------------------------

describe('sanitize() — null, undefined, and non-string sensitive fields', () => {
  it('redacts a null sensitive field', () => {
    const result = sanitize({ sender: null } as Record<string, unknown>);
    expect(result.sender).toBe(REDACTED);
  });

  it('redacts an undefined sensitive field', () => {
    const result = sanitize({ sender: undefined } as Record<string, unknown>);
    expect(result.sender).toBe(REDACTED);
  });

  it('redacts a numeric sensitive field', () => {
    const result = sanitize({ sender: 12345 } as unknown as Record<string, unknown>);
    expect(result.sender).toBe(REDACTED);
  });

  it('redacts a boolean sensitive field', () => {
    const result = sanitize({ authToken: true } as unknown as Record<string, unknown>);
    expect(result.authToken).toBe(REDACTED);
  });

  it('redacts an object-valued sensitive field', () => {
    const result = sanitize({ authToken: { nested: 'secret' } } as unknown as Record<string, unknown>);
    expect(result.authToken).toBe(REDACTED);
  });

  it('preserves null on non-sensitive fields', () => {
    const result = sanitize({ id: null } as Record<string, unknown>);
    expect(result.id).toBeNull();
  });

  it('preserves undefined on non-sensitive fields', () => {
    const result = sanitize({ id: undefined } as Record<string, unknown>);
    expect(result.id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sanitize() — nested objects
// ---------------------------------------------------------------------------

describe('sanitize() — nested objects', () => {
  it('redacts sensitive fields inside a nested object', () => {
    const input = { stream: { sender: KEY_A, id: 'nested-1' } };
    const result = sanitize(input);
    const stream = result.stream as Record<string, unknown>;
    expect(stream.sender).toBe('GAAZ..CWN7');
    expect(stream.id).toBe('nested-1');
  });

  it('handles deeply nested objects (5 levels)', () => {
    const input = { a: { b: { c: { d: { sender: KEY_A } } } } };
    const result = sanitize(input as Record<string, unknown>);
    const deep = (result as any).a.b.c.d;
    expect(deep.sender).toBe('GAAZ..CWN7');
  });

  it('preserves decimal strings in nested objects', () => {
    const input = { meta: { depositAmount: '0.0000001', sender: KEY_A } };
    const result = sanitize(input);
    const meta = result.meta as Record<string, unknown>;
    expect(meta.depositAmount).toBe('0.0000001');
    expect(meta.sender).toBe('GAAZ..CWN7');
  });
});

// ---------------------------------------------------------------------------
// sanitize() — arrays
// ---------------------------------------------------------------------------

describe('sanitize() — arrays', () => {
  it('redacts sensitive fields in an array of objects', () => {
    const input = {
      streams: [
        { sender: KEY_A, id: '1' },
        { sender: KEY_B, id: '2' },
      ],
    };
    const result = sanitize(input);
    const streams = result.streams as Array<Record<string, unknown>>;
    expect(streams[0].sender).toBe('GAAZ..CWN7');
    expect(streams[1].sender).toBe('GBDE..DUXR');
    expect(streams[0].id).toBe('1');
  });

  it('handles an empty array', () => {
    const result = sanitize({ streams: [] });
    expect(result.streams).toEqual([]);
  });

  it('handles an array of primitives (no redaction needed)', () => {
    const result = sanitize({ tags: ['a', 'b', 'c'] } as Record<string, unknown>);
    expect(result.tags).toEqual(['a', 'b', 'c']);
  });

  it('handles a mixed array of objects and primitives', () => {
    const input = { items: [{ sender: KEY_A }, 'plain', 42] } as Record<string, unknown>;
    const result = sanitize(input);
    const items = result.items as unknown[];
    expect((items[0] as Record<string, unknown>).sender).toBe('GAAZ..CWN7');
    expect(items[1]).toBe('plain');
    expect(items[2]).toBe(42);
  });

  it('handles nested arrays', () => {
    const input = { matrix: [[{ sender: KEY_A }]] } as Record<string, unknown>;
    const result = sanitize(input);
    const inner = ((result.matrix as unknown[][])[0][0]) as Record<string, unknown>;
    expect(inner.sender).toBe('GAAZ..CWN7');
  });
});

// ---------------------------------------------------------------------------
// sanitize() — edge cases
// ---------------------------------------------------------------------------

describe('sanitize() — edge cases', () => {
  it('handles an empty object', () => {
    expect(sanitize({})).toEqual({});
  });

  it('handles an object with only non-sensitive fields', () => {
    const input = { id: '1', status: 'active', count: 5 };
    expect(sanitize(input as Record<string, unknown>)).toEqual(input);
  });

  it('handles numeric non-sensitive values without coercion', () => {
    const result = sanitize({ count: 42 } as Record<string, unknown>);
    expect(result.count).toBe(42);
    expect(typeof result.count).toBe('number');
  });

  it('handles boolean non-sensitive values', () => {
    const result = sanitize({ active: true } as Record<string, unknown>);
    expect(result.active).toBe(true);
  });

  it('redacts a non-Stellar string in a sensitive field', () => {
    // ipAddress is sensitive but not a Stellar key — should be fully redacted
    const result = sanitize({ ipAddress: '192.168.0.1' });
    expect(result.ipAddress).toBe(REDACTED);
  });

  it('handles a sender that is a non-Stellar string (not a key)', () => {
    // sender is sensitive; if the value is not a valid Stellar key, maskStellarKey returns [REDACTED]
    const result = sanitize({ sender: 'not-a-stellar-key' });
    expect(result.sender).toBe(REDACTED);
  });
});
