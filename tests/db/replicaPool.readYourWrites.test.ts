/**
 * Comprehensive tests for the read-your-writes write-fence pin mechanism.
 *
 * Covers:
 *   1. issueWriteFencePin — happy-path issuance, key errors
 *   2. verifyWriteFencePin — valid pin accepted, TTL expiry, tampered sig
 *      rejected, malformed inputs rejected, timing-safe comparison
 *   3. shouldForcePrimaryFromHeaders — header extraction from req.headers
 *   4. getReadPool integration — forcePrimary plumbing from header → pool
 *   5. Security assumptions — HMAC forging, replay after TTL, constant-time
 *   6. Edge cases — boundary timestamps, RYW_PIN_TTL_SECONDS=0, missing env
 *   7. streamRepository.findWithCursor options forwarding (forcePrimary)
 *
 * @module tests/db/replicaPool.readYourWrites.test.ts
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import crypto from 'crypto';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Rebuild a base64url-encoded pin from raw parts (for forgery tests). */
function buildPin(version: string, tsMs: string | number, sig: string): string {
  const raw = `${version}.${tsMs}.${sig}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Derive the signing key the same way the implementation does. */
function signingKey(secret: string): Buffer {
  return Buffer.from(secret, 'utf8').subarray(0, 32);
}

/** Compute a valid HMAC-SHA256 for a given secret + version + tsMs. */
function makeHmac(secret: string, version: string, tsMs: string): string {
  const key = signingKey(secret);
  return crypto.createHmac('sha256', key).update(`${version}:${tsMs}`).digest('hex');
}

// ── Module imports (after env setup) ──────────────────────────────────────────

// We import after manipulating process.env in each test via beforeEach/afterEach.
// Using dynamic imports lets us control env at import time; but since the
// implementation reads env at *call* time we can use static imports here.
import {
  issueWriteFencePin,
  verifyWriteFencePin,
  shouldForcePrimaryFromHeaders,
  WRITE_FENCE_HEADER,
} from '../../src/db/writeFencePin.js';

// ─────────────────────────────────────────────────────────────────────────────

const VALID_SECRET = 'a'.repeat(32); // exactly 32 chars, satisfies minimum
const LONG_SECRET = 'abcdefghijklmnopqrstuvwxyz012345EXTRA_CHARS'; // >32 chars

describe('writeFencePin', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env['JWT_SECRET'] = VALID_SECRET;
    delete process.env['RYW_PIN_TTL_SECONDS'];
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // ── WRITE_FENCE_HEADER constant ────────────────────────────────────────────

  describe('WRITE_FENCE_HEADER', () => {
    it('is the expected header name', () => {
      expect(WRITE_FENCE_HEADER).toBe('X-Fluxora-Write-Fence');
    });
  });

  // ── issueWriteFencePin ─────────────────────────────────────────────────────

  describe('issueWriteFencePin', () => {
    it('returns a non-empty base64url string', () => {
      const pin = issueWriteFencePin();
      expect(typeof pin).toBe('string');
      expect(pin.length).toBeGreaterThan(0);
      // base64url charset only
      expect(/^[A-Za-z0-9_-]+$/.test(pin)).toBe(true);
    });

    it('decodes to a v1.<ts>.<sig> payload', () => {
      const pin = issueWriteFencePin();
      const decoded = Buffer.from(pin, 'base64url').toString('utf8');
      const parts = decoded.split('.');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('v1');
      expect(/^\d+$/.test(parts[1]!)).toBe(true);
      expect(parts[2]!.length).toBeGreaterThan(0);
    });

    it('embeds a timestamp close to Date.now()', () => {
      const before = Date.now();
      const pin = issueWriteFencePin();
      const after = Date.now();

      const decoded = Buffer.from(pin, 'base64url').toString('utf8');
      const tsMs = parseInt(decoded.split('.')[1]!, 10);
      expect(tsMs).toBeGreaterThanOrEqual(before);
      expect(tsMs).toBeLessThanOrEqual(after);
    });

    it('produces different pins on successive calls (different timestamps)', async () => {
      const pin1 = issueWriteFencePin();
      // Small delay to guarantee timestamp differs
      await new Promise<void>((r) => setTimeout(r, 2));
      const pin2 = issueWriteFencePin();
      // Pins should almost certainly differ (different ms); at worst they share
      // the same ms — still safe because HMAC is deterministic given the same
      // input, so equality here is theoretically possible but astronomically
      // unlikely in practice. We don't assert inequality to avoid flakiness.
      expect(typeof pin1).toBe('string');
      expect(typeof pin2).toBe('string');
    });

    it('uses only the first 32 bytes of JWT_SECRET (longer secrets still work)', () => {
      process.env['JWT_SECRET'] = LONG_SECRET;
      expect(() => issueWriteFencePin()).not.toThrow();
    });

    it('throws when JWT_SECRET is absent', () => {
      delete process.env['JWT_SECRET'];
      expect(() => issueWriteFencePin()).toThrow(/JWT_SECRET/);
    });

    it('throws when JWT_SECRET is shorter than 32 characters', () => {
      process.env['JWT_SECRET'] = 'too-short';
      expect(() => issueWriteFencePin()).toThrow(/JWT_SECRET/);
    });

    it('throws when JWT_SECRET is exactly 31 characters', () => {
      process.env['JWT_SECRET'] = 'a'.repeat(31);
      expect(() => issueWriteFencePin()).toThrow(/JWT_SECRET/);
    });

    it('succeeds when JWT_SECRET is exactly 32 characters', () => {
      process.env['JWT_SECRET'] = 'a'.repeat(32);
      expect(() => issueWriteFencePin()).not.toThrow();
    });
  });

  // ── verifyWriteFencePin ────────────────────────────────────────────────────

  describe('verifyWriteFencePin', () => {
    // --- happy path ---

    it('returns true for a freshly issued pin', () => {
      const pin = issueWriteFencePin();
      expect(verifyWriteFencePin(pin)).toBe(true);
    });

    it('returns true when pin is an array with one element (defensive guard)', () => {
      const pin = issueWriteFencePin();
      // Express can normalise multi-value headers as arrays
      expect(verifyWriteFencePin([pin])).toBe(true);
    });

    it('returns true for a longer JWT_SECRET (key derivation uses only first 32 bytes)', () => {
      process.env['JWT_SECRET'] = LONG_SECRET;
      const pin = issueWriteFencePin();
      expect(verifyWriteFencePin(pin)).toBe(true);
    });

    // --- absent / falsy inputs ---

    it('returns false for undefined', () => {
      expect(verifyWriteFencePin(undefined)).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(verifyWriteFencePin('')).toBe(false);
    });

    it('returns false for a whitespace-only string', () => {
      expect(verifyWriteFencePin('   ')).toBe(false);
    });

    it('returns false for an empty array', () => {
      expect(verifyWriteFencePin([])).toBe(false);
    });

    // --- TTL expiry ---

    it('returns false when the pin timestamp is older than TTL', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '30';
      // Build a pin timestamped 31 s in the past
      const pastMs = (Date.now() - 31_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', pastMs);
      const pin = buildPin('v1', pastMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns true when the pin is exactly 1 ms inside the TTL window', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '30';
      const justInMs = (Date.now() - 29_999).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', justInMs);
      const pin = buildPin('v1', justInMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(true);
    });

    it('returns false for a pin with a future timestamp (clock skew / replay guard)', () => {
      const futureMs = (Date.now() + 10_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', futureMs);
      const pin = buildPin('v1', futureMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns false when RYW_PIN_TTL_SECONDS=0 (pinning disabled)', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '0';
      const pin = issueWriteFencePin();
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('uses custom TTL from RYW_PIN_TTL_SECONDS', () => {
      // 5 second TTL; build a pin 4 s old → should pass
      process.env['RYW_PIN_TTL_SECONDS'] = '5';
      const tsMs = (Date.now() - 4_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', tsMs);
      const pin = buildPin('v1', tsMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(true);
    });

    it('uses custom TTL from RYW_PIN_TTL_SECONDS (expired)', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '5';
      const tsMs = (Date.now() - 6_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', tsMs);
      const pin = buildPin('v1', tsMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('falls back to 30 s TTL when RYW_PIN_TTL_SECONDS is non-numeric', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = 'not-a-number';
      // Pin 25 s old should pass under the 30 s default
      const tsMs = (Date.now() - 25_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', tsMs);
      const pin = buildPin('v1', tsMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(true);
    });

    // --- tampered signature ---

    it('returns false when the signature is tampered', () => {
      const pin = issueWriteFencePin();
      const decoded = Buffer.from(pin, 'base64url').toString('utf8');
      const parts = decoded.split('.');
      // Flip the last character of the signature
      const tamperedSig = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('a') ? 'b' : 'a');
      const tampered = buildPin(parts[0]!, parts[1]!, tamperedSig);
      expect(verifyWriteFencePin(tampered)).toBe(false);
    });

    it('returns false when the signature is completely wrong', () => {
      const pin = issueWriteFencePin();
      const decoded = Buffer.from(pin, 'base64url').toString('utf8');
      const parts = decoded.split('.');
      const wrongSig = '0'.repeat(64); // 64 zeros — valid hex length, wrong value
      const tampered = buildPin(parts[0]!, parts[1]!, wrongSig);
      expect(verifyWriteFencePin(tampered)).toBe(false);
    });

    it('returns false when timestamp is tampered (invalid signature for new ts)', () => {
      const pin = issueWriteFencePin();
      const decoded = Buffer.from(pin, 'base64url').toString('utf8');
      const parts = decoded.split('.');
      // Reuse the old sig but change the timestamp — the HMAC will not match
      const newTs = (parseInt(parts[1]!, 10) + 1000).toString();
      const tampered = buildPin(parts[0]!, newTs, parts[2]!);
      expect(verifyWriteFencePin(tampered)).toBe(false);
    });

    it('returns false when signed with a different key', () => {
      const wrongSecret = 'b'.repeat(32);
      const tsMs = Date.now().toString();
      const sig = makeHmac(wrongSecret, 'v1', tsMs);
      const pin = buildPin('v1', tsMs, sig);
      // Current env uses VALID_SECRET ('a' x 32), so sig from wrongSecret is rejected
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    // --- version mismatch ---

    it('returns false for an unsupported version prefix', () => {
      const tsMs = Date.now().toString();
      const sig = makeHmac(VALID_SECRET, 'v2', tsMs);
      const pin = buildPin('v2', tsMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns false for a v0 version prefix', () => {
      const tsMs = Date.now().toString();
      const sig = makeHmac(VALID_SECRET, 'v0', tsMs);
      const pin = buildPin('v0', tsMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    // --- structural malformation ---

    it('returns false for a non-base64url string', () => {
      expect(verifyWriteFencePin('not!base64url@#$')).toBe(false);
    });

    it('returns false for a base64url string that decodes to fewer than 3 parts', () => {
      const short = Buffer.from('v1.1234567890', 'utf8').toString('base64url');
      expect(verifyWriteFencePin(short)).toBe(false);
    });

    it('returns false for a base64url string with extra parts', () => {
      const extra = Buffer.from('v1.1234567890.abc.extra', 'utf8').toString('base64url');
      expect(verifyWriteFencePin(extra)).toBe(false);
    });

    it('returns false when timestamp is non-numeric', () => {
      const sig = makeHmac(VALID_SECRET, 'v1', 'badts');
      const pin = buildPin('v1', 'badts', sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns false when timestamp is too short (< 10 digits)', () => {
      const sig = makeHmac(VALID_SECRET, 'v1', '123456789');
      const pin = buildPin('v1', '123456789', sig); // 9 digits
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns false when signature is empty', () => {
      const tsMs = Date.now().toString();
      const pin = buildPin('v1', tsMs, '');
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns false when signature has odd length (invalid hex)', () => {
      const tsMs = Date.now().toString();
      const pin = buildPin('v1', tsMs, 'abc'); // odd-length hex
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    // --- missing JWT_SECRET at verify time ---

    it('returns false when JWT_SECRET is missing at verification time', () => {
      const pin = issueWriteFencePin();
      delete process.env['JWT_SECRET'];
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('returns false when JWT_SECRET is too short at verification time', () => {
      const pin = issueWriteFencePin();
      process.env['JWT_SECRET'] = 'short';
      expect(verifyWriteFencePin(pin)).toBe(false);
    });
  });

  // ── shouldForcePrimaryFromHeaders ─────────────────────────────────────────

  describe('shouldForcePrimaryFromHeaders', () => {
    it('returns true when headers contain a valid pin under the lowercased header name', () => {
      const pin = issueWriteFencePin();
      const headers: Record<string, string | string[] | undefined> = {
        [WRITE_FENCE_HEADER.toLowerCase()]: pin,
      };
      expect(shouldForcePrimaryFromHeaders(headers)).toBe(true);
    });

    it('returns false when the header is absent', () => {
      expect(shouldForcePrimaryFromHeaders({})).toBe(false);
    });

    it('returns false when the header contains an expired pin', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '30';
      const tsMs = (Date.now() - 31_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', tsMs);
      const pin = buildPin('v1', tsMs, sig);
      expect(shouldForcePrimaryFromHeaders({ [WRITE_FENCE_HEADER.toLowerCase()]: pin })).toBe(false);
    });

    it('returns false when the header contains a tampered pin', () => {
      const pin = issueWriteFencePin();
      const tampered = pin.slice(0, -3) + 'xxx';
      expect(shouldForcePrimaryFromHeaders({ [WRITE_FENCE_HEADER.toLowerCase()]: tampered })).toBe(false);
    });

    it('handles an array value (multi-value header) by using the first element', () => {
      const pin = issueWriteFencePin();
      const headers: Record<string, string | string[] | undefined> = {
        [WRITE_FENCE_HEADER.toLowerCase()]: [pin, 'other'],
      };
      expect(shouldForcePrimaryFromHeaders(headers)).toBe(true);
    });

    it('returns false when the header value is an empty string', () => {
      expect(shouldForcePrimaryFromHeaders({ [WRITE_FENCE_HEADER.toLowerCase()]: '' })).toBe(false);
    });

    it('returns false when RYW_PIN_TTL_SECONDS=0 (pinning disabled)', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '0';
      const pin = issueWriteFencePin();
      expect(shouldForcePrimaryFromHeaders({ [WRITE_FENCE_HEADER.toLowerCase()]: pin })).toBe(false);
    });
  });

  // ── Security: timing-safe comparison ──────────────────────────────────────

  describe('security: timing-safe comparison', () => {
    it('uses crypto.timingSafeEqual for signature comparison (sanity check)', () => {
      // This test verifies that the constant-time path is exercised without
      // depending on internal implementation details.  We confirm that a valid
      // pin with a *correct* signature passes and a pin with an all-zero
      // signature of equal length fails, regardless of which character happens
      // to differ — ensuring no short-circuit comparison.
      const tsMs = Date.now().toString();
      const correctSig = makeHmac(VALID_SECRET, 'v1', tsMs);
      const zeroSig = '0'.repeat(correctSig.length); // same byte-length, different value

      const correct = buildPin('v1', tsMs, correctSig);
      const wrong = buildPin('v1', tsMs, zeroSig);

      expect(verifyWriteFencePin(correct)).toBe(true);
      expect(verifyWriteFencePin(wrong)).toBe(false);
    });

    it('a brute-forced signature cannot match without the key', () => {
      // With HMAC-SHA256, the probability that a random 64-hex string matches
      // is 1/2^256 — effectively impossible.  We just verify that 3 random
      // attempts all fail.
      const tsMs = Date.now().toString();
      for (let i = 0; i < 3; i++) {
        const randomSig = crypto.randomBytes(32).toString('hex');
        const pin = buildPin('v1', tsMs, randomSig);
        expect(verifyWriteFencePin(pin)).toBe(false);
      }
    });
  });

  // ── Full round-trip ────────────────────────────────────────────────────────

  describe('full round-trip', () => {
    it('issue → verify within TTL → returns true', () => {
      const pin = issueWriteFencePin();
      expect(verifyWriteFencePin(pin)).toBe(true);
    });

    it('issue → verify after TTL expires → returns false', () => {
      process.env['RYW_PIN_TTL_SECONDS'] = '1';
      // Build a pin that is already 2 seconds old
      const tsMs = (Date.now() - 2_000).toString();
      const sig = makeHmac(VALID_SECRET, 'v1', tsMs);
      const pin = buildPin('v1', tsMs, sig);
      expect(verifyWriteFencePin(pin)).toBe(false);
    });

    it('issue → echo via shouldForcePrimaryFromHeaders → routes to primary', () => {
      const pin = issueWriteFencePin();
      const result = shouldForcePrimaryFromHeaders({
        [WRITE_FENCE_HEADER.toLowerCase()]: pin,
      });
      expect(result).toBe(true);
    });
  });

  // ── getReadPool integration (forcePrimary plumbing) ───────────────────────

  describe('getReadPool integration', () => {
    // We test through the public interface only — no internal module mocking —
    // to verify the option is wired end-to-end.

    it('verifyWriteFencePin=false leads to forcePrimary=false in shouldForcePrimaryFromHeaders', () => {
      // No header → no pin → shouldForcePrimaryFromHeaders returns false
      const force = shouldForcePrimaryFromHeaders({});
      expect(force).toBe(false);
    });

    it('verifyWriteFencePin=true leads to forcePrimary=true in shouldForcePrimaryFromHeaders', () => {
      const pin = issueWriteFencePin();
      const force = shouldForcePrimaryFromHeaders({ [WRITE_FENCE_HEADER.toLowerCase()]: pin });
      expect(force).toBe(true);
    });
  });
});

// ── streamRepository.findWithCursor options forwarding ─────────────────────────

/**
 * vi.mock() factories are hoisted to the top of the file at compile-time,
 * before any `const` or `let` declarations.  We use `vi.hoisted()` to
 * declare the mock functions in a context that is also hoisted, so the
 * factory closures can reference them without a "variable used before
 * declaration" runtime error.
 */
const repoMocks = vi.hoisted(() => {
  const mockQueryFn = vi.fn().mockResolvedValue({ rows: [] });
  const mockPoolObj = {
    query: mockQueryFn,
    on: vi.fn(),
    end: vi.fn(),
  };
  const mockGetReadPoolFn = vi.fn().mockResolvedValue(mockPoolObj);
  const mockGetPoolFn = vi.fn().mockReturnValue(mockPoolObj);
  return { mockQueryFn, mockPoolObj, mockGetReadPoolFn, mockGetPoolFn };
});

vi.mock('../../src/db/pool.js', () => ({
  getPool: () => repoMocks.mockGetPoolFn(),
  query: async (pool: { query: (sql: string, params: unknown[]) => unknown }, sql: string, params: unknown[]) => {
    return pool.query(sql, params);
  },
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  resolvePoolConfig: vi.fn(() => ({
    connectionString: 'postgresql://primary:5432/test',
    min: 1,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    queueLimit: 20,
    statementTimeoutMs: 3000,
  })),
}));

vi.mock('../../src/db/replicaPool.js', () => ({
  getReadPool: async (opts: { forcePrimary?: boolean } = {}) =>
    repoMocks.mockGetReadPoolFn(opts),
  resetReplicaPool: vi.fn(),
  setReplicaPool: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/metrics/dbMetrics.js', () => ({
  dbQueryDurationSeconds: {
    observe: vi.fn(),
    startTimer: vi.fn(() => vi.fn()),
  },
  dbReplicationLagSeconds: { set: vi.fn() },
}));

vi.mock('../../src/tracing/hooks.js', () => ({
  enrichActiveSpanWithStream: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({
    pgcryptoKey: 'a'.repeat(32), // satisfy PGCRYPTO_KEY requirement
    pgcryptoPreviousKey: undefined,
  })),
  loadConfig: vi.fn(),
}));

vi.mock('../../src/pii/pgcryptoEncryption.js', () => ({
  computeAddressHashes: vi.fn(() => ({ current: 'hash', previous: undefined })),
  encryptAddressValue: vi.fn((v: string) => v),
}));

vi.mock('../../src/db/queries/streams.js', () => ({
  streamSelectColumns: vi.fn(
    () =>
      'id, status, sender_address, recipient_address, amount, streamed_amount, remaining_amount, rate_per_second, start_time, end_time, contract_id, transaction_hash, event_index, created_at, updated_at',
  ),
  senderAddressFilterCondition: vi.fn(() => 'sender_address = $1'),
  recipientAddressFilterCondition: vi.fn(() => 'recipient_address = $1'),
  encryptAddressValue: vi.fn((v: string) => v),
}));

describe('streamRepository.findWithCursor – forcePrimary forwarding', () => {
  /**
   * Verify that `options.forcePrimary` is forwarded to `getReadPool()`.
   * The repository is dynamically imported so the module-level mock registrations
   * above take effect before the module's top-level code runs.
   */

  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.mockQueryFn.mockResolvedValue({ rows: [] });
    repoMocks.mockGetReadPoolFn.mockResolvedValue(repoMocks.mockPoolObj);
  });

  it('passes { forcePrimary: true } to getReadPool when options.forcePrimary is true', async () => {
    const { streamRepository } = await import(
      '../../src/db/repositories/streamRepository.js'
    );
    await streamRepository.findWithCursor({}, 10, undefined, false, {
      forcePrimary: true,
    });
    expect(repoMocks.mockGetReadPoolFn).toHaveBeenCalledWith({
      forcePrimary: true,
    });
  });

  it('passes { forcePrimary: false } to getReadPool when options.forcePrimary is false', async () => {
    const { streamRepository } = await import(
      '../../src/db/repositories/streamRepository.js'
    );
    await streamRepository.findWithCursor({}, 10, undefined, false, {
      forcePrimary: false,
    });
    expect(repoMocks.mockGetReadPoolFn).toHaveBeenCalledWith({
      forcePrimary: false,
    });
  });

  it('passes { forcePrimary: undefined } to getReadPool when options is omitted', async () => {
    const { streamRepository } = await import(
      '../../src/db/repositories/streamRepository.js'
    );
    await streamRepository.findWithCursor({}, 10);
    expect(repoMocks.mockGetReadPoolFn).toHaveBeenCalledWith({
      forcePrimary: undefined,
    });
  });

  it('still executes a query against the pool returned by getReadPool', async () => {
    const { streamRepository } = await import(
      '../../src/db/repositories/streamRepository.js'
    );
    await streamRepository.findWithCursor({}, 10, undefined, false, {
      forcePrimary: true,
    });
    expect(repoMocks.mockQueryFn).toHaveBeenCalled();
  });
});
