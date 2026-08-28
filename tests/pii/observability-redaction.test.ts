import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import { recordAuditEvent, _resetAuditLog, getAuditEntries } from '../../src/lib/auditLog.js';
import { Tracer } from '../../src/tracing/hooks.js';
import { sanitizeError } from '../../src/pii/sanitizer.js';

const ADDRESS = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TOKEN = 'Bearer test-token-value-1256';
const PAYLOAD = '{"email":"person@example.test","database-id":"row-secret-1256"}';
const CORRELATION_ID = 'corr-1256-stable';

function assertForbiddenValues(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(ADDRESS);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(PAYLOAD);
}

function captureOutput(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

describe('observability PII redaction contract', () => {
  it('redacts logger messages and metadata while preserving correlation IDs', () => {
    const output = captureOutput(() => {
      logger.info(`delivery failed for ${ADDRESS} with ${TOKEN}`, CORRELATION_ID, {
        address: ADDRESS,
        payload: PAYLOAD,
        diagnostic: `authorization=${TOKEN}`,
      });
    });

    assertForbiddenValues(output);
    expect(JSON.parse(output).correlationId).toBe(CORRELATION_ID);
  });

  it('redacts trace attributes, status messages, and error hook context', () => {
    const onEvent = vi.fn();
    const onSpanEnd = vi.fn();
    const onError = vi.fn();
    const tracer = new Tracer({ enabled: true, hooks: { onEvent, onSpanEnd, onError } });
    const span = tracer.startSpan({ traceId: CORRELATION_ID });

    tracer.recordEvent(span, 'webhook.failure', { address: ADDRESS, payload: PAYLOAD, token: TOKEN });
    tracer.endSpan(span, 'error', `failed for ${ADDRESS} with ${TOKEN}`);
    tracer.recordError(CORRELATION_ID, new Error(`payload=${PAYLOAD}`), { address: ADDRESS, token: TOKEN });

    assertForbiddenValues(span);
    assertForbiddenValues(onEvent.mock.calls[0]);
    assertForbiddenValues(onSpanEnd.mock.calls[0]);
    assertForbiddenValues(onError.mock.calls[0]);
    expect(onError.mock.calls[0][0]).toBe(CORRELATION_ID);
  });

  it('redacts audit metadata and internal identifiers without changing correlation IDs', () => {
    _resetAuditLog();
    recordAuditEvent('STREAM_CREATED', 'stream', ADDRESS, CORRELATION_ID, {
      address: ADDRESS,
      payload: PAYLOAD,
      token: TOKEN,
    });

    const entry = getAuditEntries()[0];
    assertForbiddenValues(entry);
    expect(entry.correlationId).toBe(CORRELATION_ID);
  });

  it('does not retain raw payloads in serialized error objects', () => {
    const error = new Error(`webhook failed: payload=${PAYLOAD}`);
    error.stack = `Error: ${TOKEN}\n    at ${ADDRESS}`;

    const sanitized = sanitizeError(error);
    assertForbiddenValues(sanitized);
  });
});
