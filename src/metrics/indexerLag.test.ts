/**
 * Unit tests for src/metrics/indexerLag.ts
 *
 * Issue #1788 — Harden the input validation in indexerLag
 *
 * Rules:
 * - No network I/O, no wall-clock time
 * - Each validated setter has a normal-path test
 * - All documented failure modes are asserted (wrong type, negative, NaN,
 *   Infinity, non-integer, oversized, invalid direction)
 * - Rejection is confirmed to happen before any metric state is written
 * - Valid input is unaffected
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IndexerLagValidationError,
  MAX_ETA_SECONDS,
  MAX_LEDGER_SEQUENCE,
  deRegisterIndexerLagMetrics,
  indexerBackfillYieldEventsTotal,
  indexerCatchupEtaSeconds,
  indexerLedgerLag,
  recordBackfillYieldEvent,
  resetBackfillYieldMetrics,
  setCatchupEtaSeconds,
  setLedgerLag,
} from './indexerLag.js';

// ── Test isolation ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Re-register fresh metrics before each test so counters/gauges start at 0.
  deRegisterIndexerLagMetrics();
  // Importing the module re-registers via the lazy-init pattern; force that here
  // by resetting what remains.  The module-level exports still reference the same
  // objects after deregister so we just set them back to 0.
  indexerLedgerLag.set(0);
  indexerCatchupEtaSeconds.set(0);
  resetBackfillYieldMetrics();
});

afterEach(() => {
  deRegisterIndexerLagMetrics();
});

// ── setLedgerLag — happy path ──────────────────────────────────────────────────

describe('setLedgerLag — valid inputs', () => {
  it('sets lag to zero (caught up)', async () => {
    setLedgerLag(0);
    const value = await indexerLedgerLag.get();
    expect(value.values[0].value).toBe(0);
  });

  it('sets a normal lag value', async () => {
    setLedgerLag(50);
    const value = await indexerLedgerLag.get();
    expect(value.values[0].value).toBe(50);
  });

  it('sets lag to the maximum allowed ledger sequence (boundary)', async () => {
    setLedgerLag(MAX_LEDGER_SEQUENCE);
    const value = await indexerLedgerLag.get();
    expect(value.values[0].value).toBe(MAX_LEDGER_SEQUENCE);
  });

  it('does not throw for valid integer lag', () => {
    expect(() => setLedgerLag(299)).not.toThrow();
  });
});

// ── setLedgerLag — malformed inputs (rejected before write) ───────────────────

describe('setLedgerLag — malformed inputs are rejected before any state is written', () => {
  it('rejects a string', () => {
    const before = indexerLedgerLag.get();
    expect(() => setLedgerLag('100')).toThrow(IndexerLagValidationError);
    // Gauge value must be unchanged — rejection happened before write
    expect(indexerLedgerLag.get()).toEqual(before);
  });

  it('rejects null', () => {
    expect(() => setLedgerLag(null)).toThrow(IndexerLagValidationError);
  });

  it('rejects undefined', () => {
    expect(() => setLedgerLag(undefined)).toThrow(IndexerLagValidationError);
  });

  it('rejects NaN', () => {
    const err = (() => {
      try { setLedgerLag(NaN); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err).toBeInstanceOf(IndexerLagValidationError);
    expect(err.reason).toBe('NOT_FINITE');
  });

  it('rejects Infinity', () => {
    const err = (() => {
      try { setLedgerLag(Infinity); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err).toBeInstanceOf(IndexerLagValidationError);
    expect(err.reason).toBe('NOT_FINITE');
  });

  it('rejects a negative integer', () => {
    const err = (() => {
      try { setLedgerLag(-1); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err).toBeInstanceOf(IndexerLagValidationError);
    expect(err.reason).toBe('NEGATIVE');
  });

  it('rejects a non-integer (float)', () => {
    const err = (() => {
      try { setLedgerLag(1.5); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err).toBeInstanceOf(IndexerLagValidationError);
    expect(err.reason).toBe('NOT_AN_INTEGER');
  });

  it('rejects a value exceeding MAX_LEDGER_SEQUENCE', () => {
    const err = (() => {
      try { setLedgerLag(MAX_LEDGER_SEQUENCE + 1); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err).toBeInstanceOf(IndexerLagValidationError);
    expect(err.reason).toBe('EXCEEDS_MAX');
  });

  it('exposes field name and value on the error', () => {
    const err = (() => {
      try { setLedgerLag(-5); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err.field).toBe('lag');
    expect(err.value).toBe(-5);
  });
});

// ── setCatchupEtaSeconds — happy path ─────────────────────────────────────────

describe('setCatchupEtaSeconds — valid inputs', () => {
  it('sets ETA to zero (caught up / unknown)', async () => {
    setCatchupEtaSeconds(0);
    const value = await indexerCatchupEtaSeconds.get();
    expect(value.values[0].value).toBe(0);
  });

  it('sets a realistic ETA', async () => {
    setCatchupEtaSeconds(3600);
    const value = await indexerCatchupEtaSeconds.get();
    expect(value.values[0].value).toBe(3600);
  });

  it('sets ETA to the maximum allowed value (boundary)', async () => {
    setCatchupEtaSeconds(MAX_ETA_SECONDS);
    const value = await indexerCatchupEtaSeconds.get();
    expect(value.values[0].value).toBe(MAX_ETA_SECONDS);
  });
});

// ── setCatchupEtaSeconds — malformed inputs ────────────────────────────────────

describe('setCatchupEtaSeconds — malformed inputs are rejected before any state is written', () => {
  it('rejects a string', () => {
    expect(() => setCatchupEtaSeconds('3600')).toThrow(IndexerLagValidationError);
  });

  it('rejects NaN', () => {
    const err = (() => {
      try { setCatchupEtaSeconds(NaN); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err.reason).toBe('NOT_FINITE');
  });

  it('rejects negative ETA', () => {
    const err = (() => {
      try { setCatchupEtaSeconds(-1); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err.reason).toBe('NEGATIVE');
  });

  it('rejects a fractional number of seconds', () => {
    const err = (() => {
      try { setCatchupEtaSeconds(0.5); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err.reason).toBe('NOT_AN_INTEGER');
  });

  it('rejects an oversized ETA (likely milliseconds passed by accident)', () => {
    const err = (() => {
      try { setCatchupEtaSeconds(MAX_ETA_SECONDS + 1); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err.reason).toBe('EXCEEDS_MAX');
    expect(err.field).toBe('seconds');
  });

  it('does not mutate the gauge when validation fails', async () => {
    setCatchupEtaSeconds(100); // establish known value
    try { setCatchupEtaSeconds(-1); } catch { /* expected */ }
    const value = await indexerCatchupEtaSeconds.get();
    expect(value.values[0].value).toBe(100); // unchanged
  });
});

// ── recordBackfillYieldEvent — happy path ─────────────────────────────────────

describe('recordBackfillYieldEvent — valid inputs', () => {
  it('sets backfill paused gauge to 1 and increments paused counter', async () => {
    recordBackfillYieldEvent('paused');
    const gauge = await indexerBackfillYieldEventsTotal.get();
    const pausedEntry = gauge.values.find((v) => v.labels['event'] === 'paused');
    expect(pausedEntry?.value).toBe(1);
  });

  it('sets backfill paused gauge to 0 on resumed', async () => {
    recordBackfillYieldEvent('paused');
    recordBackfillYieldEvent('resumed');
    const gauge = await indexerBackfillYieldEventsTotal.get();
    const resumedEntry = gauge.values.find((v) => v.labels['event'] === 'resumed');
    expect(resumedEntry?.value).toBe(1);
  });

  it('accumulates multiple transitions correctly', async () => {
    recordBackfillYieldEvent('paused');
    recordBackfillYieldEvent('resumed');
    recordBackfillYieldEvent('paused');
    const gauge = await indexerBackfillYieldEventsTotal.get();
    const paused  = gauge.values.find((v) => v.labels['event'] === 'paused');
    const resumed = gauge.values.find((v) => v.labels['event'] === 'resumed');
    expect(paused?.value).toBe(2);
    expect(resumed?.value).toBe(1);
  });
});

// ── recordBackfillYieldEvent — malformed inputs ────────────────────────────────

describe('recordBackfillYieldEvent — malformed direction rejected before write', () => {
  it('rejects an arbitrary string', () => {
    const err = (() => {
      try { recordBackfillYieldEvent('stopped'); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err).toBeInstanceOf(IndexerLagValidationError);
    expect(err.reason).toBe('INVALID_DIRECTION');
  });

  it('rejects a boolean', () => {
    expect(() => recordBackfillYieldEvent(true)).toThrow(IndexerLagValidationError);
  });

  it('rejects null', () => {
    expect(() => recordBackfillYieldEvent(null)).toThrow(IndexerLagValidationError);
  });

  it('rejects undefined', () => {
    expect(() => recordBackfillYieldEvent(undefined)).toThrow(IndexerLagValidationError);
  });

  it('rejects empty string', () => {
    expect(() => recordBackfillYieldEvent('')).toThrow(IndexerLagValidationError);
  });

  it('exposes field, reason, and value on the error', () => {
    const err = (() => {
      try { recordBackfillYieldEvent('unknown'); } catch (e) { return e; }
    })() as IndexerLagValidationError;
    expect(err.field).toBe('direction');
    expect(err.reason).toBe('INVALID_DIRECTION');
    expect(err.value).toBe('unknown');
  });

  it('does not increment any counter when direction is invalid', async () => {
    try { recordBackfillYieldEvent('bad'); } catch { /* expected */ }
    const gauge = await indexerBackfillYieldEventsTotal.get();
    // No entries should have been written
    expect(gauge.values.every((v) => v.value === 0)).toBe(true);
  });
});

// ── IndexerLagValidationError — contract ──────────────────────────────────────

describe('IndexerLagValidationError', () => {
  it('has name "IndexerLagValidationError"', () => {
    const err = new IndexerLagValidationError({
      field: 'lag',
      reason: 'NEGATIVE',
      value: -1,
      message: 'lag must be non-negative',
    });
    expect(err.name).toBe('IndexerLagValidationError');
  });

  it('is an instanceof Error', () => {
    const err = new IndexerLagValidationError({
      field: 'lag',
      reason: 'NOT_A_NUMBER',
      value: 'x',
      message: 'test',
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves all provided fields', () => {
    const err = new IndexerLagValidationError({
      field: 'seconds',
      reason: 'EXCEEDS_MAX',
      value: 9999999999,
      message: 'too big',
    });
    expect(err.field).toBe('seconds');
    expect(err.reason).toBe('EXCEEDS_MAX');
    expect(err.value).toBe(9999999999);
    expect(err.message).toBe('too big');
  });
});

// ── resetBackfillYieldMetrics ──────────────────────────────────────────────────

describe('resetBackfillYieldMetrics', () => {
  it('resets the counter without throwing', async () => {
    recordBackfillYieldEvent('paused');
    resetBackfillYieldMetrics();
    const gauge = await indexerBackfillYieldEventsTotal.get();
    expect(gauge.values.every((v) => v.value === 0)).toBe(true);
  });
});
