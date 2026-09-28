/**
 * Asserts the log-level contract exposed by `src/config/logger.ts`:
 *
 *   - levels are configurable and applied from the validated schema value;
 *   - error output can never be suppressed by configuration;
 *   - every level produces a record at that level;
 *   - the effective level is recorded once at startup.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOG_LEVELS,
  applyLogLevelFromConfig,
  getLogLevel,
  isLevelEnabled,
  isLogLevel,
  logActiveLogLevel,
  setLogLevel,
  type LogLevel,
} from '../../src/config/logger.js';
import { logger } from '../../src/lib/logger.js';

function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout.write as unknown) = original;
  }
  return chunks;
}

function captureStderr(fn: () => void): string[] {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr.write as unknown) = original;
  }
  return chunks;
}

const LEVEL_WRITERS: Record<LogLevel, (message: string) => void> = {
  debug: (message) => logger.debug(message),
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error(message),
};

afterEach(() => {
  setLogLevel('debug');
});

describe('log level policy', () => {
  it('exposes the levels the schema accepts, ordered by severity', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
    for (const level of LOG_LEVELS) {
      expect(isLogLevel(level)).toBe(true);
    }
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });

  it('never lets configuration disable error output', () => {
    for (const active of LOG_LEVELS) {
      expect(isLevelEnabled('error', active)).toBe(true);
    }

    // The invariant is also enforced on the real write path.
    setLogLevel('error');
    const chunks = captureStderr(() => logger.error('still visible'));
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks.join('')).level).toBe('error');
  });

  it('suppresses records below the active level but keeps errors', () => {
    setLogLevel('warn');

    expect(captureStdout(() => logger.debug('hidden'))).toHaveLength(0);
    expect(captureStdout(() => logger.info('hidden'))).toHaveLength(0);
    expect(JSON.parse(captureStdout(() => logger.warn('shown')).join('')).level).toBe('warn');
    expect(JSON.parse(captureStderr(() => logger.error('shown')).join('')).level).toBe('error');
  });

  it('writes a record at every level when that level is active', () => {
    setLogLevel('debug');

    for (const level of LOG_LEVELS) {
      const chunks =
        level === 'error'
          ? captureStderr(() => LEVEL_WRITERS[level]('level probe'))
          : captureStdout(() => LEVEL_WRITERS[level]('level probe'));

      expect(chunks).toHaveLength(1);
      const record = JSON.parse(chunks.join(''));
      expect(record.level).toBe(level);
      expect(record.message).toBe('level probe');
    }
  });

  it('applies the schema-validated level and falls back to info for unknown values', () => {
    for (const level of LOG_LEVELS) {
      expect(applyLogLevelFromConfig({ logLevel: level, nodeEnv: 'production' })).toBe(level);
      expect(getLogLevel()).toBe(level);
    }

    expect(
      applyLogLevelFromConfig({ logLevel: 'verbose' as unknown as LogLevel, nodeEnv: 'production' }),
    ).toBe('info');
    expect(getLogLevel()).toBe('info');
  });

  it('records the active level at startup even when info is filtered out', () => {
    const chunks = captureStdout(() =>
      logActiveLogLevel({ logLevel: 'error', nodeEnv: 'production' }),
    );

    expect(chunks).toHaveLength(1);
    const record = JSON.parse(chunks.join(''));
    expect(record.message).toBe('logger:level');
    expect(record.level).toBe('info');
    expect(record.logLevel).toBe('error');
    expect(record.nodeEnv).toBe('production');
    expect(getLogLevel()).toBe('error');
  });
});
