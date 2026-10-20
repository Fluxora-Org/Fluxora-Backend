/**
 * Unit tests for src/metrics/stellarAddressMetrics.ts (issue #1778).
 *
 * Acceptance criteria verified:
 * 1. Malformed, empty and oversized inputs are rejected with a typed error.
 * 2. Rejection happens before any counter state is written.
 * 3. The caller can tell why the input was rejected (validationError field).
 * 4. Valid inputs are unaffected — the counter increments normally.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  recordStellarAddressValidationFailure,
  deRegisterStellarAddressMetrics,
  stellarAddressValidationFailuresTotal,
  STELLAR_ADDRESS_FAILURE_REASONS,
  StellarAddressMetricsValidationError,
} from '../../src/metrics/stellarAddressMetrics.js';

/**
 * Read the current counter value for a given reason label directly from the
 * exported Counter instance — avoids registry lookup issues after teardown.
 */
async function getCounterValue(reason: string): Promise<number> {
  const metric = await stellarAddressValidationFailuresTotal.get();
  return metric.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

beforeEach(() => {
  // Reset counter state before every test so each test starts clean.
  stellarAddressValidationFailuresTotal.reset();
});

afterEach(() => {
  stellarAddressValidationFailuresTotal.reset();
});

afterAll(() => {
  // De-register once at the end to clean up the shared registry.
  deRegisterStellarAddressMetrics();
});

// ---------------------------------------------------------------------------
// Valid inputs — must not throw and must increment the counter
// ---------------------------------------------------------------------------

describe('recordStellarAddressValidationFailure — valid inputs', () => {
  it.each(STELLAR_ADDRESS_FAILURE_REASONS)(
    'accepts the valid reason "%s" and increments the counter',
    async (reason) => {
      const before = await getCounterValue(reason);

      expect(() => recordStellarAddressValidationFailure(reason)).not.toThrow();

      const after = await getCounterValue(reason);
      expect(after).toBe(before + 1);
    },
  );

  it('accumulates multiple calls for the same reason', async () => {
    recordStellarAddressValidationFailure('malformed');
    recordStellarAddressValidationFailure('malformed');
    recordStellarAddressValidationFailure('malformed');

    const count = await getCounterValue('malformed');
    expect(count).toBe(3);
  });

  it('tracks different reasons independently', async () => {
    recordStellarAddressValidationFailure('malformed');
    recordStellarAddressValidationFailure('wrong-network');
    recordStellarAddressValidationFailure('rpc-unavailable');

    expect(await getCounterValue('malformed')).toBe(1);
    expect(await getCounterValue('wrong-network')).toBe(1);
    expect(await getCounterValue('rpc-unavailable')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty / whitespace — must throw before any state change
// ---------------------------------------------------------------------------

describe('recordStellarAddressValidationFailure — empty input', () => {
  it('rejects an empty string', async () => {
    const before = await getCounterValue('malformed');

    expect(() =>
      recordStellarAddressValidationFailure('' as never),
    ).toThrow(StellarAddressMetricsValidationError);

    // Counter must not have been touched
    expect(await getCounterValue('malformed')).toBe(before);
  });

  it('sets validationError to "empty" for an empty string', () => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure('' as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught).toBeInstanceOf(StellarAddressMetricsValidationError);
    expect(caught?.validationError).toBe('empty');
  });

  it('rejects a whitespace-only string with validationError "empty"', () => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure('   ' as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught).toBeInstanceOf(StellarAddressMetricsValidationError);
    expect(caught?.validationError).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// Non-string inputs — must throw before any state change
// ---------------------------------------------------------------------------

describe('recordStellarAddressValidationFailure — non-string inputs', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['boolean', true],
    ['object', { reason: 'malformed' }],
    ['array', ['malformed']],
  ])('rejects %s with validationError "not-string"', (_label, value) => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure(value as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught).toBeInstanceOf(StellarAddressMetricsValidationError);
    expect(caught?.validationError).toBe('not-string');
  });

  it('does not write to the counter when a non-string is passed', async () => {
    const snapshots = await Promise.all(
      STELLAR_ADDRESS_FAILURE_REASONS.map((r) => getCounterValue(r)),
    );

    try {
      recordStellarAddressValidationFailure(123 as never);
    } catch {
      // expected
    }

    const after = await Promise.all(
      STELLAR_ADDRESS_FAILURE_REASONS.map((r) => getCounterValue(r)),
    );
    expect(after).toEqual(snapshots);
  });
});

// ---------------------------------------------------------------------------
// Oversized input — must throw before any state change
// ---------------------------------------------------------------------------

describe('recordStellarAddressValidationFailure — oversized input', () => {
  it('rejects a string longer than 64 characters', () => {
    const oversized = 'a'.repeat(65);

    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure(oversized as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught).toBeInstanceOf(StellarAddressMetricsValidationError);
    expect(caught?.validationError).toBe('oversized');
  });

  it('rejects an extremely long string', () => {
    const huge = 'x'.repeat(10_000);

    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure(huge as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught?.validationError).toBe('oversized');
  });

  it('accepts a string at exactly the limit (64 chars) but rejects it as unknown-reason', () => {
    // A 64-char string is length-valid but still must fail the enum check.
    const atLimit = 'a'.repeat(64);

    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure(atLimit as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught).toBeInstanceOf(StellarAddressMetricsValidationError);
    // Must be unknown-reason, not oversized (the length guard does not trigger at exactly 64).
    expect(caught?.validationError).toBe('unknown-reason');
  });

  it('does not write to the counter when oversized input is passed', async () => {
    const snapshots = await Promise.all(
      STELLAR_ADDRESS_FAILURE_REASONS.map((r) => getCounterValue(r)),
    );

    try {
      recordStellarAddressValidationFailure('z'.repeat(200) as never);
    } catch {
      // expected
    }

    const after = await Promise.all(
      STELLAR_ADDRESS_FAILURE_REASONS.map((r) => getCounterValue(r)),
    );
    expect(after).toEqual(snapshots);
  });
});

// ---------------------------------------------------------------------------
// Unknown reason values — must throw before any state change
// ---------------------------------------------------------------------------

describe('recordStellarAddressValidationFailure — unknown reason', () => {
  it.each([
    'invalid-reason',
    'MALFORMED',        // wrong case
    'Malformed',        // mixed case
    'rpc_unavailable',  // underscore variant
    'wrong_network',    // underscore variant
    '__proto__',        // prototype pollution attempt
    'constructor',
    'toString',
  ])('rejects unknown reason "%s"', (reason) => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure(reason as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught).toBeInstanceOf(StellarAddressMetricsValidationError);
    expect(caught?.validationError).toBe('unknown-reason');
  });

  it('does not write to the counter when an unknown reason is passed', async () => {
    const snapshots = await Promise.all(
      STELLAR_ADDRESS_FAILURE_REASONS.map((r) => getCounterValue(r)),
    );

    try {
      recordStellarAddressValidationFailure('not-a-real-reason' as never);
    } catch {
      // expected
    }

    const after = await Promise.all(
      STELLAR_ADDRESS_FAILURE_REASONS.map((r) => getCounterValue(r)),
    );
    expect(after).toEqual(snapshots);
  });

  it('error message names the offending value', () => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure('bad-reason' as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught?.message).toContain('bad-reason');
  });

  it('error message lists allowed values', () => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure('nope' as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    for (const valid of STELLAR_ADDRESS_FAILURE_REASONS) {
      expect(caught?.message).toContain(valid);
    }
  });
});

// ---------------------------------------------------------------------------
// Error shape / instanceof contract
// ---------------------------------------------------------------------------

describe('StellarAddressMetricsValidationError shape', () => {
  it('is an instance of Error', () => {
    let caught: unknown;
    try {
      recordStellarAddressValidationFailure('' as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('has name "StellarAddressMetricsValidationError"', () => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure('bad' as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught?.name).toBe('StellarAddressMetricsValidationError');
  });

  it('exposes a non-empty message', () => {
    let caught: StellarAddressMetricsValidationError | undefined;
    try {
      recordStellarAddressValidationFailure(null as never);
    } catch (err) {
      caught = err as StellarAddressMetricsValidationError;
    }
    expect(caught?.message.length).toBeGreaterThan(0);
  });
});
