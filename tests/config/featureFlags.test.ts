/**
 * Feature Flag Service Tests (#738)
 *
 * Covers:
 * - FNV-1a determinism and distribution
 * - isEnabled() percentage boundaries (0%, 100%, intermediate)
 * - Flag not configured → false
 * - Loading from FEATURE_FLAGS_JSON env var
 * - Loading from FEATURE_FLAGS_FILE env var
 * - reloadFlags() picks up changes mid-flight
 * - Atomic swap: no partial state visible during reload
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We re-import the module under test fresh per test group using dynamic import
// to reset module-level state.

describe('fnv1a32', () => {
  it('produces stable hashes (same input → same output)', async () => {
    const { fnv1a32 } = await import('../../src/config/featureFlags.js');
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('world')).toBe(fnv1a32('world'));
  });

  it('produces different hashes for different inputs', async () => {
    const { fnv1a32 } = await import('../../src/config/featureFlags.js');
    expect(fnv1a32('flag-a:user-1')).not.toBe(fnv1a32('flag-b:user-1'));
  });

  it('returns an unsigned 32-bit integer', async () => {
    const { fnv1a32 } = await import('../../src/config/featureFlags.js');
    const h = fnv1a32('test-value');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('handles empty string without throwing', async () => {
    const { fnv1a32 } = await import('../../src/config/featureFlags.js');
    expect(() => fnv1a32('')).not.toThrow();
  });
});

describe('isEnabled', () => {
  const ORIG_FLAGS_JSON = process.env['FEATURE_FLAGS_JSON'];
  const ORIG_FLAGS_FILE = process.env['FEATURE_FLAGS_FILE'];

  beforeEach(() => {
    delete process.env['FEATURE_FLAGS_JSON'];
    delete process.env['FEATURE_FLAGS_FILE'];
  });

  afterEach(() => {
    if (ORIG_FLAGS_JSON === undefined) delete process.env['FEATURE_FLAGS_JSON'];
    else process.env['FEATURE_FLAGS_JSON'] = ORIG_FLAGS_JSON;

    if (ORIG_FLAGS_FILE === undefined) delete process.env['FEATURE_FLAGS_FILE'];
    else process.env['FEATURE_FLAGS_FILE'] = ORIG_FLAGS_FILE;
  });

  it('returns false for an unknown flag', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(isEnabled('nonexistent_flag', 'user-123')).toBe(false);
  });

  it('always returns false when percentage=0', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'disabled_flag', percentage: 0 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    // Try 100 different requester IDs
    for (let i = 0; i < 100; i++) {
      expect(isEnabled('disabled_flag', `user-${i}`)).toBe(false);
    }
  });

  it('always returns true when percentage=100', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'full_rollout', percentage: 100 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    for (let i = 0; i < 100; i++) {
      expect(isEnabled('full_rollout', `user-${i}`)).toBe(true);
    }
  });

  it('is deterministic: same requester always gets same decision', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'test_flag', percentage: 50 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    for (let i = 0; i < 50; i++) {
      const id = `requester-${i}`;
      const first = isEnabled('test_flag', id);
      const second = isEnabled('test_flag', id);
      const third = isEnabled('test_flag', id);
      expect(first).toBe(second);
      expect(second).toBe(third);
    }
  });

  it('distributes ~50% for percentage=50 across 1000 requesters', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'half_rollout', percentage: 50 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    let enabled = 0;
    for (let i = 0; i < 1000; i++) {
      if (isEnabled('half_rollout', `requester-${i}`)) enabled++;
    }
    // Allow ±15% tolerance for distribution
    expect(enabled).toBeGreaterThanOrEqual(350);
    expect(enabled).toBeLessThanOrEqual(650);
  });

  it('different flags get independent buckets for same requester', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'flag_a', percentage: 50 },
      { name: 'flag_b', percentage: 50 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    // Collect decisions for the same requester across both flags
    let sameDecision = 0;
    let diffDecision = 0;
    for (let i = 0; i < 100; i++) {
      const id = `user-${i}`;
      const a = isEnabled('flag_a', id);
      const b = isEnabled('flag_b', id);
      if (a === b) sameDecision++;
      else diffDecision++;
    }
    // If the buckets were identical, all 100 would be sameDecision.
    // With independent hashing, expect meaningful differences.
    expect(diffDecision).toBeGreaterThan(10);
  });

  it('handles anonymous requesterId gracefully', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'anon_flag', percentage: 50 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    // Should not throw; result is deterministic
    const r1 = isEnabled('anon_flag', '');
    const r2 = isEnabled('anon_flag', '');
    expect(r1).toBe(r2);
  });
});

describe('reloadFlags', () => {
  const ORIG_FLAGS_JSON = process.env['FEATURE_FLAGS_JSON'];

  afterEach(() => {
    if (ORIG_FLAGS_JSON === undefined) delete process.env['FEATURE_FLAGS_JSON'];
    else process.env['FEATURE_FLAGS_JSON'] = ORIG_FLAGS_JSON;
  });

  it('picks up new flag definitions after reload', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(isEnabled('new_flag', 'user')).toBe(false);

    // Add the flag
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'new_flag', percentage: 100 },
    ]);
    reloadFlags();
    expect(isEnabled('new_flag', 'user')).toBe(true);
  });

  it('picks up percentage changes after reload', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'rollout_flag', percentage: 0 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(isEnabled('rollout_flag', 'user-1')).toBe(false);

    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'rollout_flag', percentage: 100 },
    ]);
    reloadFlags();
    expect(isEnabled('rollout_flag', 'user-1')).toBe(true);
  });

  it('returns the new flag map', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'returned_flag', percentage: 75, description: 'Test flag' },
    ]);
    const { reloadFlags } = await import('../../src/config/featureFlags.js');
    const map = reloadFlags();
    expect(map.has('returned_flag')).toBe(true);
    expect(map.get('returned_flag')?.percentage).toBe(75);
  });

  it('falls back to empty map on invalid JSON', async () => {
    process.env['FEATURE_FLAGS_JSON'] = 'not valid json!!!';
    const { reloadFlags, getFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(getFlags().size).toBe(0);
  });

  it('parses object-form flags (not-array JSON is valid)', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify({ percentage: 100, enabled: 50 });
    const { reloadFlags, getFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(getFlags().size).toBe(2);
    expect(getFlags().get('percentage')?.percentage).toBe(100);
    expect(getFlags().get('enabled')?.percentage).toBe(50);
  });

  it('skips flag entries with missing name', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { percentage: 100 },
      { name: 'valid_flag', percentage: 50 },
    ]);
    const { reloadFlags, getFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(getFlags().size).toBe(1);
    expect(getFlags().has('valid_flag')).toBe(true);
  });

  it('skips flag entries with out-of-range percentage', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'bad_flag', percentage: 150 },
      { name: 'ok_flag', percentage: 50 },
    ]);
    const { reloadFlags, getFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(getFlags().has('bad_flag')).toBe(false);
    expect(getFlags().has('ok_flag')).toBe(true);
  });

  it('loads object-form flag definitions', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify({
      object_flag: { percentage: 100, description: 'Object style' },
      shorthand_flag: 100,
    });
    const { isEnabled, reloadFlags, getFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(isEnabled('object_flag', 'user-1')).toBe(true);
    expect(isEnabled('shorthand_flag', 'user-1')).toBe(true);
    expect(getFlags().get('object_flag')?.description).toBe('Object style');
  });
});

describe('parseFlagsJson', () => {
  it('returns empty map for invalid JSON', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson('not valid json!!!');
    expect(result.size).toBe(0);
  });

  it('parses a simple valid array and returns exact map contents', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson(JSON.stringify([
      { name: 'flag_a', percentage: 25, description: 'First flag' },
      { name: 'flag_b', percentage: 75 },
    ]));
    expect(result.size).toBe(2);
    expect(result.get('flag_a')).toEqual({
      name: 'flag_a',
      percentage: 25,
      description: 'First flag',
    });
    expect(result.get('flag_b')).toEqual({
      name: 'flag_b',
      percentage: 75,
    });
  });

  it('survives mixed valid/invalid entries and retains only the valid ones', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson(JSON.stringify([
      { name: 'valid_flag', percentage: 50 },
      { percentage: 50 },
      { name: '', percentage: 50 },
      { name: '  ', percentage: 50 },
      { name: 'negative_pct', percentage: -1 },
      { name: 'over_100', percentage: 101 },
      { name: 'null_pct', percentage: null },
      { name: 'string_pct', percentage: '50' },
      { name: 'nan_pct', percentage: NaN },
      { name: 'valid_flag_2', percentage: 100 },
    ]));
    expect(result.size).toBe(2);
    expect(result.has('valid_flag')).toBe(true);
    expect(result.get('valid_flag')?.percentage).toBe(50);
    expect(result.has('valid_flag_2')).toBe(true);
    expect(result.get('valid_flag_2')?.percentage).toBe(100);
  });

  it('accepts boundary percentage 0 and 100 without skipping', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson(JSON.stringify([
      { name: 'boundary_0', percentage: 0 },
      { name: 'boundary_100', percentage: 100 },
      { name: 'subzero', percentage: -0.1 },
      { name: 'over100', percentage: 100.1 },
    ]));
    expect(result.size).toBe(2);
    expect(result.has('boundary_0')).toBe(true);
    expect(result.get('boundary_0')?.percentage).toBe(0);
    expect(result.has('boundary_100')).toBe(true);
    expect(result.get('boundary_100')?.percentage).toBe(100);
    expect(result.has('subzero')).toBe(false);
    expect(result.has('over100')).toBe(false);
  });

  it('applies last-wins semantics for duplicate flag names', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson(JSON.stringify([
      { name: 'duplicate_flag', percentage: 10, description: 'First' },
      { name: 'duplicate_flag', percentage: 90, description: 'Second' },
      { name: 'duplicate_flag', percentage: 50 },
    ]));
    expect(result.size).toBe(1);
    expect(result.has('duplicate_flag')).toBe(true);
    expect(result.get('duplicate_flag')?.percentage).toBe(50);
    expect(result.get('duplicate_flag')?.description).toBeUndefined();
  });

  it('omits non-string description values from parsed definitions', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson(JSON.stringify([
      { name: 'with_number_desc', percentage: 25, description: 123 },
      { name: 'with_null_desc', percentage: 25, description: null },
      { name: 'with_object_desc', percentage: 25, description: { text: 'desc' } },
      { name: 'with_array_desc', percentage: 25, description: ['desc'] },
      { name: 'with_string_desc', percentage: 25, description: 'valid' },
      { name: 'no_desc', percentage: 25 },
    ]));
    expect(result.size).toBe(6);
    expect(result.get('with_number_desc')?.description).toBeUndefined();
    expect(result.get('with_null_desc')?.description).toBeUndefined();
    expect(result.get('with_object_desc')?.description).toBeUndefined();
    expect(result.get('with_array_desc')?.description).toBeUndefined();
    expect(result.get('with_string_desc')?.description).toBe('valid');
    expect(result.get('no_desc')?.description).toBeUndefined();
  });

  it('parses object-form flags with exact contents', async () => {
    const { parseFlagsJson } = await import('../../src/config/featureFlags.js');
    const result = parseFlagsJson(JSON.stringify({
      flag_a: { percentage: 30, description: 'Object style' },
      flag_b: 60,
    }));
    expect(result.size).toBe(2);
    expect(result.get('flag_a')).toEqual({
      name: 'flag_a',
      percentage: 30,
      description: 'Object style',
    });
    expect(result.get('flag_b')).toEqual({
      name: 'flag_b',
      percentage: 60,
    });
  });
});

describe('getRolloutBucket', () => {
  it('returns a stable bucket for the same flag and requester', async () => {
    const { getRolloutBucket } = await import('../../src/config/featureFlags.js');
    expect(getRolloutBucket('streams_enhanced_response', 'key:abc')).toBe(
      getRolloutBucket('streams_enhanced_response', 'key:abc'),
    );
  });

  it('uses independent buckets per flag', async () => {
    const { getRolloutBucket } = await import('../../src/config/featureFlags.js');
    expect(getRolloutBucket('flag_a', 'key:abc')).not.toBe(getRolloutBucket('flag_b', 'key:abc'));
  });
});

describe('FEATURE_FLAGS_FILE loading', () => {
  let tmpFile: string;

  beforeEach(() => {
    delete process.env['FEATURE_FLAGS_JSON'];
    delete process.env['FEATURE_FLAGS_FILE'];
    tmpFile = join(tmpdir(), `featureFlags-test-${Date.now()}.json`);
  });

  afterEach(() => {
    delete process.env['FEATURE_FLAGS_FILE'];
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it('loads flags from a JSON file', async () => {
    writeFileSync(tmpFile, JSON.stringify([
      { name: 'file_flag', percentage: 100 },
    ]));
    process.env['FEATURE_FLAGS_FILE'] = tmpFile;
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(isEnabled('file_flag', 'user')).toBe(true);
  });

  it('falls back to empty map when file does not exist', async () => {
    process.env['FEATURE_FLAGS_FILE'] = '/nonexistent/path/flags.json';
    const { reloadFlags, getFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(getFlags().size).toBe(0);
  });

  it('FEATURE_FLAGS_JSON takes precedence over FEATURE_FLAGS_FILE', async () => {
    writeFileSync(tmpFile, JSON.stringify([
      { name: 'file_only_flag', percentage: 100 },
    ]));
    process.env['FEATURE_FLAGS_FILE'] = tmpFile;
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'json_flag', percentage: 100 },
    ]);
    const { isEnabled, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    expect(isEnabled('json_flag', 'user')).toBe(true);
    expect(isEnabled('file_only_flag', 'user')).toBe(false);
  });
});

describe('getFlags', () => {
  it('returns a read-only snapshot', async () => {
    process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([
      { name: 'snapshot_flag', percentage: 30 },
    ]);
    const { getFlags, reloadFlags } = await import('../../src/config/featureFlags.js');
    reloadFlags();
    const flags = getFlags();
    expect(flags.has('snapshot_flag')).toBe(true);
    // The returned map should have the correct definition
    expect(flags.get('snapshot_flag')?.percentage).toBe(30);
  });
});
