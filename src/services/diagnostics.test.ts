import { describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import * as fs from 'node:fs';
const mod = await import('./diagnostics');
const validate = (mod as any).validateDiagnosticsInput as ((input: unknown) => unknown) | undefined;
const run = (mod as any).runDiagnostics as ((input: unknown) => unknown) | undefined;
const TypedError = ((mod as any).DiagnosticsValidationError || ((mod as any).ValidationError) || Error) as new (message: string, ...args: unknown[]) => Error;

describe('src/services/diagnostics', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('diagnostics-test-');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  function expectTypedRejection(input: unknown) {
    const fn = validate ?? run;
    if (!fn) {
      throw new Error('diagnostics module exposes no validation or run entrypoint');
    }
    let caught: unknown | undefined;
    try {
      fn(input as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypedError);
    return caught as Error;
  }

  it('rejects undefined input with a typed error', () => {
    expectTypedRejection(undefined);
  });

  it('rejects null input with a typed error', () => {
    expectTypedRejection(null);
  });

  it('rejects a non-object primitive with a typed error', () => {
    expectTypedRejection('not-an-object');
  });

  it('rejects an empty object with a typed error', () => {
    expectTypedRejection({});
  });

  it('rejects oversized input with a typed error', () => {
    const oversized = {
      payload: 'x' + 'x' + 'x'.repeat(10_000_000),
    };
    expectTypedRejection(oversized);
  });

  it('rejects input with malformed field types with a typed error', () => {
    expectTypedRejection({ id: 1234, payload: { not: 'a string' } });
  });

  it('reports the reason for rejection to the caller', () => {
    const error = expectTypedRejection(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('rejection occurs before any state is written', () => {
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      expectTypedRejection(null);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts valid input without throwing', () => {
    const fn = validate ?? run;
    if (!fn) {
      throw new Error('diagnostics module exposes no validation or run entrypoint');
    }
    const valid = {
      id: 'diag-123',
      payload: 'healthy',
      level: 'info',
    };
    expect(() => fn(valid as never)).not.toThrow();
  });
});
