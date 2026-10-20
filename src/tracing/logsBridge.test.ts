/**
 * Tests for `src/tracing/logsBridge.ts` input hardening (issue #1765).
 *
 * Contract under test:
 * - malformed, empty and oversized inputs raise a typed
 *   `LogsBridgeValidationError` that tells the caller which field failed and
 *   why;
 * - rejection happens before any sanitisation, logger lookup or emit (no
 *   state write);
 * - valid input is forwarded unchanged;
 * - the disabled bridge remains a side-effect-free no-op.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  forwardToOtel,
  initLogsBridge,
  isLogsBridgeEnabled,
  resetLogsBridge,
  LogsBridgeValidationError,
  LOGS_BRIDGE_MAX_MESSAGE_BYTES,
  LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES,
  LOGS_BRIDGE_MAX_META_BYTES,
} from './logsBridge.js';

interface EmittedLogRecord {
  timestamp?: number;
  severityNumber?: SeverityNumber;
  severityText?: string;
  body?: unknown;
  attributes?: Record<string, unknown>;
}

// The bridge only touches `logs.getLogger(scope).emit(record)`. Intercept that
// call so tests can prove both the emitted payload and the absence of writes.
const bridgeState = vi.hoisted(() => ({
  emitted: [] as unknown[],
  getLoggerCalls: 0,
  emitCalls: 0,
}));

vi.mock('@opentelemetry/api-logs', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api-logs')>('@opentelemetry/api-logs');
  return {
    ...actual,
    logs: {
      getLogger: () => {
        bridgeState.getLoggerCalls += 1;
        return {
          emit: (record: unknown) => {
            bridgeState.emitCalls += 1;
            bridgeState.emitted.push(record);
          },
        };
      },
    } as unknown as typeof actual.logs,
  };
});

function enableBridge(): void {
  initLogsBridge({ enabled: true });
}

function emittedRecords(): EmittedLogRecord[] {
  return bridgeState.emitted as EmittedLogRecord[];
}

function expectNoWrites(): void {
  expect(bridgeState.getLoggerCalls).toBe(0);
  expect(bridgeState.emitCalls).toBe(0);
  expect(bridgeState.emitted).toHaveLength(0);
}

function captureValidationError(fn: () => void): LogsBridgeValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LogsBridgeValidationError);
    return error as LogsBridgeValidationError;
  }
  throw new Error('expected the call to throw LogsBridgeValidationError');
}

function metaAtByteLimit(): Record<string, string> {
  const overhead = Buffer.byteLength(JSON.stringify({ key: '' }), 'utf8');
  return { key: 'x'.repeat(LOGS_BRIDGE_MAX_META_BYTES - overhead) };
}

describe('logsBridge input validation (issue #1765)', () => {
  beforeEach(() => {
    bridgeState.emitted.length = 0;
    bridgeState.getLoggerCalls = 0;
    bridgeState.emitCalls = 0;
    resetLogsBridge();
  });

  afterEach(() => {
    resetLogsBridge();
  });

  describe('valid input', () => {
    it('forwards a valid entry unchanged', () => {
      enableBridge();

      forwardToOtel('warn', 'stream stalled', 'corr-42', {
        streamId: 'stream-1',
        attempt: 2,
        retrying: true,
        absent: undefined,
        nothing: null,
        context: { shard: 3 },
      });

      expect(bridgeState.getLoggerCalls).toBe(1);
      expect(bridgeState.emitCalls).toBe(1);
      expect(emittedRecords()).toHaveLength(1);

      const record = emittedRecords()[0];
      expect(record.severityNumber).toBe(SeverityNumber.WARN);
      expect(record.severityText).toBe('WARN');
      expect(record.body).toBe('stream stalled');
      expect(record.attributes).toEqual({
        'correlation.id': 'corr-42',
        streamId: 'stream-1',
        attempt: 2,
        retrying: true,
        context: '{"shard":3}',
      });
    });

    it('accepts values exactly at the documented limits', () => {
      enableBridge();

      forwardToOtel(
        'info',
        'm'.repeat(LOGS_BRIDGE_MAX_MESSAGE_BYTES),
        'c'.repeat(LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES),
        metaAtByteLimit(),
      );

      expect(emittedRecords()).toHaveLength(1);
      expect(
        Buffer.byteLength(String(emittedRecords()[0].body), 'utf8'),
      ).toBe(LOGS_BRIDGE_MAX_MESSAGE_BYTES);
    });

    it('accepts omitted (undefined/null) optional fields', () => {
      enableBridge();

      forwardToOtel('debug', 'no extras', undefined, undefined);
      forwardToOtel(
        'debug',
        'null extras',
        null as unknown as undefined,
        null as unknown as undefined,
      );

      expect(emittedRecords()).toHaveLength(2);
      expect(emittedRecords()[0].attributes).toEqual({});
      expect(emittedRecords()[1].attributes).toEqual({});
    });

    it('keeps forwarding after a rejected entry', () => {
      enableBridge();

      expect(() => forwardToOtel('info', '', undefined, undefined)).toThrow(
        LogsBridgeValidationError,
      );
      expectNoWrites();

      forwardToOtel('info', 'still works', 'corr-valid', { ok: true });

      expect(emittedRecords()).toHaveLength(1);
      expect(emittedRecords()[0].body).toBe('still works');
    });

    it('is a side-effect-free no-op while disabled', () => {
      forwardToOtel('info', 'valid but disabled', 'corr-off', { ok: true });

      expect(isLogsBridgeEnabled()).toBe(false);
      expectNoWrites();
    });
  });

  describe('malformed input', () => {
    it('rejects an unsupported level with a typed error', () => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('trace' as never, 'message', undefined, undefined),
      );

      expect(error.code).toBe('LOGS_BRIDGE_INVALID_INPUT');
      expect(error.field).toBe('level');
      expect(error.reason).toBe('invalid_level');
      expect(error.message).toContain('trace');
      expectNoWrites();
    });

    it('rejects a non-string message with a typed error', () => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('info', 42 as unknown as string, undefined, undefined),
      );

      expect(error.field).toBe('message');
      expect(error.reason).toBe('invalid_type');
      expect(error.message).toContain('number');
      expectNoWrites();
    });

    it.each([
      ['number', 123],
      ['object', { id: 'corr' }],
    ])('rejects a %s correlation ID with a typed error', (_label, correlationId) => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('info', 'message', correlationId as never, undefined),
      );

      expect(error.field).toBe('correlationId');
      expect(error.reason).toBe('invalid_type');
      expectNoWrites();
    });

    it.each([
      ['an array', [] as unknown],
      ['a string', 'not-an-object' as unknown],
      ['a class instance', new Date(0) as unknown],
    ])('rejects metadata that is %s with a typed error', (_label, meta) => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('info', 'message', undefined, meta as Record<string, unknown>),
      );

      expect(error.field).toBe('meta');
      expect(error.reason).toBe('invalid_type');
      expectNoWrites();
    });

    it('rejects circular metadata with a typed error before sanitisation', () => {
      enableBridge();
      const meta: Record<string, unknown> = {};
      meta.self = meta;

      const error = captureValidationError(() =>
        forwardToOtel('info', 'message', undefined, meta),
      );

      expect(error.field).toBe('meta');
      expect(error.reason).toBe('unserializable');
      expectNoWrites();
    });

    it('rejects malformed init input without changing the enabled state', () => {
      enableBridge();

      const nonBoolean = captureValidationError(() =>
        initLogsBridge({ enabled: 'true' } as unknown as { enabled: boolean }),
      );
      expect(nonBoolean.field).toBe('enabled');
      expect(nonBoolean.reason).toBe('invalid_type');
      expect(isLogsBridgeEnabled()).toBe(true);

      const nonObject = captureValidationError(() =>
        initLogsBridge(null as unknown as { enabled: boolean }),
      );
      expect(nonObject.field).toBe('enabled');
      expect(nonObject.reason).toBe('invalid_type');
      expect(isLogsBridgeEnabled()).toBe(true);
    });
  });

  describe('empty input', () => {
    it.each([
      ['the empty string', ''],
      ['whitespace only', '   \n\t '],
    ])('rejects %s as a message', (_label, message) => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('info', message, undefined, undefined),
      );

      expect(error.field).toBe('message');
      expect(error.reason).toBe('empty');
      expect(error.message).toContain('non-empty');
      expectNoWrites();
    });

    it('rejects an empty correlation ID', () => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('info', 'message', '', undefined),
      );

      expect(error.field).toBe('correlationId');
      expect(error.reason).toBe('empty');
      expectNoWrites();
    });
  });

  describe('oversized input', () => {
    it('rejects a message one byte over the limit', () => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel(
          'info',
          'x'.repeat(LOGS_BRIDGE_MAX_MESSAGE_BYTES + 1),
          undefined,
          undefined,
        ),
      );

      expect(error.field).toBe('message');
      expect(error.reason).toBe('oversized');
      expect(error.message).toContain(String(LOGS_BRIDGE_MAX_MESSAGE_BYTES));
      expect(error.message).toContain(String(LOGS_BRIDGE_MAX_MESSAGE_BYTES + 1));
      expectNoWrites();
    });

    it('rejects an oversized correlation ID', () => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel(
          'info',
          'message',
          'c'.repeat(LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES + 1),
          undefined,
        ),
      );

      expect(error.field).toBe('correlationId');
      expect(error.reason).toBe('oversized');
      expect(error.message).toContain(String(LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES));
      expectNoWrites();
    });

    it('rejects oversized serialised metadata', () => {
      enableBridge();

      const error = captureValidationError(() =>
        forwardToOtel('info', 'message', undefined, {
          payload: 'x'.repeat(LOGS_BRIDGE_MAX_META_BYTES),
        }),
      );

      expect(error.field).toBe('meta');
      expect(error.reason).toBe('oversized');
      expect(error.message).toContain(String(LOGS_BRIDGE_MAX_META_BYTES));
      expectNoWrites();
    });
  });
});
