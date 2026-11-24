import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// delivery-support.ts pulls in config, logging and the delivery store at import
// time. Mock those so the helpers are exercised in isolation.
const configMock = vi.hoisted(() => ({
  current: {
    nodeEnv: 'test',
    webhookCircuitBreakerThreshold: 0 as unknown,
    webhookCircuitBreakerResetMs: 300_000 as unknown,
  },
}));

vi.mock('../config/env.js', () => ({ loadConfig: () => configMock.current }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./storeFactory.js', () => ({
  webhookDeliveryStore: {
    getDeadLetterQueueItems: vi.fn(() => []),
    addToDeadLetterQueue: vi.fn(() => 'dlq-1'),
  },
}));

import {
  assertSafeWebhookEndpoint,
  extractAttemptNumber,
  normalizePayload,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRetryAfter,
  resolveWebhookRetryPolicy,
  validateWebhookUrl,
} from './delivery-support.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');

function setConfig(overrides: Partial<typeof configMock.current>): void {
  configMock.current = {
    nodeEnv: 'test',
    webhookCircuitBreakerThreshold: 0,
    webhookCircuitBreakerResetMs: 300_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setConfig({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseRetryAfter', () => {
  const now = () => Date.now();

  it('returns null for a missing or empty header', () => {
    expect(parseRetryAfter(null, now())).toBeNull();
    expect(parseRetryAfter('', now())).toBeNull();
  });

  it('converts a delay in seconds to milliseconds', () => {
    expect(parseRetryAfter('120', now())).toBe(120_000);
    expect(parseRetryAfter('1', now())).toBe(1_000);
  });

  it('accepts zero and surrounding whitespace', () => {
    expect(parseRetryAfter('0', now())).toBe(0);
    expect(parseRetryAfter('  30  ', now())).toBe(30_000);
  });

  it('clamps a negative delay to zero', () => {
    expect(parseRetryAfter('-5', now())).toBe(0);
    expect(parseRetryAfter('-1', now())).toBe(0);
  });

  it('returns null for non-numeric, non-date garbage', () => {
    expect(parseRetryAfter('abc', now())).toBeNull();
    expect(parseRetryAfter('NaN', now())).toBeNull();
    expect(parseRetryAfter('not a date', now())).toBeNull();
  });

  it('computes the delay to a future HTTP-date relative to now', () => {
    expect(parseRetryAfter('Tue, 24 Nov 2026 12:01:00 GMT', now())).toBe(60_000);
    expect(parseRetryAfter('Tue, 24 Nov 2026 13:00:00 GMT', now())).toBe(3_600_000);
  });

  it('clamps an HTTP-date in the past (or exactly now) to zero', () => {
    expect(parseRetryAfter('Tue, 24 Nov 2026 11:00:00 GMT', now())).toBe(0);
    expect(parseRetryAfter('Tue, 24 Nov 2026 12:00:00 GMT', now())).toBe(0);
  });

  it('measures the HTTP-date against the supplied now, not the wall clock', () => {
    const later = NOW.getTime() + 30_000;
    expect(parseRetryAfter('Tue, 24 Nov 2026 12:01:00 GMT', later)).toBe(30_000);
  });

  it('follows the frozen clock when it advances', () => {
    const header = 'Tue, 24 Nov 2026 12:01:00 GMT';
    expect(parseRetryAfter(header, now())).toBe(60_000);
    vi.advanceTimersByTime(45_000);
    expect(parseRetryAfter(header, now())).toBe(15_000);
  });
});

describe('parsePositiveInteger', () => {
  it('parses positive integers', () => {
    expect(parsePositiveInteger('5', 9)).toBe(5);
  });

  it('falls back for undefined, empty, zero, negative and non-numeric input', () => {
    expect(parsePositiveInteger(undefined, 9)).toBe(9);
    expect(parsePositiveInteger('', 9)).toBe(9);
    expect(parsePositiveInteger('0', 9)).toBe(9);
    expect(parsePositiveInteger('-3', 9)).toBe(9);
    expect(parsePositiveInteger('abc', 9)).toBe(9);
  });
});

describe('parseNonNegativeInteger', () => {
  it('parses zero and positive integers', () => {
    expect(parseNonNegativeInteger('0', 9)).toBe(0);
    expect(parseNonNegativeInteger('7', 9)).toBe(7);
  });

  it('falls back for undefined, empty, negative and non-numeric input', () => {
    expect(parseNonNegativeInteger(undefined, 9)).toBe(9);
    expect(parseNonNegativeInteger('', 9)).toBe(9);
    expect(parseNonNegativeInteger('-1', 9)).toBe(9);
    expect(parseNonNegativeInteger('abc', 9)).toBe(9);
  });
});

describe('resolveWebhookRetryPolicy', () => {
  it('returns the default policy when the circuit breaker is disabled', () => {
    const policy = resolveWebhookRetryPolicy();
    expect(policy).toEqual(DEFAULT_RETRY_POLICY);
    expect(policy).not.toHaveProperty('circuitBreakerThreshold');
  });

  it('enables the circuit breaker from config', () => {
    setConfig({ webhookCircuitBreakerThreshold: 5, webhookCircuitBreakerResetMs: 1_000 });
    expect(resolveWebhookRetryPolicy()).toEqual({
      ...DEFAULT_RETRY_POLICY,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 1_000,
    });
  });

  it('falls back to a 5 minute reset window when the reset value is invalid', () => {
    for (const bad of [0, -1, 'abc', undefined]) {
      setConfig({ webhookCircuitBreakerThreshold: 3, webhookCircuitBreakerResetMs: bad });
      expect(resolveWebhookRetryPolicy().circuitBreakerResetMs).toBe(300_000);
    }
  });

  it('ignores a zero, negative or non-numeric threshold', () => {
    for (const bad of [0, -2, 'abc', undefined]) {
      setConfig({ webhookCircuitBreakerThreshold: bad });
      expect(resolveWebhookRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    }
  });

  it('lets an explicit override win over config and defaults', () => {
    setConfig({ webhookCircuitBreakerThreshold: 5, webhookCircuitBreakerResetMs: 1_000 });
    const policy = resolveWebhookRetryPolicy({
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 2,
      circuitBreakerThreshold: 9,
    });
    expect(policy.maxAttempts).toBe(2);
    expect(policy.circuitBreakerThreshold).toBe(9);
    expect(policy.circuitBreakerResetMs).toBe(1_000);
  });

  it('does not mutate the shared default policy', () => {
    const before = structuredClone(DEFAULT_RETRY_POLICY);
    setConfig({ webhookCircuitBreakerThreshold: 5 });
    resolveWebhookRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxAttempts: 1 });
    expect(DEFAULT_RETRY_POLICY).toEqual(before);
  });
});

// Private-IP / DNS-based SSRF protection lives in ssrfGuard.ts and is covered by
// ssrfGuard.test.ts. assertSafeWebhookEndpoint only enforces scheme, credentials
// and the production https requirement, so that is what is asserted here.
describe('assertSafeWebhookEndpoint', () => {
  it('accepts https endpoints', () => {
    expect(() => assertSafeWebhookEndpoint('https://hooks.example.com/path')).not.toThrow();
  });

  it('accepts plain http outside production', () => {
    setConfig({ nodeEnv: 'development' });
    expect(() => assertSafeWebhookEndpoint('http://hooks.example.com')).not.toThrow();
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafeWebhookEndpoint('https://user:pass@hooks.example.com')).toThrow(
      'Webhook endpoint must not include credentials',
    );
    expect(() => assertSafeWebhookEndpoint('https://user@hooks.example.com')).toThrow(
      'Webhook endpoint must not include credentials',
    );
  });

  it.each(['ftp://hooks.example.com', 'file:///etc/passwd', 'javascript:alert(1)'])(
    'rejects the non-http(s) scheme %s',
    (endpoint) => {
      expect(() => assertSafeWebhookEndpoint(endpoint)).toThrow(
        'Webhook endpoint must use http or https',
      );
    },
  );

  it('throws on an unparseable URL', () => {
    expect(() => assertSafeWebhookEndpoint('not a url')).toThrow();
  });

  describe('in production', () => {
    beforeEach(() => setConfig({ nodeEnv: 'production' }));

    it('requires https for non-loopback hosts', () => {
      expect(() => assertSafeWebhookEndpoint('http://hooks.example.com')).toThrow(
        'Webhook endpoint must use https in production',
      );
      expect(() => assertSafeWebhookEndpoint('http://203.0.113.10')).toThrow(
        'Webhook endpoint must use https in production',
      );
    });

    it('still accepts https', () => {
      expect(() => assertSafeWebhookEndpoint('https://hooks.example.com')).not.toThrow();
    });

    it('allows plain http to localhost and 127.0.0.1', () => {
      expect(() => assertSafeWebhookEndpoint('http://localhost:3000/hook')).not.toThrow();
      expect(() => assertSafeWebhookEndpoint('http://127.0.0.1:3000/hook')).not.toThrow();
    });
  });
});

describe('validateWebhookUrl', () => {
  it('accepts http and https URLs', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com')).not.toThrow();
    expect(() => validateWebhookUrl('http://hooks.example.com')).not.toThrow();
  });

  it('throws a descriptive string for unparseable URLs', () => {
    expect(() => validateWebhookUrl('nope')).toThrow(/unparseable/);
  });

  it('throws for unsupported protocols and embedded credentials', () => {
    expect(() => validateWebhookUrl('ftp://hooks.example.com')).toThrow(/http or https/);
    expect(() => validateWebhookUrl('https://u:p@hooks.example.com')).toThrow(/credentials/);
  });
});

describe('extractAttemptNumber', () => {
  it('defaults to 1 for non-objects and missing metadata', () => {
    expect(extractAttemptNumber(null)).toBe(1);
    expect(extractAttemptNumber('x')).toBe(1);
    expect(extractAttemptNumber({})).toBe(1);
    expect(extractAttemptNumber({ _webhookRetry: null })).toBe(1);
  });

  it('reads a valid attempt number and floors fractions', () => {
    expect(extractAttemptNumber({ _webhookRetry: { attemptNumber: 3 } })).toBe(3);
    expect(extractAttemptNumber({ _webhookRetry: { attemptNumber: 2.9 } })).toBe(2);
  });

  it('defaults to 1 for zero, negative, NaN, infinite or non-numeric values', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      expect(extractAttemptNumber({ _webhookRetry: { attemptNumber: bad } })).toBe(1);
    }
  });
});

describe('normalizePayload', () => {
  it('parses JSON strings and passes everything else through', () => {
    expect(normalizePayload('{"a":1}')).toEqual({ a: 1 });
    expect(normalizePayload('plain text')).toBe('plain text');
    const obj = { a: 1 };
    expect(normalizePayload(obj)).toBe(obj);
    expect(normalizePayload(null)).toBeNull();
  });
});
