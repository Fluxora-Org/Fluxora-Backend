import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, LogLevel } from '../../src/logging/logger.js';

const VALID_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits structured JSON to stdout for info level', () => {
    logger.info('test message');
    expect(logSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe(LogLevel.INFO);
    expect(entry.msg).toBe('test message');
    expect(entry.ts).toBeDefined();
  });

  it('emits to stderr for error level', () => {
    logger.error('bad thing');
    expect(errorSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe(LogLevel.ERROR);
  });

  it('emits to stderr for warn level', () => {
    logger.warn('caution');
    expect(warnSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe(LogLevel.WARN);
  });

  it('redacts Stellar keys in the message string', () => {
    logger.info(`Created stream for ${VALID_KEY}`);
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.msg).not.toContain(VALID_KEY);
    expect(entry.msg).toContain('GAAZ..CWN7');
  });

  it('redacts sensitive fields in metadata', () => {
    logger.info('stream event', { sender: VALID_KEY, id: 'stream-1' });
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.sender).not.toBe(VALID_KEY);
    expect(entry.sender).toBe('GAAZ..CWN7');
    expect(entry.id).toBe('stream-1');
  });

  it('does not overwrite reserved keys (level, ts, msg) from meta', () => {
    logger.info('msg', { level: 'FAKE', ts: 'FAKE', msg: 'FAKE', extra: 'ok' });
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe(LogLevel.INFO);
    expect(entry.msg).toBe('msg');
    expect(entry.extra).toBe('ok');
  });

  it('handles missing metadata gracefully', () => {
    logger.debug('no meta');
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe(LogLevel.DEBUG);
    expect(Object.keys(entry)).toEqual(['level', 'ts', 'msg']);
  });
});
