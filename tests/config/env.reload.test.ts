/**
 * SIGHUP Runtime Config Reload — unit tests (issue #946)
 *
 * Tests cover:
 *  - reloadHotConfig() reads current process.env values
 *  - All rate-limit fields parsed correctly (int or undefined)
 *  - Tracing, log-level, feature-flag fields forwarded correctly
 *  - Returned object is frozen (atomicity / immutability guarantee)
 *  - All expected fields present (completeness / atomicity)
 *  - captureStartupEnvSnapshot() is idempotent
 *  - Restart-only key changes do NOT throw; hot values still returned
 *  - warn() is called for each changed restart-only key
 *  - setRuntimeRateLimitConfig() is correctly driven by the SIGHUP handler
 *  - reloadFlags() is driven correctly by the SIGHUP handler
 *
 * Design note on test isolation
 * ──────────────────────────────
 * These tests use the **static-import** pattern instead of
 * vi.resetModules() + dynamic import().  The dynamic-import approach
 * triggers Vite's SSR transform which injects __vite_ssr_exportName__
 * calls that are undefined in the vitest 1.x runtime when Vite ≥ 6 is
 * present on the module search path — causing every test to fail with
 * a ReferenceError before any assertion runs.
 *
 * Because reloadHotConfig() reads process.env at call-time (no cached
 * state), and because we export resetStartupEnvSnapshot() for test
 * isolation of the snapshot state, static imports are fully sufficient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  reloadHotConfig,
  captureStartupEnvSnapshot,
  resetStartupEnvSnapshot,
} from '../../src/config/env.js';
import {
  getRuntimeRateLimitConfig,
  resetRuntimeRateLimitConfig,
  setRuntimeRateLimitConfig,
} from '../../src/config/rateLimits.js';
import { reloadFlags, getFlags } from '../../src/config/featureFlags.js';

// ─── env save/restore helpers ─────────────────────────────────────────────────

const HOT_KEYS = [
  'RATE_LIMIT_IP_WINDOW_MS',
  'RATE_LIMIT_IP_MAX',
  'RATE_LIMIT_APIKEY_WINDOW_MS',
  'RATE_LIMIT_APIKEY_MAX',
  'RATE_LIMIT_ADMIN_WINDOW_MS',
  'RATE_LIMIT_ADMIN_MAX',
  'TRACING_SAMPLE_RATE',
  'TRACING_ENABLED',
  'LOG_LEVEL',
  'FEATURE_FLAGS_JSON',
  'FEATURE_FLAGS_FILE',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'INDEXER_WORKER_TOKEN',
] as const;

type HotKey = (typeof HOT_KEYS)[number];
const saved: Partial<Record<HotKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of HOT_KEYS) saved[k] = process.env[k];
  // Reset module-level snapshot so each test starts clean.
  resetStartupEnvSnapshot();
  // Reset runtime rate-limit overrides.
  resetRuntimeRateLimitConfig();
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of HOT_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetStartupEnvSnapshot();
  resetRuntimeRateLimitConfig();
});

// ─── reloadHotConfig ──────────────────────────────────────────────────────────

describe('reloadHotConfig', () => {
  it('reads rate-limit integers from process.env', () => {
    process.env.RATE_LIMIT_IP_WINDOW_MS = '30000';
    process.env.RATE_LIMIT_IP_MAX = '200';
    process.env.RATE_LIMIT_APIKEY_WINDOW_MS = '45000';
    process.env.RATE_LIMIT_APIKEY_MAX = '300';
    process.env.RATE_LIMIT_ADMIN_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_ADMIN_MAX = '2500';

    const hot = reloadHotConfig();

    expect(hot.rateLimitIpWindowMs).toBe(30000);
    expect(hot.rateLimitIpMax).toBe(200);
    expect(hot.rateLimitApikeyWindowMs).toBe(45000);
    expect(hot.rateLimitApikeyMax).toBe(300);
    expect(hot.rateLimitAdminWindowMs).toBe(60000);
    expect(hot.rateLimitAdminMax).toBe(2500);
  });

  it('returns undefined for optional rate-limit keys when not set', () => {
    delete process.env.RATE_LIMIT_IP_WINDOW_MS;
    delete process.env.RATE_LIMIT_IP_MAX;
    delete process.env.RATE_LIMIT_APIKEY_WINDOW_MS;
    delete process.env.RATE_LIMIT_APIKEY_MAX;
    delete process.env.RATE_LIMIT_ADMIN_WINDOW_MS;
    delete process.env.RATE_LIMIT_ADMIN_MAX;

    const hot = reloadHotConfig();

    expect(hot.rateLimitIpWindowMs).toBeUndefined();
    expect(hot.rateLimitIpMax).toBeUndefined();
    expect(hot.rateLimitApikeyWindowMs).toBeUndefined();
    expect(hot.rateLimitApikeyMax).toBeUndefined();
    expect(hot.rateLimitAdminWindowMs).toBeUndefined();
    expect(hot.rateLimitAdminMax).toBeUndefined();
  });

  it('reads tracing and log-level fields', () => {
    process.env.TRACING_SAMPLE_RATE = '0.5';
    process.env.TRACING_ENABLED = 'true';
    process.env.LOG_LEVEL = 'debug';

    const hot = reloadHotConfig();

    expect(hot.tracingSampleRate).toBe(0.5);
    expect(hot.tracingEnabled).toBe(true);
    expect(hot.logLevel).toBe('debug');
  });

  it('defaults tracingSampleRate to 1 when unset', () => {
    delete process.env.TRACING_SAMPLE_RATE;
    expect(reloadHotConfig().tracingSampleRate).toBe(1);
  });

  it('defaults tracingEnabled to false when unset', () => {
    delete process.env.TRACING_ENABLED;
    expect(reloadHotConfig().tracingEnabled).toBe(false);
  });

  it('defaults logLevel to "info" when unset', () => {
    delete process.env.LOG_LEVEL;
    expect(reloadHotConfig().logLevel).toBe('info');
  });

  it('falls back to "info" for an unrecognised log level', () => {
    process.env.LOG_LEVEL = 'verbose'; // not a valid level
    expect(reloadHotConfig().logLevel).toBe('info');
  });

  it('clamps tracingSampleRate to 1 for out-of-range values', () => {
    process.env.TRACING_SAMPLE_RATE = '99'; // >1 — should fallback to default
    expect(reloadHotConfig().tracingSampleRate).toBe(1);
  });

  it('forwards FEATURE_FLAGS_JSON', () => {
    process.env.FEATURE_FLAGS_JSON = '[{"name":"f","percentage":50}]';
    expect(reloadHotConfig().featureFlagsJson).toBe('[{"name":"f","percentage":50}]');
  });

  it('forwards FEATURE_FLAGS_FILE', () => {
    delete process.env.FEATURE_FLAGS_JSON;
    process.env.FEATURE_FLAGS_FILE = '/tmp/flags.json';
    expect(reloadHotConfig().featureFlagsFile).toBe('/tmp/flags.json');
  });

  it('returns undefined for featureFlagsJson/File when unset', () => {
    delete process.env.FEATURE_FLAGS_JSON;
    delete process.env.FEATURE_FLAGS_FILE;
    const hot = reloadHotConfig();
    expect(hot.featureFlagsJson).toBeUndefined();
    expect(hot.featureFlagsFile).toBeUndefined();
  });

  it('returns a frozen object (immutable / atomic)', () => {
    const hot = reloadHotConfig();
    expect(Object.isFrozen(hot)).toBe(true);
  });

  it('contains all expected fields (completeness = atomicity)', () => {
    const hot = reloadHotConfig();
    const expectedKeys: (keyof typeof hot)[] = [
      'rateLimitIpWindowMs', 'rateLimitIpMax',
      'rateLimitApikeyWindowMs', 'rateLimitApikeyMax',
      'rateLimitAdminWindowMs', 'rateLimitAdminMax',
      'tracingSampleRate', 'tracingEnabled', 'logLevel',
      'featureFlagsJson', 'featureFlagsFile',
    ];
    for (const k of expectedKeys) {
      expect(k in hot, `expected key "${k}" to be present`).toBe(true);
    }
  });

  it('picks up changed values on subsequent calls', () => {
    process.env.RATE_LIMIT_IP_MAX = '50';
    expect(reloadHotConfig().rateLimitIpMax).toBe(50);

    process.env.RATE_LIMIT_IP_MAX = '999';
    expect(reloadHotConfig().rateLimitIpMax).toBe(999);
  });

  it('parses boolean "1"/"0" for TRACING_ENABLED', () => {
    process.env.TRACING_ENABLED = '1';
    expect(reloadHotConfig().tracingEnabled).toBe(true);

    process.env.TRACING_ENABLED = '0';
    expect(reloadHotConfig().tracingEnabled).toBe(false);
  });

  it('rejects negative rate limit values', () => {
    process.env.RATE_LIMIT_IP_MAX = '-100';
    expect(reloadHotConfig().rateLimitIpMax).toBeUndefined();

    process.env.RATE_LIMIT_IP_WINDOW_MS = '-50000';
    expect(reloadHotConfig().rateLimitIpWindowMs).toBeUndefined();
  });

  it('rejects zero rate limit values', () => {
    process.env.RATE_LIMIT_IP_MAX = '0';
    expect(reloadHotConfig().rateLimitIpMax).toBeUndefined();

    process.env.RATE_LIMIT_APIKEY_MAX = '0';
    expect(reloadHotConfig().rateLimitApikeyMax).toBeUndefined();
  });

  it('rejects non-numeric rate limit values', () => {
    process.env.RATE_LIMIT_IP_MAX = 'not-a-number';
    expect(reloadHotConfig().rateLimitIpMax).toBeUndefined();

    process.env.RATE_LIMIT_IP_WINDOW_MS = 'abc';
    expect(reloadHotConfig().rateLimitIpWindowMs).toBeUndefined();
  });
});

// ─── captureStartupEnvSnapshot ───────────────────────────────────────────────

describe('captureStartupEnvSnapshot', () => {
  it('is idempotent — second call keeps the first snapshot', () => {
    process.env.DATABASE_URL = 'postgresql://first:5432/db';
    captureStartupEnvSnapshot();

    // Change value before second call — second call must be a no-op.
    process.env.DATABASE_URL = 'postgresql://second:5432/db';
    captureStartupEnvSnapshot(); // should NOT overwrite

    // Now mutate further: if snapshot was overwritten with "second",
    // "second" would equal current and no warn would fire.
    // We verify the snapshot still holds "first" by checking a warn fires.
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.DATABASE_URL = 'postgresql://third:5432/db';
    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');
  });

  it('captures snapshot implicitly on first reloadHotConfig call when not pre-called', () => {
    // resetStartupEnvSnapshot already called in beforeEach.
    process.env.DATABASE_URL = 'postgresql://implicit:5432/db';
    // Calling reloadHotConfig without prior captureStartupEnvSnapshot must not throw.
    expect(() => reloadHotConfig()).not.toThrow();
  });
});

// ─── Restart-only key detection ───────────────────────────────────────────────

describe('restart-only key detection', () => {
  it('does not throw when a restart-only key changes', () => {
    captureStartupEnvSnapshot();
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    expect(() => reloadHotConfig()).not.toThrow();
  });

  it('emits a warn log for each changed restart-only key', () => {
    captureStartupEnvSnapshot();
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    process.env.JWT_SECRET = 'changed-secret-that-is-long-enough-for-the-schema-xxxxxxx';
    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('JWT_SECRET');
  });

  it('still returns correct hot values even when restart-only keys changed', () => {
    process.env.RATE_LIMIT_IP_MAX = '42';
    captureStartupEnvSnapshot();
    process.env.DATABASE_URL = 'postgresql://mutated:5432/db';

    const hot = reloadHotConfig();
    expect(hot.rateLimitIpMax).toBe(42);
  });

  it('does NOT emit a warn when restart-only keys are unchanged', () => {
    captureStartupEnvSnapshot();
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Only change hot-reloadable keys.
    process.env.RATE_LIMIT_IP_MAX = '77';
    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    // No restart-only variable name should appear in logs.
    expect(output).not.toContain('DATABASE_URL');
    expect(output).not.toContain('REDIS_URL');
    expect(output).not.toContain('JWT_SECRET');
    expect(output).not.toContain('INDEXER_WORKER_TOKEN');
  });
});

// ─── setRuntimeRateLimitConfig wiring ────────────────────────────────────────

describe('SIGHUP → setRuntimeRateLimitConfig wiring', () => {
  it('hot-swaps IP rate-limit into the runtime store', () => {
    process.env.RATE_LIMIT_IP_WINDOW_MS = '20000';
    process.env.RATE_LIMIT_IP_MAX = '150';

    const hot = reloadHotConfig();
    setRuntimeRateLimitConfig({
      ip: {
        windowMs: hot.rateLimitIpWindowMs ?? 60_000,
        max:      hot.rateLimitIpMax      ?? 100,
        enabled:  true,
      },
    });

    const runtime = getRuntimeRateLimitConfig();
    expect(runtime?.ip.windowMs).toBe(20000);
    expect(runtime?.ip.max).toBe(150);
    expect(runtime?.ip.enabled).toBe(true);
  });

  it('falls back to defaults when env keys are absent', () => {
    delete process.env.RATE_LIMIT_IP_WINDOW_MS;
    delete process.env.RATE_LIMIT_IP_MAX;

    const hot = reloadHotConfig();
    setRuntimeRateLimitConfig({
      ip: {
        windowMs: hot.rateLimitIpWindowMs ?? 60_000,
        max:      hot.rateLimitIpMax      ?? 100,
        enabled:  true,
      },
    });

    const runtime = getRuntimeRateLimitConfig();
    expect(runtime?.ip.windowMs).toBe(60_000);
    expect(runtime?.ip.max).toBe(100);
  });
});

// ─── reloadFlags wiring ───────────────────────────────────────────────────────

describe('SIGHUP → reloadFlags wiring', () => {
  it('reloads feature flags from FEATURE_FLAGS_JSON', () => {
    process.env.FEATURE_FLAGS_JSON = '[{"name":"beta","percentage":100}]';
    reloadFlags();
    expect(getFlags().get('beta')?.percentage).toBe(100);
  });

  it('returns an empty map when FEATURE_FLAGS_JSON is cleared', () => {
    delete process.env.FEATURE_FLAGS_JSON;
    delete process.env.FEATURE_FLAGS_FILE;
    reloadFlags();
    expect(getFlags().size).toBe(0);
  });

  it('handles malformed FEATURE_FLAGS_JSON gracefully', () => {
    process.env.FEATURE_FLAGS_JSON = 'invalid-json{{{';
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    
    reloadFlags();
    
    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Invalid feature flags JSON');
    expect(getFlags().size).toBe(0);
  });

  it('handles FEATURE_FLAGS_JSON with invalid entries gracefully', () => {
    process.env.FEATURE_FLAGS_JSON = '[{"name":"valid","percentage":50},{"name":"","percentage":10}]';
    reloadFlags();
    
    // Valid entry should be loaded, invalid entry skipped
    expect(getFlags().get('valid')?.percentage).toBe(50);
    expect(getFlags().size).toBe(1);
  });

  it('handles FEATURE_FLAGS_FILE read errors gracefully', () => {
    process.env.FEATURE_FLAGS_FILE = '/nonexistent/path/to/flags.json';
    delete process.env.FEATURE_FLAGS_JSON;
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    
    reloadFlags();
    
    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Could not read FEATURE_FLAGS_FILE');
    expect(getFlags().size).toBe(0);
  });
});

// ─── Concurrent reload safety ───────────────────────────────────────────────────

describe('concurrent reloadHotConfig calls', () => {
  it('handles concurrent reloadHotConfig calls safely', () => {
    process.env.RATE_LIMIT_IP_MAX = '100';
    process.env.TRACING_SAMPLE_RATE = '0.5';
    
    // Simulate concurrent calls
    const results = Array.from({ length: 10 }, () => reloadHotConfig());
    
    // All results should be consistent and frozen
    for (const result of results) {
      expect(result.rateLimitIpMax).toBe(100);
      expect(result.tracingSampleRate).toBe(0.5);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it('maintains atomicity when env changes during concurrent calls', () => {
    process.env.RATE_LIMIT_IP_MAX = '50';
    
    // First batch of calls
    const firstBatch = Array.from({ length: 5 }, () => reloadHotConfig());
    
    // Change env mid-stream
    process.env.RATE_LIMIT_IP_MAX = '200';
    
    // Second batch of calls
    const secondBatch = Array.from({ length: 5 }, () => reloadHotConfig());
    
    // First batch should have old value, second batch new value
    for (const result of firstBatch) {
      expect(result.rateLimitIpMax).toBe(50);
    }
    for (const result of secondBatch) {
      expect(result.rateLimitIpMax).toBe(200);
    }
  });
});

// ─── Empty/undefined hot config values ───────────────────────────────────────────

describe('empty/undefined hot config values', () => {
  it('handles empty string rate limit values as undefined', () => {
    process.env.RATE_LIMIT_IP_MAX = '';
    process.env.RATE_LIMIT_IP_WINDOW_MS = '';
    
    const hot = reloadHotConfig();
    expect(hot.rateLimitIpMax).toBeUndefined();
    expect(hot.rateLimitIpWindowMs).toBeUndefined();
  });

  it('handles empty string tracing values with defaults', () => {
    process.env.TRACING_SAMPLE_RATE = '';
    process.env.TRACING_ENABLED = '';
    process.env.LOG_LEVEL = '';
    
    const hot = reloadHotConfig();
    expect(hot.tracingSampleRate).toBe(1); // default
    expect(hot.tracingEnabled).toBe(false); // default
    expect(hot.logLevel).toBe('info'); // default
  });

  it('handles empty string feature flags as undefined', () => {
    process.env.FEATURE_FLAGS_JSON = '';
    process.env.FEATURE_FLAGS_FILE = '';
    
    const hot = reloadHotConfig();
    expect(hot.featureFlagsJson).toBeUndefined();
    expect(hot.featureFlagsFile).toBeUndefined();
  });

  it('handles whitespace-only values appropriately', () => {
    process.env.RATE_LIMIT_IP_MAX = '   ';
    process.env.LOG_LEVEL = '   ';
    
    const hot = reloadHotConfig();
    expect(hot.rateLimitIpMax).toBeUndefined();
    expect(hot.logLevel).toBe('info'); // fallback to default
  });
});

// ─── Security: no secret values in warn output ────────────────────────────────

describe('security: restart-only warn does not leak secrets', () => {
  it('warn message contains only the variable NAME, not its value', () => {
    const secretValue = 'super-secret-jwt-key-do-not-log-this-xyz-1234567890';
    process.env.JWT_SECRET = secretValue;
    captureStartupEnvSnapshot();

    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.JWT_SECRET = 'another-secret-that-changed-xxxxxxxxxxxxxxxxxxxxxxxxxxx';
    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('JWT_SECRET');
    expect(output).not.toContain(secretValue);
  });
});
