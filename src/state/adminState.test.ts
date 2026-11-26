import { describe, it, expect } from 'vitest';
import * as adminState from './adminState';

type AnyFn = (...args: unknown[]) => unknown;

const exportedEntries = Object.entries(adminState as Record<string, unknown>);
const exportedFunctions = exportedEntries.filter(
  ([, value]) => typeof value === 'function' && value !== adminState.AdminStatePersistenceError,
) as [string, AnyFn][];

describe('adminState module surface', () => {
  it('exports at least one binding', () => {
    expect(exportedEntries.length).toBeGreaterThan(0);
  });

  it('does not export undefined bindings', () => {
    for (const [name, value] of exportedEntries) {
      expect(value, `export "${name}" should be defined`).not.toBeUndefined();
    }
  });
});

describe.each(exportedFunctions)('exported function %s', (_name, fn) => {
  it('is callable and returns without throwing on empty input', () => {
    expect(() => fn()).not.toThrow();
  });

  it('tolerates zero / empty-string / empty-array boundaries', () => {
    const boundaries: unknown[][] = [[], [0], [''], [[]], [{}], [null], [undefined]];
    for (const args of boundaries) {
      expect(() => fn(...args)).not.toThrow();
    }
  });

  it('is deterministic for repeated identical calls', () => {
    const a = fn();
    const b = fn();
    if (typeof a === 'object' && a !== null) {
      expect(a).toEqual(b);
    } else {
      expect(a).toBe(b);
    }
  });
});

describe('AdminStatePersistenceError', () => {
  it('preserves its name, message, and original cause', () => {
    const cause = new Error('database unavailable');
    const error = new adminState.AdminStatePersistenceError('could not save', cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AdminStatePersistenceError');
    expect(error.message).toBe('could not save');
    expect(error.cause).toBe(cause);
  });
});
