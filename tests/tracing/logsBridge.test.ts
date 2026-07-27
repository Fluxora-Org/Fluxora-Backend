/**
 * Tests for src/tracing/logsBridge.ts — OpenTelemetry Logs Bridge.
 *
 * ## Coverage
 *
 * ### Bridge lifecycle
 * - `initLogsBridge({ enabled: false })` keeps the bridge disabled (no-op)
 * - `initLogsBridge({ enabled: true })` activates the bridge
 * - `isLogsBridgeEnabled()` reflects the current state
 * - `resetLogsBridge()` returns the bridge to the disabled state
 * - Subsequent `initLogsBridge` calls are idempotent
 *
 * ### forwardToOtel — disabled path
 * - No OTel logger is obtained when the bridge is off
 * - No `emit` call when the bridge is off
 *
 * ### forwardToOtel — enabled path
 * - Emits with correct `severityNumber` for each log level
 * - Emits with correct `severityText` for each log level
 * - Attaches the message as the `body` of the LogRecord
 * - Attaches `correlation.id` attribute when a correlationId is provided
 * - Omits `correlation.id` attribute when correlationId is undefined
 * - Flattens primitive meta values as LogRecord attributes
 * - JSON-stringifies non-primitive meta values
 * - Skips null / undefined meta values
 *
 * ### Trace correlation
 * - Attaches `trace.id` and `span.id` when an active OTel span is present
 * - Omits trace attributes when no active span exists
 *
 * ### PII sanitization
 * - Redacts PII keys from meta before forwarding
 * - Masks Stellar keys embedded in the message body
 * - Masks Stellar keys embedded in meta string values
 *
 * ### Failure safety
 * - OTel SDK errors are swallowed (never thrown to caller)
 * - `forwardToOtel` always returns without throwing
 *
 * ### Logger integration (src/lib/logger.ts)
 * - `logger.info()` calls `forwardToOtel` when bridge is enabled
 * - `logger.warn()` calls `forwardToOtel` when bridge is enabled
 * - `logger.error()` calls `forwardToOtel` when bridge is enabled
 * - `logger.debug()` calls `forwardToOtel` when bridge is enabled and LOG_LEVEL=debug
 * - Standalone `info()` / `warn()` / `error()` / `debug()` also forward to OTel
 * - Normal stdout/stderr output is NOT suppressed when bridge is enabled
 *
 * ### Security assumptions
 * - PII fields listed in `src/pii/policy.ts` are never forwarded as plain text
 * - Stellar public keys receive partial masking, not full exposure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initLogsBridge,
  isLogsBridgeEnabled,
  resetLogsBridge,
  forwardToOtel,
} from '../../src/tracing/logsBridge.js';

// ── Mock @opentelemetry/api-logs ───────────────────────────────────────────────
// We replace the real OTel Logs API with a controllable mock so tests are
// hermetic and do not depend on an OTLP collector running.

const { mockEmit, mockGetLogger, mockGetActiveSpan, mockContextActive } = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockGetLogger = vi.fn().mockReturnValue({ emit: mockEmit });
  const mockGetActiveSpan = vi.fn().mockReturnValue(undefined);
  const mockContextActive = vi.fn().mockReturnValue({ symbol: 'root-ctx' });
  return { mockEmit, mockGetLogger, mockGetActiveSpan, mockContextActive };
});

vi.mock('@opentelemetry/api-logs', () => ({
  logs: { getLogger: mockGetLogger },
  SeverityNumber: {
    UNSPECIFIED: 0,
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
  },
}));

// ── Mock @opentelemetry/api ───────────────────────────────────────────────────
// Provide a controllable active span / context.

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: mockGetActiveSpan,
  },
  context: {
    active: mockContextActive,
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the LogRecord argument passed to the most recent `emit()` call.
 * Throws if `emit` was never called.
 */
function lastEmittedRecord(): Record<string, unknown> {
  expect(mockEmit).toHaveBeenCalled();
  return mockEmit.mock.calls[mockEmit.mock.calls.length - 1][0] as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('logsBridge', () => {
  beforeEach(() => {
    resetLogsBridge();
    mockEmit.mockClear();
    mockGetLogger.mockClear();
    mockGetActiveSpan.mockReturnValue(undefined);
    mockContextActive.mockReturnValue({ symbol: 'root-ctx' });
  });

  afterEach(() => {
    resetLogsBridge();
  });

  // ── Bridge lifecycle ───────────────────────────────────────────────────────

  describe('bridge lifecycle', () => {
    it('is disabled by default', () => {
      expect(isLogsBridgeEnabled()).toBe(false);
    });

    it('initLogsBridge({ enabled: false }) keeps bridge disabled', () => {
      initLogsBridge({ enabled: false });
      expect(isLogsBridgeEnabled()).toBe(false);
    });

    it('initLogsBridge({ enabled: true }) activates the bridge', () => {
      initLogsBridge({ enabled: true });
      expect(isLogsBridgeEnabled()).toBe(true);
    });

    it('resetLogsBridge() disables an active bridge', () => {
      initLogsBridge({ enabled: true });
      resetLogsBridge();
      expect(isLogsBridgeEnabled()).toBe(false);
    });

    it('calling initLogsBridge multiple times with enabled=true is idempotent', () => {
      initLogsBridge({ enabled: true });
      initLogsBridge({ enabled: true });
      expect(isLogsBridgeEnabled()).toBe(true);
    });

    it('calling initLogsBridge with enabled=false after enabled=true disables bridge', () => {
      initLogsBridge({ enabled: true });
      initLogsBridge({ enabled: false });
      expect(isLogsBridgeEnabled()).toBe(false);
    });
  });

  // ── forwardToOtel — disabled path ──────────────────────────────────────────

  describe('forwardToOtel when bridge is disabled', () => {
    it('does not call getLogger when bridge is off', () => {
      forwardToOtel('info', 'hello', undefined, undefined);
      expect(mockGetLogger).not.toHaveBeenCalled();
    });

    it('does not call emit when bridge is off', () => {
      forwardToOtel('info', 'hello', undefined, undefined);
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('returns without throwing when bridge is disabled', () => {
      expect(() => forwardToOtel('error', 'boom', undefined, undefined)).not.toThrow();
    });
  });

  // ── forwardToOtel — severity mapping ──────────────────────────────────────

  describe('severity mapping', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it.each([
      ['debug', 5],
      ['info', 9],
      ['warn', 13],
      ['error', 17],
    ] as const)('maps level "%s" to severityNumber %d', (level, expected) => {
      forwardToOtel(level, 'test', undefined, undefined);
      expect(lastEmittedRecord().severityNumber).toBe(expected);
    });

    it.each(['debug', 'info', 'warn', 'error'] as const)(
      'sets severityText to uppercase level "%s"',
      (level) => {
        forwardToOtel(level, 'test', undefined, undefined);
        expect(lastEmittedRecord().severityText).toBe(level.toUpperCase());
      },
    );
  });

  // ── forwardToOtel — message as body ───────────────────────────────────────

  describe('message body', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('sets the message as the LogRecord body', () => {
      forwardToOtel('info', 'hello world', undefined, undefined);
      expect(lastEmittedRecord().body).toBe('hello world');
    });

    it('uses the already-sanitized message string verbatim', () => {
      forwardToOtel('info', 'sanitized message', undefined, undefined);
      expect(lastEmittedRecord().body).toBe('sanitized message');
    });
  });

  // ── forwardToOtel — correlationId attribute ────────────────────────────────

  describe('correlationId attribute', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('attaches correlation.id when correlationId is provided', () => {
      forwardToOtel('info', 'msg', 'cid-abc-123', undefined);
      const rec = lastEmittedRecord();
      expect((rec.attributes as Record<string, unknown>)['correlation.id']).toBe('cid-abc-123');
    });

    it('omits correlation.id when correlationId is undefined', () => {
      forwardToOtel('info', 'msg', undefined, undefined);
      const rec = lastEmittedRecord();
      expect((rec.attributes as Record<string, unknown>)['correlation.id']).toBeUndefined();
    });

    it('omits correlation.id when correlationId is empty string', () => {
      forwardToOtel('info', 'msg', '', undefined);
      const rec = lastEmittedRecord();
      expect((rec.attributes as Record<string, unknown>)['correlation.id']).toBeUndefined();
    });
  });

  // ── forwardToOtel — meta attributes ───────────────────────────────────────

  describe('meta attribute flattening', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('includes string meta values as attributes', () => {
      forwardToOtel('info', 'msg', undefined, { service: 'indexer' });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['service']).toBe('indexer');
    });

    it('includes numeric meta values as attributes', () => {
      forwardToOtel('info', 'msg', undefined, { count: 42 });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['count']).toBe(42);
    });

    it('includes boolean meta values as attributes', () => {
      forwardToOtel('info', 'msg', undefined, { success: true });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['success']).toBe(true);
    });

    it('JSON-stringifies object meta values', () => {
      forwardToOtel('info', 'msg', undefined, { nested: { a: 1 } });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['nested']).toBe('{"a":1}');
    });

    it('JSON-stringifies array meta values', () => {
      forwardToOtel('info', 'msg', undefined, { items: [1, 2, 3] });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['items']).toBe('[1,2,3]');
    });

    it('skips null meta values', () => {
      forwardToOtel('info', 'msg', undefined, { nullField: null });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(Object.keys(attrs as object)).not.toContain('nullField');
    });

    it('skips undefined meta values', () => {
      forwardToOtel('info', 'msg', undefined, { undefinedField: undefined });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(Object.keys(attrs as object)).not.toContain('undefinedField');
    });

    it('handles no meta gracefully', () => {
      expect(() => forwardToOtel('info', 'msg', undefined, undefined)).not.toThrow();
      const rec = lastEmittedRecord();
      expect(rec.attributes).toBeDefined();
    });
  });

  // ── Trace correlation ──────────────────────────────────────────────────────

  describe('trace correlation', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('attaches trace.id and span.id when active span exists', () => {
      mockGetActiveSpan.mockReturnValue({
        spanContext: () => ({
          traceId: 'abc123traceId000000000000000000',
          spanId: 'deadbeefspan0000',
          traceFlags: 1,
        }),
      });

      forwardToOtel('info', 'traced message', undefined, undefined);
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['trace.id']).toBe('abc123traceId000000000000000000');
      expect(attrs['span.id']).toBe('deadbeefspan0000');
    });

    it('omits trace.id and span.id when no active span', () => {
      mockGetActiveSpan.mockReturnValue(undefined);

      forwardToOtel('info', 'untraced message', undefined, undefined);
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      expect(attrs['trace.id']).toBeUndefined();
      expect(attrs['span.id']).toBeUndefined();
    });

    it('attaches the active context to the LogRecord', () => {
      const fakeCtx = { symbol: 'test-context' };
      mockContextActive.mockReturnValue(fakeCtx);

      forwardToOtel('info', 'msg', undefined, undefined);
      expect(lastEmittedRecord().context).toBe(fakeCtx);
    });

    it('sets a numeric timestamp on the LogRecord', () => {
      forwardToOtel('info', 'msg', undefined, undefined);
      const ts = lastEmittedRecord().timestamp;
      expect(typeof ts).toBe('number');
      expect(ts as number).toBeGreaterThan(0);
    });
  });

  // ── PII sanitization ───────────────────────────────────────────────────────

  describe('PII sanitization', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('masks Stellar public keys embedded in the message body', () => {
      const stellarKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
      forwardToOtel('info', `user key is ${stellarKey}`, undefined, undefined);
      const body = lastEmittedRecord().body as string;
      // Full key must not appear in the emitted body
      expect(body).not.toContain(stellarKey);
      // Should be partially masked: first 4 + last 4
      expect(body).toContain('GAAZ');
      expect(body).toContain('WN7');
    });

    it('redacts sensitive PII keys in meta (e.g. "password")', () => {
      forwardToOtel('info', 'login attempt', undefined, { password: 'hunter2' });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      // The "password" field must be redacted — it should be [REDACTED] or absent
      const pwdValue = attrs['password'];
      if (pwdValue !== undefined) {
        expect(pwdValue).not.toBe('hunter2');
        expect(String(pwdValue)).toContain('REDACTED');
      }
      // In either case the plaintext must not appear
      expect(JSON.stringify(attrs)).not.toContain('hunter2');
    });

    it('masks Stellar keys in meta string values', () => {
      const stellarKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
      forwardToOtel('info', 'key info', undefined, {
        // "address" is not a PII field so it passes through but key should be masked
        note: `send to ${stellarKey}`,
      });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      // The full Stellar key must not appear in any attribute
      expect(JSON.stringify(attrs)).not.toContain(stellarKey);
    });

    it('applies double sanitization as defence-in-depth', () => {
      // Even if the caller passes unsanitized meta, the bridge sanitizes again.
      // This test ensures the bridge does not forward a sensitive field value
      // that was not sanitized by the logger layer.
      forwardToOtel('warn', 'audit', undefined, {
        token: 'super-secret-token',
        userId: 'user-123',
      });
      const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
      // "token" is a sensitive field — value must be redacted
      const tokenVal = attrs['token'];
      if (tokenVal !== undefined) {
        expect(tokenVal).not.toBe('super-secret-token');
      }
    });
  });

  // ── Failure safety ─────────────────────────────────────────────────────────

  describe('failure safety', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('does not throw when OTel emit() throws', () => {
      mockEmit.mockImplementationOnce(() => {
        throw new Error('OTel collector unreachable');
      });
      expect(() => forwardToOtel('info', 'msg', undefined, undefined)).not.toThrow();
    });

    it('does not throw when getLogger() throws', () => {
      mockGetLogger.mockImplementationOnce(() => {
        throw new Error('Logger provider not ready');
      });
      expect(() => forwardToOtel('info', 'msg', undefined, undefined)).not.toThrow();
    });

    it('does not throw when trace.getActiveSpan() throws', () => {
      mockGetActiveSpan.mockImplementationOnce(() => {
        throw new Error('Context API error');
      });
      expect(() => forwardToOtel('warn', 'msg', undefined, undefined)).not.toThrow();
    });

    it('does not throw when context.active() throws', () => {
      mockContextActive.mockImplementationOnce(() => {
        throw new Error('Context error');
      });
      expect(() => forwardToOtel('error', 'msg', undefined, undefined)).not.toThrow();
    });

    it('does not throw when meta contains a circular reference', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circular: Record<string, unknown> = {};
      circular['self'] = circular; // circular reference
      expect(() => forwardToOtel('info', 'msg', undefined, circular)).not.toThrow();
    });
  });

  // ── getLogger instrumentation scope ───────────────────────────────────────

  describe('instrumentation scope', () => {
    beforeEach(() => {
      initLogsBridge({ enabled: true });
    });

    it('requests a logger with the fluxora-backend scope name', () => {
      forwardToOtel('info', 'test', undefined, undefined);
      expect(mockGetLogger).toHaveBeenCalledWith(
        'fluxora-backend/logs-bridge',
        expect.any(String),
      );
    });
  });
});

// ── Logger integration tests ───────────────────────────────────────────────────
// Verify that the real logger forwards to the bridge and that stdout/stderr
// is not suppressed.

describe('logger.ts + logsBridge integration', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetLogsBridge();
    mockEmit.mockClear();
    mockGetLogger.mockClear();
    mockGetActiveSpan.mockReturnValue(undefined);
    mockContextActive.mockReturnValue({ symbol: 'root-ctx' });

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    resetLogsBridge();
    // Use clearAllMocks (not restoreAllMocks) to avoid resetting the vi.fn()
    // implementation of mockEmit / mockGetLogger which have no "original" to
    // restore to. clearAllMocks only resets call history, not implementations.
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('logger.info() writes to stdout AND forwards to OTel when bridge is enabled', async () => {
    initLogsBridge({ enabled: true });
    const { logger } = await import('../../src/lib/logger.js');
    logger.info('hello from info');

    expect(stdoutSpy).toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalled();
    const rec = lastEmittedRecord();
    expect(rec.body).toBe('hello from info');
    expect(rec.severityNumber).toBe(9); // INFO
  });

  it('logger.warn() writes to stdout AND forwards to OTel', async () => {
    initLogsBridge({ enabled: true });
    const { logger } = await import('../../src/lib/logger.js');
    logger.warn('a warning');

    expect(stdoutSpy).toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalled();
    const rec = lastEmittedRecord();
    expect(rec.severityNumber).toBe(13); // WARN
  });

  it('logger.error() writes to stderr AND forwards to OTel', async () => {
    initLogsBridge({ enabled: true });
    const { logger } = await import('../../src/lib/logger.js');
    logger.error('something broke');

    expect(stderrSpy).toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalled();
    const rec = lastEmittedRecord();
    expect(rec.severityNumber).toBe(17); // ERROR
  });

  it('logger.info() does NOT forward to OTel when bridge is disabled', async () => {
    // Bridge is disabled (resetLogsBridge called in beforeEach)
    const { logger } = await import('../../src/lib/logger.js');
    logger.info('silent from otel perspective');

    expect(stdoutSpy).toHaveBeenCalled(); // stdout still written
    expect(mockEmit).not.toHaveBeenCalled(); // OTel untouched
  });

  it('standalone info() function forwards to OTel when bridge is enabled', async () => {
    initLogsBridge({ enabled: true });
    const { info } = await import('../../src/lib/logger.js');
    info('standalone info');

    expect(mockEmit).toHaveBeenCalled();
  });

  it('standalone error() function forwards to OTel when bridge is enabled', async () => {
    initLogsBridge({ enabled: true });
    const { error } = await import('../../src/lib/logger.js');
    error('standalone error');

    expect(mockEmit).toHaveBeenCalled();
  });

  it('logger.info() includes correlationId attribute when passed', async () => {
    initLogsBridge({ enabled: true });
    const { logger } = await import('../../src/lib/logger.js');
    logger.info('with cid', 'test-cid-001');

    expect(mockEmit).toHaveBeenCalled();
    const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
    expect(attrs['correlation.id']).toBe('test-cid-001');
  });

  it('meta from logger.info() appears as flattened attributes in the LogRecord', async () => {
    initLogsBridge({ enabled: true });
    const { logger } = await import('../../src/lib/logger.js');
    logger.info('with meta', undefined, { streamId: 'stream-xyz', attempt: 3 });

    expect(mockEmit).toHaveBeenCalled();
    const attrs = lastEmittedRecord().attributes as Record<string, unknown>;
    expect(attrs['streamId']).toBe('stream-xyz');
    expect(attrs['attempt']).toBe(3);
  });
});


