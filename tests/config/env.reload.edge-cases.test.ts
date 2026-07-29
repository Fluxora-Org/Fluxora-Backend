/**
 * Edge case tests for environment reload behavior.
 *
 * Tests cover:
 *   - Invalid input handling (malformed values)
 *   - Validation edge cases
 *   - Observability (logging, metrics)
 *   - Concurrency behavior
 *   - Error handling
 *
 * These tests document the current behavior and serve as regression
 * protection for edge cases not covered by the main test suite.
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
] as const;

type HotKey = (typeof HOT_KEYS)[number];
const saved: Partial<Record<HotKey, string | undefined>> = {};

beforeEach(() => {
  // Save current env
  for (const k of HOT_KEYS) saved[k] = process.env[k];
  resetStartupEnvSnapshot();
  resetRuntimeRateLimitConfig();
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore env
  for (const k of HOT_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetStartupEnvSnapshot();
  resetRuntimeRateLimitConfig();
  vi.clearAllMocks();
});

describe('reloadHotConfig - Validation Edge Cases', () => {
  describe('Rate limit validation', () => {
    it('handles non-numeric rate limit values gracefully', () => {
      process.env.RATE_LIMIT_IP_MAX = 'not-a-number';
      process.env.RATE_LIMIT_IP_WINDOW_MS = 'abc123';

      const hot = reloadHotConfig();

      // Should return undefined for invalid values
      expect(hot.rateLimitIpMax).toBeUndefined();
      expect(hot.rateLimitIpWindowMs).toBeUndefined();
    });

    it('rejects negative rate limit values', () => {
      process.env.RATE_LIMIT_IP_MAX = '-50';
      process.env.RATE_LIMIT_IP_WINDOW_MS = '-1000';

      const hot = reloadHotConfig();

      // The implementation correctly rejects non-positive values
      expect(hot.rateLimitIpMax).toBeUndefined();
      expect(hot.rateLimitIpWindowMs).toBeUndefined();
    });

    it('handles empty rate limit values as undefined', () => {
      process.env.RATE_LIMIT_IP_MAX = '';
      process.env.RATE_LIMIT_IP_WINDOW_MS = '';

      const hot = reloadHotConfig();

      expect(hot.rateLimitIpMax).toBeUndefined();
      expect(hot.rateLimitIpWindowMs).toBeUndefined();
    });

    it('handles rate limit values with whitespace', () => {
      process.env.RATE_LIMIT_IP_MAX = '  100  ';
      process.env.RATE_LIMIT_IP_WINDOW_MS = '  60000  ';

      const hot = reloadHotConfig();

      // Should parse despite whitespace
      expect(hot.rateLimitIpMax).toBe(100);
      expect(hot.rateLimitIpWindowMs).toBe(60000);
    });

    it('handles rate limit values with leading zeros', () => {
      process.env.RATE_LIMIT_IP_MAX = '00100';
      process.env.RATE_LIMIT_IP_WINDOW_MS = '060000';

      const hot = reloadHotConfig();

      // Leading zeros should parse correctly
      expect(hot.rateLimitIpMax).toBe(100);
      expect(hot.rateLimitIpWindowMs).toBe(60000);
    });
  });

  describe('Tracing validation', () => {
    it('clamps out-of-range sample rates', () => {
      process.env.TRACING_SAMPLE_RATE = '2.5';
      expect(reloadHotConfig().tracingSampleRate).toBe(1);

      process.env.TRACING_SAMPLE_RATE = '-0.5';
      expect(reloadHotConfig().tracingSampleRate).toBe(1);

      process.env.TRACING_SAMPLE_RATE = '1.5';
      expect(reloadHotConfig().tracingSampleRate).toBe(1);
    });

    it('handles non-numeric sample rates', () => {
      process.env.TRACING_SAMPLE_RATE = 'not-a-number';
      expect(reloadHotConfig().tracingSampleRate).toBe(1);
    });

    it('handles tracing enabled with invalid values', () => {
      // Invalid values should default to false
      process.env.TRACING_ENABLED = 'invalid';
      expect(reloadHotConfig().tracingEnabled).toBe(false);

      process.env.TRACING_ENABLED = 'yes';
      expect(reloadHotConfig().tracingEnabled).toBe(false);

      process.env.TRACING_ENABLED = 'on';
      expect(reloadHotConfig().tracingEnabled).toBe(false);
    });

    it('parses boolean "1" and "0" correctly', () => {
      process.env.TRACING_ENABLED = '1';
      expect(reloadHotConfig().tracingEnabled).toBe(true);

      process.env.TRACING_ENABLED = '0';
      expect(reloadHotConfig().tracingEnabled).toBe(false);
    });
  });

  describe('Log level validation', () => {
    it('defaults to "info" for invalid log levels', () => {
      const invalidLevels = ['verbose', 'trace', 'debugg', '', '  ', 'INFO', 'Debug'];

      for (const level of invalidLevels) {
        process.env.LOG_LEVEL = level;
        expect(reloadHotConfig().logLevel).toBe('info');
      }
    });

    it('accepts valid log levels', () => {
      const validLevels = ['debug', 'info', 'warn', 'error'];

      for (const level of validLevels) {
        process.env.LOG_LEVEL = level;
        expect(reloadHotConfig().logLevel).toBe(level);
      }
    });
  });

  describe('Feature flags validation', () => {
    it('handles malformed FEATURE_FLAGS_JSON gracefully', () => {
      process.env.FEATURE_FLAGS_JSON = '{ invalid json }';

      // reloadFlags() should not throw
      expect(() => reloadFlags()).not.toThrow();

      // Should return empty map
      expect(getFlags().size).toBe(0);
    });

    it('handles empty FEATURE_FLAGS_JSON', () => {
      process.env.FEATURE_FLAGS_JSON = '';
      expect(() => reloadFlags()).not.toThrow();
      expect(getFlags().size).toBe(0);
    });

    it('handles FEATURE_FLAGS_JSON with invalid entries', () => {
      process.env.FEATURE_FLAGS_JSON = JSON.stringify([
        { name: 'valid', percentage: 50 },
        { name: '', percentage: 100 }, // invalid empty name
        { percentage: 100 }, // missing name
        { name: 'invalid', percentage: 150 }, // invalid percentage
        { name: 'invalid2', percentage: -10 }, // invalid negative
      ]);

      reloadFlags();

      // Only valid entries should be present
      expect(getFlags().has('valid')).toBe(true);
      expect(getFlags().get('valid')?.percentage).toBe(50);

      // Invalid entries should be skipped
      expect(getFlags().has('')).toBe(false);
      expect(getFlags().has('invalid')).toBe(false);
      expect(getFlags().has('invalid2')).toBe(false);
    });

    it('handles FEATURE_FLAGS_JSON as object format', () => {
      process.env.FEATURE_FLAGS_JSON = JSON.stringify({
        flag1: { percentage: 25 },
        flag2: { percentage: 75, description: 'test flag' },
      });

      reloadFlags();

      expect(getFlags().has('flag1')).toBe(true);
      expect(getFlags().get('flag1')?.percentage).toBe(25);
      expect(getFlags().has('flag2')).toBe(true);
      expect(getFlags().get('flag2')?.percentage).toBe(75);
      expect(getFlags().get('flag2')?.description).toBe('test flag');
    });

    it('handles FEATURE_FLAGS_JSON as shorthand object', () => {
      process.env.FEATURE_FLAGS_JSON = JSON.stringify({
        flag1: 25,
        flag2: 75,
      });

      reloadFlags();

      expect(getFlags().has('flag1')).toBe(true);
      expect(getFlags().get('flag1')?.percentage).toBe(25);
      expect(getFlags().has('flag2')).toBe(true);
      expect(getFlags().get('flag2')?.percentage).toBe(75);
    });

    it('handles missing FEATURE_FLAGS_FILE gracefully', () => {
      process.env.FEATURE_FLAGS_FILE = '/nonexistent/file.json';
      process.env.FEATURE_FLAGS_JSON = '';

      expect(() => reloadFlags()).not.toThrow();
      expect(getFlags().size).toBe(0);
    });
  });
});

describe('reloadHotConfig - Observability', () => {
  it('logs warnings for restart-only key changes', () => {
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    captureStartupEnvSnapshot();
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    process.env.JWT_SECRET = 'changed-secret-that-is-long-enough-xxxxxxxxxxxxxxxx';

    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('JWT_SECRET');

    warnSpy.mockRestore();
  });

  it('does not log warnings when restart-only keys unchanged', () => {
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    captureStartupEnvSnapshot();
    process.env.RATE_LIMIT_IP_MAX = '50';

    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('DATABASE_URL');
    expect(output).not.toContain('REDIS_URL');
    expect(output).not.toContain('JWT_SECRET');
    expect(output).not.toContain('INDEXER_WORKER_TOKEN');

    warnSpy.mockRestore();
  });

  it('logs each changed restart-only key separately', () => {
    // Set initial values before snapshot
    process.env.DATABASE_URL = 'postgresql://original:5432/db';
    process.env.REDIS_URL = 'redis://original:6379';
    process.env.JWT_SECRET = 'original-secret-xxxxxxxxxxxx';
    process.env.INDEXER_WORKER_TOKEN = 'original-token-xxxxxxxxxxxx';

    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    captureStartupEnvSnapshot();

    // Change all restart-only keys
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    process.env.REDIS_URL = 'redis://changed:6379';
    process.env.JWT_SECRET = 'changed-secret-xxxxxxxxxxxx';
    process.env.INDEXER_WORKER_TOKEN = 'changed-token-xxxxxxxxxxxx';

    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('REDIS_URL');
    expect(output).toContain('JWT_SECRET');
    expect(output).toContain('INDEXER_WORKER_TOKEN');

    warnSpy.mockRestore();
  });
});

describe('reloadHotConfig - Concurrency', () => {
  it('returns consistent snapshots for concurrent calls', async () => {
    process.env.RATE_LIMIT_IP_MAX = '100';

    // Simulate concurrent reload calls
    const results = await Promise.all([
      Promise.resolve(reloadHotConfig()),
      Promise.resolve(reloadHotConfig()),
      Promise.resolve(reloadHotConfig()),
    ]);

    // All should have the same rate limit value
    for (const result of results) {
      expect(result.rateLimitIpMax).toBe(100);
    }

    // Should be frozen objects
    for (const result of results) {
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it('handles rapid sequential reloads without errors', () => {
    process.env.RATE_LIMIT_IP_MAX = '100';
    reloadHotConfig();

    process.env.RATE_LIMIT_IP_MAX = '200';
    reloadHotConfig();

    process.env.RATE_LIMIT_IP_MAX = '300';
    const hot = reloadHotConfig();

    expect(hot.rateLimitIpMax).toBe(300);
  });

  it('detects restart-only changes during concurrent calls', () => {
    // Set initial value before snapshot
    process.env.DATABASE_URL = 'postgresql://original:5432/db';
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    captureStartupEnvSnapshot();
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    process.env.RATE_LIMIT_IP_MAX = '100';

    // Multiple calls should all detect the change
    reloadHotConfig();
    reloadHotConfig();
    reloadHotConfig();

    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    // Should contain DATABASE_URL warnings
    expect(output).toContain('DATABASE_URL');

    warnSpy.mockRestore();
  });
});

describe('reloadHotConfig - Atomicity', () => {
  it('returns a frozen immutable object', () => {
    const hot = reloadHotConfig();
    expect(Object.isFrozen(hot)).toBe(true);

    // Attempting to modify should fail (throws in strict mode)
    const originalValue = hot.rateLimitIpMax;
    try {
      (hot as any).rateLimitIpMax = 999;
    } catch (e) {
      // Expected in strict mode
    }

    // Value should remain unchanged
    expect(hot.rateLimitIpMax).toBe(originalValue);
  });

  it('builds the entire config before returning (no partial state)', () => {
    process.env.RATE_LIMIT_IP_MAX = '100';
    process.env.RATE_LIMIT_IP_WINDOW_MS = '60000';
    process.env.LOG_LEVEL = 'debug';

    const hot = reloadHotConfig();

    // All values should be set correctly
    expect(hot.rateLimitIpMax).toBe(100);
    expect(hot.rateLimitIpWindowMs).toBe(60000);
    expect(hot.logLevel).toBe('debug');
  });

  it('handles partial updates correctly', () => {
    process.env.RATE_LIMIT_IP_MAX = '100';
    // Leave other rate limits undefined

    const hot = reloadHotConfig();

    expect(hot.rateLimitIpMax).toBe(100);
    expect(hot.rateLimitIpWindowMs).toBeUndefined();
    expect(hot.rateLimitApikeyMax).toBeUndefined();
    expect(hot.rateLimitAdminMax).toBeUndefined();
  });
});

describe('Integration: reloadHotConfig + runtime updates', () => {
  it('applies rate limit changes via setRuntimeRateLimitConfig', () => {
    process.env.RATE_LIMIT_IP_MAX = '150';
    process.env.RATE_LIMIT_IP_WINDOW_MS = '30000';

    const hot = reloadHotConfig();
    setRuntimeRateLimitConfig({
      ip: {
        windowMs: hot.rateLimitIpWindowMs ?? 60000,
        max: hot.rateLimitIpMax ?? 100,
        enabled: true,
      },
    });

    const runtime = getRuntimeRateLimitConfig();
    expect(runtime?.ip.max).toBe(150);
    expect(runtime?.ip.windowMs).toBe(30000);
  });

  it('handles undefined rate limits by falling back to defaults', () => {
    delete process.env.RATE_LIMIT_IP_MAX;
    delete process.env.RATE_LIMIT_IP_WINDOW_MS;

    const hot = reloadHotConfig();
    setRuntimeRateLimitConfig({
      ip: {
        windowMs: hot.rateLimitIpWindowMs ?? 60000,
        max: hot.rateLimitIpMax ?? 100,
        enabled: true,
      },
    });

    const runtime = getRuntimeRateLimitConfig();
    expect(runtime?.ip.max).toBe(100);
    expect(runtime?.ip.windowMs).toBe(60000);
  });

  it('reloads feature flags correctly', () => {
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'test_flag', percentage: 50 },
    ]);

    reloadFlags();
    expect(getFlags().has('test_flag')).toBe(true);
    expect(getFlags().get('test_flag')?.percentage).toBe(50);
  });

  it('clears feature flags when JSON is removed', () => {
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'test_flag', percentage: 50 },
    ]);

    reloadFlags();
    expect(getFlags().size).toBe(1);

    // Clear the JSON
    delete process.env.FEATURE_FLAGS_JSON;
    reloadFlags();
    expect(getFlags().size).toBe(0);
  });
});

describe('Security: Secret handling', () => {
  it('does not log restart-only key values in warnings', () => {
    const secretValue = 'super-secret-database-password-12345';
    process.env.DATABASE_URL = `postgresql://user:${secretValue}@localhost:5432/db`;
    captureStartupEnvSnapshot();

    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    reloadHotConfig();

    const output = warnSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');
    expect(output).not.toContain(secretValue);
    expect(output).not.toContain('postgresql://');

    warnSpy.mockRestore();
  });

  it('does not log JWT secret values in warnings', () => {
    const secretValue = 'supersecretjwtkey12345678901234567890';
    process.env.JWT_SECRET = secretValue;
    captureStartupEnvSnapshot();

    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.JWT_SECRET = 'changed-secret-xxxxxxxxxxxx';
    reloadHotConfig();

    const output = warnSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('JWT_SECRET');
    expect(output).not.toContain(secretValue);

    warnSpy.mockRestore();
  });
});

describe('SIGHUP Handler Error Scenarios', () => {
  it('handles partial config updates (some keys invalid)', () => {
    // Mix of valid and invalid rate limit values
    process.env.RATE_LIMIT_IP_MAX = '100'; // valid
    process.env.RATE_LIMIT_IP_WINDOW_MS = 'invalid'; // invalid
    process.env.RATE_LIMIT_APIKEY_MAX = '200'; // valid

    const hot = reloadHotConfig();

    // Valid values should be parsed
    expect(hot.rateLimitIpMax).toBe(100);
    expect(hot.rateLimitApikeyMax).toBe(200);

    // Invalid values should be undefined
    expect(hot.rateLimitIpWindowMs).toBeUndefined();
  });

  it('reloadHotConfig never throws for any input', () => {
    // Test with various invalid inputs
    const testCases = [
      { RATE_LIMIT_IP_MAX: 'invalid' },
      { TRACING_SAMPLE_RATE: '2.0' },
      { LOG_LEVEL: 'verbose' },
      { FEATURE_FLAGS_JSON: 'invalid-json' },
    ];

    for (const testCase of testCases) {
      for (const [key, value] of Object.entries(testCase)) {
        process.env[key] = value as string;
      }

      expect(() => reloadHotConfig()).not.toThrow();

      for (const key of Object.keys(testCase)) {
        delete process.env[key];
      }
    }
  });
});

describe('Config Refresh Path Edge Cases', () => {
  it('handles rapid successive config refreshes', () => {
    // Simulate rapid SIGHUP signals
    for (let i = 0; i < 10; i++) {
      process.env.RATE_LIMIT_IP_MAX = String(100 + i);
      const hot = reloadHotConfig();
      expect(hot.rateLimitIpMax).toBe(100 + i);
    }
  });

  it('handles config refresh with no changes', () => {
    process.env.RATE_LIMIT_IP_MAX = '100';
    const hot1 = reloadHotConfig();

    // Call again without changing env
    const hot2 = reloadHotConfig();

    // Should return consistent results
    expect(hot1.rateLimitIpMax).toBe(hot2.rateLimitIpMax);
    expect(Object.isFrozen(hot1)).toBe(true);
    expect(Object.isFrozen(hot2)).toBe(true);
  });

  it('handles config refresh with only restart-only key changes', () => {
    // Set initial values before snapshot
    process.env.DATABASE_URL = 'postgresql://original:5432/db';
    process.env.REDIS_URL = 'redis://original:6379';
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    captureStartupEnvSnapshot();

    // Change only restart-only keys
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';
    process.env.REDIS_URL = 'redis://changed:6379';

    const hot = reloadHotConfig();

    // Hot config should still be returned with defaults
    expect(hot.rateLimitIpMax).toBeUndefined();
    expect(hot.tracingSampleRate).toBe(1);

    // Should warn about restart-only changes
    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');

    warnSpy.mockRestore();
  });

  it('handles config refresh during active feature flag usage', () => {
    // Set initial flags
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'flag1', percentage: 50 },
    ]);
    reloadFlags();

    // Verify flags are active
    expect(getFlags().has('flag1')).toBe(true);

    // Update flags
    process.env.FEATURE_FLAGS_JSON = JSON.stringify([
      { name: 'flag1', percentage: 75 },
      { name: 'flag2', percentage: 25 },
    ]);
    reloadFlags();

    // Verify new flags are active
    expect(getFlags().get('flag1')?.percentage).toBe(75);
    expect(getFlags().has('flag2')).toBe(true);
  });

  it('handles config refresh with tracing config changes', () => {
    process.env.TRACING_SAMPLE_RATE = '0.5';
    process.env.TRACING_ENABLED = 'true';
    process.env.LOG_LEVEL = 'debug';

    const hot1 = reloadHotConfig();
    expect(hot1.tracingSampleRate).toBe(0.5);
    expect(hot1.tracingEnabled).toBe(true);
    expect(hot1.logLevel).toBe('debug');

    // Change tracing config
    process.env.TRACING_SAMPLE_RATE = '0.8';
    process.env.TRACING_ENABLED = 'false';
    process.env.LOG_LEVEL = 'warn';

    const hot2 = reloadHotConfig();
    expect(hot2.tracingSampleRate).toBe(0.8);
    expect(hot2.tracingEnabled).toBe(false);
    expect(hot2.logLevel).toBe('warn');
  });

  it('handles config refresh with rate limit config changes', () => {
    process.env.RATE_LIMIT_IP_MAX = '100';
    process.env.RATE_LIMIT_IP_WINDOW_MS = '60000';

    const hot1 = reloadHotConfig();
    setRuntimeRateLimitConfig({
      ip: {
        windowMs: hot1.rateLimitIpWindowMs ?? 60_000,
        max: hot1.rateLimitIpMax ?? 100,
        enabled: true,
      },
    });

    let runtime = getRuntimeRateLimitConfig();
    expect(runtime?.ip.max).toBe(100);
    expect(runtime?.ip.windowMs).toBe(60000);

    // Change rate limit config
    process.env.RATE_LIMIT_IP_MAX = '200';
    process.env.RATE_LIMIT_IP_WINDOW_MS = '30000';

    const hot2 = reloadHotConfig();
    setRuntimeRateLimitConfig({
      ip: {
        windowMs: hot2.rateLimitIpWindowMs ?? 60_000,
        max: hot2.rateLimitIpMax ?? 100,
        enabled: true,
      },
    });

    runtime = getRuntimeRateLimitConfig();
    expect(runtime?.ip.max).toBe(200);
    expect(runtime?.ip.windowMs).toBe(30000);
  });
});

describe('Regression Surface Tests', () => {
  // These tests document the current behavior and protect against regressions

  it('reloadHotConfig does not throw for any valid input', () => {
    // Test with various combinations of env vars
    const testCases = [
      {}, // empty
      { RATE_LIMIT_IP_MAX: '100' },
      { TRACING_ENABLED: 'true' },
      { LOG_LEVEL: 'debug' },
      { FEATURE_FLAGS_JSON: 'invalid' },
      { FEATURE_FLAGS_JSON: '{}' },
      {
        RATE_LIMIT_IP_MAX: 'invalid',
        TRACING_SAMPLE_RATE: '2.0',
        LOG_LEVEL: 'verbose',
      },
    ];

    for (const testCase of testCases) {
      // Set env vars
      for (const [key, value] of Object.entries(testCase)) {
        process.env[key] = value as string;
      }

      expect(() => reloadHotConfig()).not.toThrow();

      // Clean up
      for (const key of Object.keys(testCase)) {
        delete process.env[key];
      }
    }
  });

  it('preserves existing behavior for all env var combinations', () => {
    // This test ensures that changing one env var doesn't affect others
    process.env.RATE_LIMIT_IP_MAX = '100';
    process.env.TRACING_SAMPLE_RATE = '0.5';
    process.env.LOG_LEVEL = 'debug';

    const hot = reloadHotConfig();

    expect(hot.rateLimitIpMax).toBe(100);
    expect(hot.rateLimitIpWindowMs).toBeUndefined();
    expect(hot.tracingSampleRate).toBe(0.5);
    expect(hot.logLevel).toBe('debug');
    expect(hot.featureFlagsJson).toBeUndefined();
  });

  it('handles all restart-only keys correctly', () => {
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    captureStartupEnvSnapshot();

    const restartOnlyKeys = [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_SECRET',
      'INDEXER_WORKER_TOKEN',
    ];

    for (const key of restartOnlyKeys) {
      process.env[key] = `changed-${key}`;
    }

    reloadHotConfig();

    // Should warn for each changed key
    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    for (const key of restartOnlyKeys) {
      expect(output).toContain(key);
    }

    warnSpy.mockRestore();
  });

  it('maintains backward compatibility with existing tests', () => {
    // This test ensures we don't break existing test expectations
    process.env.RATE_LIMIT_IP_MAX = '50';
    const hot = reloadHotConfig();
    expect(hot.rateLimitIpMax).toBe(50);
    expect(Object.isFrozen(hot)).toBe(true);

    // Existing test expectations from env.reload.test.ts
    process.env.TRACING_SAMPLE_RATE = '0.5';
    expect(reloadHotConfig().tracingSampleRate).toBe(0.5);

    process.env.TRACING_ENABLED = 'true';
    expect(reloadHotConfig().tracingEnabled).toBe(true);

    process.env.LOG_LEVEL = 'debug';
    expect(reloadHotConfig().logLevel).toBe('debug');
  });

  it('handles edge case: startup snapshot captured implicitly on first reload', () => {
    const warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Reset snapshot to null
    resetStartupEnvSnapshot();

    // Set restart-only key
    process.env.DATABASE_URL = 'postgresql://initial:5432/db';

    // First reload should capture snapshot implicitly
    const hot1 = reloadHotConfig();
    expect(hot1).toBeDefined();

    // Change restart-only key
    process.env.DATABASE_URL = 'postgresql://changed:5432/db';

    // Second reload should detect the change
    const hot2 = reloadHotConfig();
    expect(hot2).toBeDefined();

    // Should have warned about the change
    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('DATABASE_URL');

    warnSpy.mockRestore();
  });

  it('handles edge case: all hot-reloadable keys set simultaneously', () => {
    process.env.RATE_LIMIT_IP_WINDOW_MS = '30000';
    process.env.RATE_LIMIT_IP_MAX = '200';
    process.env.RATE_LIMIT_APIKEY_WINDOW_MS = '45000';
    process.env.RATE_LIMIT_APIKEY_MAX = '300';
    process.env.RATE_LIMIT_ADMIN_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_ADMIN_MAX = '2500';
    process.env.TRACING_SAMPLE_RATE = '0.75';
    process.env.TRACING_ENABLED = 'true';
    process.env.LOG_LEVEL = 'warn';
    process.env.FEATURE_FLAGS_JSON = '[{"name":"test","percentage":50}]';

    const hot = reloadHotConfig();

    expect(hot.rateLimitIpWindowMs).toBe(30000);
    expect(hot.rateLimitIpMax).toBe(200);
    expect(hot.rateLimitApikeyWindowMs).toBe(45000);
    expect(hot.rateLimitApikeyMax).toBe(300);
    expect(hot.rateLimitAdminWindowMs).toBe(60000);
    expect(hot.rateLimitAdminMax).toBe(2500);
    expect(hot.tracingSampleRate).toBe(0.75);
    expect(hot.tracingEnabled).toBe(true);
    expect(hot.logLevel).toBe('warn');
    expect(hot.featureFlagsJson).toBe('[{"name":"test","percentage":50}]');
  });

  it('handles edge case: no hot-reloadable keys set (all defaults)', () => {
    // Clear all hot-reloadable keys
    for (const key of HOT_KEYS) {
      delete process.env[key];
    }

    const hot = reloadHotConfig();

    expect(hot.rateLimitIpWindowMs).toBeUndefined();
    expect(hot.rateLimitIpMax).toBeUndefined();
    expect(hot.rateLimitApikeyWindowMs).toBeUndefined();
    expect(hot.rateLimitApikeyMax).toBeUndefined();
    expect(hot.rateLimitAdminWindowMs).toBeUndefined();
    expect(hot.rateLimitAdminMax).toBeUndefined();
    expect(hot.tracingSampleRate).toBe(1);
    expect(hot.tracingEnabled).toBe(false);
    expect(hot.logLevel).toBe('info');
    expect(hot.featureFlagsJson).toBeUndefined();
    expect(hot.featureFlagsFile).toBeUndefined();
  });

  it('handles edge case: extremely large rate limit values', () => {
    process.env.RATE_LIMIT_IP_MAX = '999999999999999';
    process.env.RATE_LIMIT_IP_WINDOW_MS = '999999999999999';

    const hot = reloadHotConfig();

    // Should parse as numbers (may exceed safe integer range)
    expect(hot.rateLimitIpMax).toBe(999999999999999);
    expect(hot.rateLimitIpWindowMs).toBe(999999999999999);
  });
});