/**
 * Logger schema tests.
 *
 * Asserts that every log line emitted by Logger matches the documented
 * JSON schema (see docs/observability.md) and that PII scrubbing rules
 * are applied before emission.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, resetLogger } from '../../src/config/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureLog(fn: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
  fn();
  spy.mockRestore();
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function captureWarn(fn: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((line: string) => lines.push(line));
  fn();
  spy.mockRestore();
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function captureError(fn: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => lines.push(line));
  fn();
  spy.mockRestore();
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Logger schema', () => {
  let logger: Logger;

  beforeEach(() => {
    resetLogger();
    logger = new Logger('debug');
  });

  afterEach(() => {
    resetLogger();
  });

  // ── Required top-level fields ─────────────────────────────────────────────

  it('info log contains timestamp, level, and message', () => {
    const entry = captureLog(() => logger.info('hello'));
    expect(typeof entry['timestamp']).toBe('string');
    expect(new Date(entry['timestamp'] as string).toISOString()).toBe(entry['timestamp']);
    expect(entry['level']).toBe('info');
    expect(entry['message']).toBe('hello');
  });

  it('debug log has level=debug', () => {
    const entry = captureLog(() => logger.debug('dbg'));
    expect(entry['level']).toBe('debug');
  });

  it('warn log has level=warn and uses console.warn', () => {
    const entry = captureWarn(() => logger.warn('degraded'));
    expect(entry['level']).toBe('warn');
  });

  it('error log has level=error and uses console.error', () => {
    const entry = captureError(() => logger.error('boom'));
    expect(entry['level']).toBe('error');
  });

  it('context is absent when not provided', () => {
    const entry = captureLog(() => logger.info('no ctx'));
    expect(entry['context']).toBeUndefined();
  });

  it('context is present and matches when provided', () => {
    const entry = captureLog(() => logger.info('with ctx', { requestId: 'r1', count: 3 }));
    expect(entry['context']).toMatchObject({ requestId: 'r1', count: 3 });
  });

  // ── error sub-object ──────────────────────────────────────────────────────

  it('error log includes error.name and error.message', () => {
    const err = new TypeError('bad input');
    const entry = captureError(() => logger.error('failed', err));
    const errObj = entry['error'] as Record<string, unknown>;
    expect(errObj['name']).toBe('TypeError');
    expect(typeof errObj['message']).toBe('string');
  });

  it('error log includes error.stack when available', () => {
    const err = new Error('with stack');
    const entry = captureError(() => logger.error('failed', err));
    const errObj = entry['error'] as Record<string, unknown>;
    expect(typeof errObj['stack']).toBe('string');
    expect((errObj['stack'] as string).length).toBeGreaterThan(0);
  });

  it('error field is absent when no Error is passed', () => {
    const entry = captureError(() => logger.error('no err obj'));
    expect(entry['error']).toBeUndefined();
  });

  // ── PII scrubbing ─────────────────────────────────────────────────────────

  it('redacts sender field in context', () => {
    const key = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const entry = captureLog(() =>
      logger.info('stream', { sender: key }),
    );
    const ctx = entry['context'] as Record<string, unknown>;
    expect(ctx['sender']).not.toBe(key);
    // Valid Stellar key → partial mask (first 4 + last 4)
    expect(ctx['sender']).toBe('GAAZ..CWN7');
  });

  it('redacts recipient field in context', () => {
    const key = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';
    const entry = captureLog(() =>
      logger.info('stream', { recipient: key }),
    );
    const ctx = entry['context'] as Record<string, unknown>;
    expect(ctx['recipient']).not.toBe(key);
    expect(ctx['recipient']).toBe('GBDE..DUXR');
  });

  it('redacts token field in context', () => {
    const entry = captureLog(() => logger.info('auth', { token: 'super-secret' }));
    const ctx = entry['context'] as Record<string, unknown>;
    expect(ctx['token']).toBe('[REDACTED]');
  });

  it('redacts authorization field in context', () => {
    const entry = captureLog(() => logger.info('req', { authorization: 'Bearer abc123' }));
    const ctx = entry['context'] as Record<string, unknown>;
    expect(ctx['authorization']).toBe('[REDACTED]');
  });

  it('masks Stellar key embedded in message string', () => {
    const key = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const entry = captureLog(() => logger.info(`sender is ${key}`));
    expect(entry['message']).not.toContain(key);
    expect(entry['message']).toContain('GAAZ..CWN7');
  });

  it('masks Stellar key in error message', () => {
    const key = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const err = new Error(`invalid key ${key}`);
    const entry = captureError(() => logger.error('err', err));
    const errObj = entry['error'] as Record<string, unknown>;
    expect(errObj['message']).not.toContain(key);
    expect(errObj['message']).toContain('GAAZ..CWN7');
  });

  it('does not redact non-sensitive fields', () => {
    const entry = captureLog(() =>
      logger.info('amounts', { depositAmount: '100.5', status: 'active', id: 'stream-1' }),
    );
    const ctx = entry['context'] as Record<string, unknown>;
    expect(ctx['depositAmount']).toBe('100.5');
    expect(ctx['status']).toBe('active');
    expect(ctx['id']).toBe('stream-1');
  });

  // ── ContextualLogger ──────────────────────────────────────────────────────

  it('child logger merges persistent context into every entry', () => {
    const child = logger.child({ correlationId: 'corr-123', service: 'test' });
    const entry = captureLog(() => child.info('event', { extra: 1 }));
    const ctx = entry['context'] as Record<string, unknown>;
    expect(ctx['correlationId']).toBe('corr-123');
    expect(ctx['service']).toBe('test');
    expect(ctx['extra']).toBe(1);
  });

  it('child logger propagates correlation_id across calls', () => {
    const child = logger.child({ correlation_id: 'async-ctx-456' });
    const e1 = captureLog(() => child.info('first'));
    const e2 = captureLog(() => child.info('second'));
    expect((e1['context'] as Record<string, unknown>)['correlation_id']).toBe('async-ctx-456');
    expect((e2['context'] as Record<string, unknown>)['correlation_id']).toBe('async-ctx-456');
  });

  // ── Level filtering ───────────────────────────────────────────────────────

  it('suppresses logs below the minimum level', () => {
    const infoLogger = new Logger('info');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    infoLogger.debug('should be suppressed');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('emits logs at or above the minimum level', () => {
    const warnLogger = new Logger('warn');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy  = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnLogger.warn('should emit');
    warnLogger.error('should also emit');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});
