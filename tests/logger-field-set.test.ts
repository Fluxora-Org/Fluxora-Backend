import { describe, expect, it } from 'vitest';
import { LOGGER_CORE_FIELDS, type LogLevel, type LogRecord } from '../src/lib/logger.js';

describe('structured logger field contract', () => {
  it('keeps the committed core field set stable', () => {
    const fixture: readonly (keyof LogRecord)[] = ['timestamp', 'level', 'message'];
    expect(LOGGER_CORE_FIELDS).toEqual(fixture);
  });

  it('allows optional correlation and metadata fields without changing the core', () => {
    const record: LogRecord = {
      timestamp: new Date(0).toISOString(),
      level: 'info' satisfies LogLevel,
      message: 'fixture',
      correlationId: 'corr-1',
      component: 'test',
    };

    expect(LOGGER_CORE_FIELDS.every((field) => field in record)).toBe(true);
  });
});
