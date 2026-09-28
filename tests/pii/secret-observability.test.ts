import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Counter, Registry } from 'prom-client';
import { logger } from '../../src/lib/logger.js';
import { Tracer } from '../../src/tracing/hooks.js';
import {
  SECRET_PATTERNS,
  SECRET_TEST_SAMPLES,
  REDACTED_SECRET,
  containsSecret,
  redactSecretsInString,
  redactSecretsDeep,
  sanitizeMetricLabels,
  assertNoSecrets,
} from '../../src/pii/secretPatterns.js';
import { redactKeysInString, sanitize } from '../../src/pii/sanitizer.js';

const ALL_SAMPLES = Object.values(SECRET_TEST_SAMPLES);

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

describe('secret deny-list (observability contract)', () => {
  it('defines a deny-list covering every required secret kind', () => {
    const kinds = new Set(SECRET_PATTERNS.map((p) => p.kind));
    expect(kinds.has('api_key')).toBe(true);
    expect(kinds.has('webhook_secret')).toBe(true);
    expect(kinds.has('database_credential')).toBe(true);
    expect(kinds.has('oidc_client_secret')).toBe(true);
    for (const sample of ALL_SAMPLES) {
      expect(containsSecret(sample)).toBe(true);
      expect(redactSecretsInString(sample)).not.toContain(sample);
    }
  });

  it('redacts secrets through the shared sanitizer string pipeline', () => {
    for (const sample of ALL_SAMPLES) {
      const line = `diagnostic payload includes ${sample}`;
      const redacted = redactKeysInString(line);
      expect(redacted).not.toContain(sample);
      assertNoSecrets(redacted, ALL_SAMPLES);
    }
  });

  it('emits every secret type into logs and asserts none escapes', () => {
    const message = [
      `api=${SECRET_TEST_SAMPLES.api_key}`,
      `webhook=${SECRET_TEST_SAMPLES.webhook_secret}`,
      `db=${SECRET_TEST_SAMPLES.database_credential}`,
      `oidc=${SECRET_TEST_SAMPLES.oidc_client_secret}`,
    ].join(' ');

    const output = captureStdout(() => {
      logger.info(message, 'corr-secret-1564', {
        apiKey: SECRET_TEST_SAMPLES.api_key,
        webhookSecret: SECRET_TEST_SAMPLES.webhook_secret,
        databaseUrl: SECRET_TEST_SAMPLES.database_credential,
        clientSecret: SECRET_TEST_SAMPLES.oidc_client_secret,
        note: `embedded ${SECRET_TEST_SAMPLES.webhook_secret}`,
      });
    });

    assertNoSecrets(output, ALL_SAMPLES);
    for (const sample of ALL_SAMPLES) {
      expect(output).not.toContain(sample);
    }
  });

  it('covers trace attributes with the same deny-list check', () => {
    const onEvent = vi.fn();
    const onSpanEnd = vi.fn();
    const onError = vi.fn();
    const tracer = new Tracer({ enabled: true, hooks: { onEvent, onSpanEnd, onError } });
    const span = tracer.startSpan({ traceId: 'corr-secret-1564' });

    tracer.recordEvent(span, 'auth.failure', {
      api_key: SECRET_TEST_SAMPLES.api_key,
      webhook_secret: SECRET_TEST_SAMPLES.webhook_secret,
      database_url: SECRET_TEST_SAMPLES.database_credential,
      client_secret: SECRET_TEST_SAMPLES.oidc_client_secret,
      detail: `oidc=${SECRET_TEST_SAMPLES.oidc_client_secret}`,
    });
    tracer.endSpan(
      span,
      'error',
      `failed with ${SECRET_TEST_SAMPLES.api_key} and ${SECRET_TEST_SAMPLES.webhook_secret}`,
    );
    tracer.recordError(
      'corr-secret-1564',
      new Error(`db=${SECRET_TEST_SAMPLES.database_credential}`),
      { client_secret: SECRET_TEST_SAMPLES.oidc_client_secret },
    );

    assertNoSecrets(span, ALL_SAMPLES);
    assertNoSecrets(onEvent.mock.calls, ALL_SAMPLES);
    assertNoSecrets(onSpanEnd.mock.calls, ALL_SAMPLES);
    assertNoSecrets(onError.mock.calls, ALL_SAMPLES);
  });

  it('refuses secret values as metric labels', () => {
    const registry = new Registry();
    const counter = new Counter({
      name: 'fluxora_secret_guard_test_total',
      help: 'test counter for secret label guard',
      labelNames: ['route', 'api_key', 'detail'] as const,
      registers: [registry],
    });

    const unsafe = {
      route: '/hooks',
      api_key: SECRET_TEST_SAMPLES.api_key,
      detail: `sig=${SECRET_TEST_SAMPLES.webhook_secret}`,
    };
    const safe = sanitizeMetricLabels(unsafe);
    expect(safe.api_key).toBe(REDACTED_SECRET);
    expect(safe.detail).not.toContain(SECRET_TEST_SAMPLES.webhook_secret);
    assertNoSecrets(safe, ALL_SAMPLES);

    counter.inc(safe);
    // Serialized registry must not contain raw secrets.
    return registry.metrics().then((text) => {
      assertNoSecrets(text, ALL_SAMPLES);
      for (const sample of ALL_SAMPLES) {
        expect(text).not.toContain(sample);
      }
    });
  });

  it('sanitize() deep-redacts nested secret field values', () => {
    const cleaned = sanitize({
      nested: {
        apiKey: SECRET_TEST_SAMPLES.api_key,
        info: `url=${SECRET_TEST_SAMPLES.database_credential}`,
      },
    });
    assertNoSecrets(cleaned, ALL_SAMPLES);
    assertNoSecrets(redactSecretsDeep({ raw: SECRET_TEST_SAMPLES.oidc_client_secret }), ALL_SAMPLES);
  });
});
