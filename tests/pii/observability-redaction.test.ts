import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import { recordAuditEvent, _resetAuditLog, getAuditEntries } from '../../src/lib/auditLog.js';
import { Tracer } from '../../src/tracing/hooks.js';
import { sanitizeError } from '../../src/pii/sanitizer.js';
import { redactableFields } from '../../src/pii/policy.js';

const ADDRESS = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TOKEN = 'Bearer test-token-value-1256';
const PAYLOAD = '{"email":"person@example.test","database-id":"row-secret-1256"}';
const CORRELATION_ID = 'corr-1256-stable';
const GENERIC_SECRET = 'secret-value-1256';

function generatePolicyPayload(): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of redactableFields()) {
    if (field === 'address' || field === 'sender' || field === 'recipient') {
      payload[field] = ADDRESS;
    } else if (field.includes('token') || field.includes('authorization')) {
      payload[field] = TOKEN;
    } else if (field === 'payload' || field === 'body') {
      payload[field] = PAYLOAD;
    } else {
      payload[field] = GENERIC_SECRET;
    }
  }
  return payload;
}

function assertForbiddenValues(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(ADDRESS);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(PAYLOAD);
  expect(serialized).not.toContain(GENERIC_SECRET);
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
    const payload = generatePolicyPayload();
    const output = captureOutput(() => {
      logger.info(`delivery failed for ${ADDRESS} with ${TOKEN}`, CORRELATION_ID, payload);
    });

    assertForbiddenValues(output);
    expect(JSON.parse(output).correlationId).toBe(CORRELATION_ID);
  });

  it('redacts trace attributes, status messages, and error hook context', () => {
    const payload = generatePolicyPayload();
    const onEvent = vi.fn();
    const onSpanEnd = vi.fn();
    const onError = vi.fn();
    const tracer = new Tracer({ enabled: true, hooks: { onEvent, onSpanEnd, onError } });
    const span = tracer.startSpan({ traceId: CORRELATION_ID });

    tracer.recordEvent(span, 'webhook.failure', payload);
    tracer.endSpan(span, 'error', `failed for ${ADDRESS} with ${TOKEN}`);
    tracer.recordError(CORRELATION_ID, new Error(`payload=${PAYLOAD}`), payload);

    assertForbiddenValues(span);
    assertForbiddenValues(onEvent.mock.calls[0]);
    assertForbiddenValues(onSpanEnd.mock.calls[0]);
    assertForbiddenValues(onError.mock.calls[0]);
    expect(onError.mock.calls[0][0]).toBe(CORRELATION_ID);
  });

  it('redacts audit metadata and internal identifiers without changing correlation IDs', () => {
    const payload = generatePolicyPayload();
    _resetAuditLog();
    recordAuditEvent('STREAM_CREATED', 'stream', ADDRESS, CORRELATION_ID, payload);

    const entry = getAuditEntries()[0];
    assertForbiddenValues(entry);
    expect(entry.correlationId).toBe(CORRELATION_ID);
  });

  it('does not retain raw payloads in serialized error objects', () => {
    const payload = generatePolicyPayload();
    const error = new Error(`webhook failed: payload=${PAYLOAD}`);
    error.stack = `Error: ${TOKEN}\n    at ${ADDRESS}`;
    Object.assign(error, payload);

    const sanitized = sanitizeError(error);
    assertForbiddenValues(sanitized);
  });
});
