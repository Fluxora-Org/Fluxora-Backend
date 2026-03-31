import { logger, LogRecord } from '../src/lib/logger';

function captureStdout(fn: () => void): LogRecord {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  fn();
  (process.stdout.write as unknown) = orig;
  return JSON.parse(chunks.join('')) as LogRecord;
}

function captureStderr(fn: () => void): LogRecord {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  fn();
  (process.stderr.write as unknown) = orig;
  return JSON.parse(chunks.join('')) as LogRecord;
}

describe('logger', () => {
  describe('output structure', () => {
    it('info record contains timestamp, level, message', () => {
      const record = captureStdout(() => logger.info('hello'));
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.level).toBe('info');
      expect(record.message).toBe('hello');
    });

    it('debug record has level debug', () => {
      const record = captureStdout(() => logger.debug('dbg'));
      expect(record.level).toBe('debug');
    });

    it('warn record has level warn', () => {
      const record = captureStdout(() => logger.warn('warning'));
      expect(record.level).toBe('warn');
    });

    it('error record written to stderr', () => {
      const record = captureStderr(() => logger.error('boom'));
      expect(record.level).toBe('error');
    });
  });

  describe('correlationId', () => {
    it('includes correlationId when provided', () => {
      const record = captureStdout(() => logger.info('test', 'req-abc-123'));
      expect(record.correlationId).toBe('req-abc-123');
    });

    it('omits correlationId when not provided', () => {
      const record = captureStdout(() => logger.info('no-id'));
      expect(Object.prototype.hasOwnProperty.call(record, 'correlationId')).toBe(false);
    });
  });

  describe('meta fields', () => {
    it('spreads extra meta fields into the record', () => {
      const record = captureStdout(() =>
        logger.info('meta test', 'cid-1', { statusCode: 200, durationMs: 42 }),
      );
      expect(record.statusCode).toBe(200);
      expect(record.durationMs).toBe(42);
    });

    it('meta fields do not overwrite core fields', () => {
      const record = captureStdout(() =>
        logger.info('overwrite test', undefined, { level: 'debug' as never }),
      );
      // level provided via meta should be overwritten by the actual level
      expect(record.level).toBe('info');
    });
  });

  describe('output format', () => {
    it('writes a single newline-terminated JSON line', () => {
      const chunks: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout.write as unknown) = (chunk: string) => {
        chunks.push(chunk);
        return true;
      };
      logger.info('line test');
      (process.stdout.write as unknown) = orig;

      const raw = chunks.join('');
      expect(raw.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(raw.trim())).not.toThrow();
    });
  });
});
