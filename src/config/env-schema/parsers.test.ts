import { describe, expect, it } from 'vitest';
import {
  booleanEnv,
  byteSizeToNumber,
  clampedIntegerEnv,
  integerEnv,
  operationDeadlinesEnv,
  parseBoolean,
  parseInteger,
  parseNumber,
} from './parsers.js';

describe('parseInteger', () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: '', expected: undefined },
    { input: 5, expected: 5 },
    { input: '5', expected: 5 },
    { input: ' 5 ', expected: 5 },
    { input: '-5', expected: -5 },
    { input: '1e3', expected: '1e3' },
    { input: '5.0', expected: '5.0' },
    { input: '+5', expected: '+5' },
    { input: '   ', expected: '   ' },
    { input: null, expected: null },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(parseInteger(input)).toBe(expected);
  });
});

describe('parseBoolean', () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: '', expected: undefined },
    { input: true, expected: true },
    { input: false, expected: false },
    { input: 'true', expected: true },
    { input: 'TRUE', expected: true },
    { input: ' true ', expected: true },
    { input: '1', expected: true },
    { input: 'false', expected: false },
    { input: 'FALSE', expected: false },
    { input: '0', expected: false },
    { input: 'yes', expected: 'yes' },
    { input: ' true-ish ', expected: ' true-ish ' },
    { input: 1, expected: 1 },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(parseBoolean(input)).toBe(expected);
  });
});

describe('parseNumber', () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: '', expected: undefined },
    { input: 5, expected: 5 },
    { input: '5', expected: 5 },
    { input: ' 5 ', expected: 5 },
    { input: '1e3', expected: 1000 },
    { input: '10kb', expected: 10 },
    { input: 'not-a-number', expected: 'not-a-number' },
    { input: 'Infinity', expected: 'Infinity' },
    { input: null, expected: null },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(parseNumber(input)).toBe(expected);
  });
});

describe('byteSizeToNumber', () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: '', expected: undefined },
    { input: 5, expected: 5 },
    { input: '10', expected: 10 },
    { input: '10b', expected: 10 },
    { input: '10kb', expected: 10 * 1024 },
    { input: '1.5MB', expected: 1.5 * 1024 * 1024 },
    { input: ' 2 gb ', expected: 2 * 1024 * 1024 * 1024 },
    { input: '1.9b', expected: 1 },
    { input: '1e3', expected: '1e3' },
    { input: '-1kb', expected: '-1kb' },
    { input: '10tb', expected: '10tb' },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(byteSizeToNumber(input)).toBe(expected);
  });
});

describe('integerEnv', () => {
  const schema = integerEnv('LIMIT', 1, 10);

  it.each([
    { input: '1', expected: 1 },
    { input: ' 5 ', expected: 5 },
    { input: '10', expected: 10 },
  ])('accepts inclusive boundary input $input', ({ input, expected }) => {
    expect(schema.parse(input)).toBe(expected);
  });

  it.each(['0', '11', '1.5', '1e3', ''])('rejects out-of-range or invalid input %s', (input) => {
    expect(() => schema.parse(input)).toThrow();
  });
});

describe('clampedIntegerEnv', () => {
  const schema = clampedIntegerEnv('LIMIT', 1, 10, 5);

  it.each([
    { input: undefined, expected: 5 },
    { input: '', expected: 5 },
    { input: 'not-a-number', expected: 5 },
    { input: '1e3', expected: 5 },
    { input: '-1', expected: 1 },
    { input: '1', expected: 1 },
    { input: '7', expected: 7 },
    { input: '10', expected: 10 },
    { input: '11', expected: 10 },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(schema.parse(input)).toBe(expected);
  });
});

describe('booleanEnv', () => {
  it.each([
    { input: 'TRUE', expected: true },
    { input: '0', expected: false },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(booleanEnv().parse(input)).toBe(expected);
  });

  it('rejects unrecognized boolean strings', () => {
    expect(() => booleanEnv().parse('yes')).toThrow();
  });
});

describe('operationDeadlinesEnv', () => {
  it.each([
    { input: undefined, expected: {} },
    { input: '', expected: {} },
    { input: '{"getLedger":250}', expected: { getLedger: 250 } },
  ])('parses $input as $expected', ({ input, expected }) => {
    expect(operationDeadlinesEnv().parse(input)).toEqual(expected);
  });

  it.each(['not-json', '{"getLedger":0}', '{"getLedger":"250"}'])(
    'rejects invalid deadlines %s',
    (input) => {
      expect(() => operationDeadlinesEnv().parse(input)).toThrow();
    }
  );
});
