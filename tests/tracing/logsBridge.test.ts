/**
 * Tests for `src/tracing/logsBridge.ts` — the OpenTelemetry logs bridge.
 *
 * Contract under test (issue #1440): the bridge must never forward personal
 * data into a trace/log backend. Redaction must run before a record is
 * forwarded, every field named in the PII policy (`redactableFields()`) must
 * have its value redacted on the forwarded copy, and a failing exporter must
 * never drop or corrupt the original structured log line written to
 * stdout/stderr.
 *
 * The assertion payload is derived from `redactableFields()` at runtime, so a
 * new PII field added to `src/pii/policy.ts` is exercised automatically the
 * next time these tests run — no test edit required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  forwardToOtel,
  initLogsBridge,
  isLogsBridgeEnabled,
  resetLogsBridge,
} from '../../src/tracing/logsBridge.js';
import { logger } from '../../src/lib/logger.js';
import { redactableFields } from '../../src/pii/policy.js';
import { REDACTED } from '../../src/pii/sanitizer.js';

/** Shape of the LogRecord passed to `logs.getLogger().emit()`. */
interface EmittedLogRecord {
  body?: unknown;
  attributes?: Record<string, unknown>;
  severityText?: string;
}

// ── OTel Logs API test double ─────────────────────────────────────────────────
// `logsBridge` emits LogRecords via `logs.getLogger(scope).emit(record)`. We
// intercept that single call so each test can inspect exactly what would have
// reached the trace backend. The state is hoisted because `vi.mock` factories
// are lifted above imports.
const bridgeState = vi.hoisted(() => ({
  emitted: [] as unknown[],
  order: [] as string[],
  emitError: null as Error | null,
  getLoggerError: null as Error | null,
}));

vi.mock('@opentelemetry/api-logs', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api-logs')>('@opentelemetry/api-logs');
  return {
    ...actual,
    logs: {
      getLogger: () => {
        if (bridgeState.getLoggerError) throw bridgeState.getLoggerError;
        return {
          emit: (record: unknown) => {
            bridgeState.order.push('trace');
            // Simulate a collector/exporter that is down: `emit()` throws.
            if (bridgeState.emitError) throw bridgeState.emitError;
            bridgeState.emitted.push(record);
          },
        };
      },
    } as unknown as typeof actual.logs,
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Valid Stellar public key (G + 55 base-32 chars). */
const STELLAR_PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const BEARER_TOKEN = 'Bearer super-secret-bearer-token-do-not-leak';
const SENTINEL_PREFIX = 'PII-SENTINEL';

function isAddressField(field: string): boolean {
  return field.includes('address') || field === 'sender' || field === 'recipient';
}

function isCredentialField(field: string): boolean {
  return /token|authorization|api-key|key|secret|credential|cookie|password/.test(field);
}

/** A unique, recognisable value for a policy field so leaks are unambiguous. */
function sentinelFor(field: string): string {
  if (isAddressField(field)) return STELLAR_PUBLIC_KEY;
  if (isCredentialField(field)) return BEARER_TOKEN;
  return `${SENTINEL_PREFIX}-${field.toUpperCase()}-DO-NOT-LEAK`;
}

/** Every value the bridge must strip before forwarding. */
function forbiddenValues(): string[] {
  const values = new Set<string>([STELLAR_PUBLIC_KEY, BEARER_TOKEN]);
  for (const field of redactableFields()) {
    values.add(`${SENTINEL_PREFIX}-${field.toUpperCase()}-DO-NOT-LEAK`);
  }
  return [...values];
}

/**
 * Build a metadata object containing one entry for every field named in the
 * PII policy. Deriving this from `redactableFields()` (rather than a hardcoded
 * list) is what makes new policy fields covered automatically.
 */
function buildPolicyPayload(): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of redactableFields()) {
    payload[field] = sentinelFor(field);
  }
  return payload;
}

/** A forwarded attribute is safe when fully redacted or a partially masked key. */
function isRedactedAttributeValue(value: unknown): boolean {
  if (value === REDACTED) return true;
  // `maskStellarKey` keeps the first 4 and last 4 characters, e.g. "GAAZ..CCWN7".
  return typeof value === 'string' && /^.{4}\.\..{4}$/.test(value);
}

function emittedRecords(): EmittedLogRecord[] {
  return bridgeState.emitted as EmittedLogRecord[];
}

function expectNoForbiddenValues(serialized: string): void {
  for (const value of forbiddenValues()) {
    expect(serialized).not.toContain(value);
  }
}

/**
 * Capture stdout/stderr writes so we can prove the original structured log
 * line is produced independently of the OTel forwarding path. When `order` is
 * provided it records the interleaving of the console write and the OTel emit.
 */
function captureStdio(fn: () => void, order?: string[]): { stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    order?.push('log');
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    order?.push('log');
    return true;
  }) as typeof process.stderr.write;

  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

describe('logs bridge PII contract (issue #1440)', () => {
  beforeEach(() => {
    bridgeState.emitted.length = 0;
    bridgeState.order.length = 0;
    bridgeState.emitError = null;
    bridgeState.getLoggerError = null;
    resetLogsBridge();
  });

  afterEach(() => {
    resetLogsBridge();
  });

  it('is a no-op until explicitly enabled', () => {
    expect(isLogsBridgeEnabled()).toBe(false);

    const { stdout } = captureStdio(() => {
      logger.info('bridge disabled', 'corr-disabled', buildPolicyPayload());
    });

    expect(bridgeState.emitted).toHaveLength(0);
    expect(stdout).toContain('bridge disabled');
  });

  it('redacts before forwarding: the original log line is written before the trace emit', () => {
    initLogsBridge({ enabled: true });
    const order: string[] = [];

    captureStdio(() => {
      logger.info('ordering check', 'corr-order', { note: 'ok' });
    }, order);

    // The structured log line must be written before the OTel emission, so a
    // failing exporter can never suppress it.
    expect(order).toEqual(['log', 'trace']);
    expect(emittedRecords()).toHaveLength(1);
  });

  it('asserts no field named in the PII policy reaches a forwarded record', () => {
    initLogsBridge({ enabled: true });
    const payload = buildPolicyPayload();

    captureStdio(() => {
      logger.info('policy payload', 'corr-policy', payload);
    });

    expect(emittedRecords()).toHaveLength(1);
    const [record] = emittedRecords();

    // No policy value may appear anywhere in the forwarded record.
    expectNoForbiddenValues(JSON.stringify(record));

    // Each policy field that survives as an attribute must hold a redacted value.
    const attributes = record.attributes ?? {};
    for (const field of redactableFields()) {
      if (Object.prototype.hasOwnProperty.call(attributes, field)) {
        expect(
          isRedactedAttributeValue(attributes[field]),
          `forwarded attribute "${field}" was not redacted`,
        ).toBe(true);
      }
    }
  });

  it('covers new PII policy fields automatically because the payload is derived from redactableFields()', () => {
    const payload = buildPolicyPayload();
    const policyFields = Array.from(redactableFields());

    expect(policyFields.length).toBeGreaterThan(0);
    expect(Object.keys(payload).sort()).toEqual([...policyFields].sort());

    initLogsBridge({ enabled: true });
    captureStdio(() => {
      logger.info('policy coverage', 'corr-coverage', payload);
    });

    const attributes = emittedRecords()[0]?.attributes ?? {};
    for (const field of policyFields) {
      expect(attributes[field], `attribute "${field}" missing from forwarded record`).toBeDefined();
      expect(
        isRedactedAttributeValue(attributes[field]),
        `attribute "${field}" was not redacted`,
      ).toBe(true);
    }
  });

  it('re-sanitizes raw metadata when the caller bypasses the logger pipeline', () => {
    initLogsBridge({ enabled: true });

    forwardToOtel('info', 'direct bridge call', 'corr-direct', {
      password: 'hunter2',
      note: `stellar=${STELLAR_PUBLIC_KEY}`,
    });

    expect(emittedRecords()).toHaveLength(1);
    const record = emittedRecords()[0];
    expectNoForbiddenValues(JSON.stringify(record));

    const attributes = record.attributes ?? {};
    expect(attributes.password).toBe(REDACTED);
    expect(String(attributes.note)).not.toContain(STELLAR_PUBLIC_KEY);
  });

  it('redacts PII embedded in the forwarded message body', () => {
    initLogsBridge({ enabled: true });
    const message = `contact ${STELLAR_PUBLIC_KEY} using ${BEARER_TOKEN}`;

    captureStdio(() => {
      logger.info(message, 'corr-body', { safe: 'value' });
    });

    const record = emittedRecords()[0];
    const body = String(record.body);
    expect(body).not.toContain(STELLAR_PUBLIC_KEY);
    expect(body).not.toContain(BEARER_TOKEN);
    expect(record.attributes?.safe).toBe('value');
  });

  it('redacts PII nested below the top level of the forwarded metadata', () => {
    initLogsBridge({ enabled: true });

    captureStdio(() => {
      logger.info('nested', 'corr-nested', {
        context: { password: 'nested-secret', detail: `key=${STELLAR_PUBLIC_KEY}` },
      });
    });

    const record = emittedRecords()[0];
    expectNoForbiddenValues(JSON.stringify(record));

    const nested = String(record.attributes?.context);
    expect(nested).not.toContain('nested-secret');
    expect(nested).not.toContain(STELLAR_PUBLIC_KEY);
  });

  it('does not drop the original log when the OTel exporter throws', () => {
    initLogsBridge({ enabled: true });
    bridgeState.emitError = new Error('collector unavailable');

    const { stdout } = captureStdio(() => {
      expect(() =>
        logger.info('exporter failure must not drop this log', 'corr-emit-fail', { note: 'kept' }),
      ).not.toThrow();
    });

    expect(stdout).toContain('exporter failure must not drop this log');
    expect(stdout).toContain('corr-emit-fail');
    expect(JSON.parse(stdout).message).toBe('exporter failure must not drop this log');
  });

  it('does not drop the original log when resolving the OTel logger throws', () => {
    initLogsBridge({ enabled: true });
    bridgeState.getLoggerError = new Error('logger provider misconfigured');

    const { stderr } = captureStdio(() => {
      expect(() =>
        logger.error('logger resolution failure must not drop this log', 'corr-getlogger-fail'),
      ).not.toThrow();
    });

    expect(stderr).toContain('logger resolution failure must not drop this log');
    expect(stderr).toContain('corr-getlogger-fail');
  });
});
