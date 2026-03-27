import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { logger } from './logger.js';

describe('lib/logger', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('info writes to stdout', () => {
    logger.info('test info');
    expect(stdoutSpy).toHaveBeenCalled();
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(line.level).toBe('info');
    expect(line.message).toBe('test info');
  });

  it('debug writes to stdout', () => {
    logger.debug('test debug');
    expect(stdoutSpy).toHaveBeenCalled();
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(line.level).toBe('debug');
  });

  it('warn writes to stdout', () => {
    logger.warn('test warn');
    expect(stdoutSpy).toHaveBeenCalled();
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(line.level).toBe('warn');
  });

  it('error writes to stderr', () => {
    logger.error('test error');
    expect(stderrSpy).toHaveBeenCalled();
    const line = JSON.parse(String(stderrSpy.mock.calls[0]?.[0]));
    expect(line.level).toBe('error');
    expect(line.message).toBe('test error');
  });

  it('includes correlationId when provided', () => {
    logger.info('msg', 'corr-123');
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(line.correlationId).toBe('corr-123');
  });

  it('includes meta fields', () => {
    logger.info('msg', undefined, { foo: 'bar' });
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(line.foo).toBe('bar');
  });

  it('core fields take precedence over meta', () => {
    logger.info('real message', undefined, { message: 'overridden', level: 'overridden' });
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(line.message).toBe('real message');
    expect(line.level).toBe('info');
  });

  it('includes timestamp', () => {
    logger.info('ts test');
    const line = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(typeof line.timestamp).toBe('string');
    expect(new Date(line.timestamp).getTime()).toBeGreaterThan(0);
  });
});
