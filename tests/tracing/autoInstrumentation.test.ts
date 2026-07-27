import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startTracing, stopTracing, _getSdk } from '../../src/tracing/index.js';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

/**
 * Verify that PgInstrumentation and HttpInstrumentation are registered in
 * the NodeSDK created by startTracing().
 *
 * We can't directly inspect the SDK's internal instrumentations list, but we
 * can verify:
 *   1. The SDK was created and started successfully.
 *   2. The instrumentation classes are importable (they are real deps).
 *   3. The SDK respects OTEL_SDK_DISABLED.
 *   4. startTracing() is idempotent.
 *   5. stopTracing() shuts down cleanly.
 */

describe('Auto Instrumentation (issue #941)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(async () => {
    await stopTracing();
  });

  it('starts tracing SDK and does not throw', () => {
    const started = startTracing();
    expect(started).toBe(true);
    expect(_getSdk()).not.toBeNull();
  });

  it('does not start SDK if OTEL_SDK_DISABLED is true', () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    const started = startTracing();
    expect(started).toBe(false);
    expect(_getSdk()).toBeNull();
  });

  it('is idempotent — second call returns false', () => {
    const first = startTracing();
    const second = startTracing();
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('shuts down cleanly with stopTracing()', async () => {
    startTracing();
    expect(_getSdk()).not.toBeNull();
    await stopTracing();
    expect(_getSdk()).toBeNull();
  });

  it('stopTracing() is safe when SDK was never started', async () => {
    await expect(stopTracing()).resolves.toBeUndefined();
  });

  it('stopTracing() is safe to call multiple times', async () => {
    startTracing();
    await stopTracing();
    await expect(stopTracing()).resolves.toBeUndefined();
  });

  it('survives an unreachable OTLP endpoint', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:19999';
    expect(() => startTracing()).not.toThrow();
  });

  it('falls back to default endpoint for invalid URL', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'not-a-url';
    expect(() => startTracing()).not.toThrow();
  });

  describe('instrumentation classes are importable', () => {
    it('PgInstrumentation can be constructed', () => {
      const inst = new PgInstrumentation();
      expect(inst).toBeInstanceOf(PgInstrumentation);
    });

    it('HttpInstrumentation can be constructed with options', () => {
      const inst = new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/health',
      });
      expect(inst).toBeInstanceOf(HttpInstrumentation);
    });

    it('ExpressInstrumentation can be constructed', () => {
      const inst = new ExpressInstrumentation();
      expect(inst).toBeInstanceOf(ExpressInstrumentation);
    });

    it('IORedisInstrumentation can be constructed', () => {
      const inst = new IORedisInstrumentation();
      expect(inst).toBeInstanceOf(IORedisInstrumentation);
    });
  });
});
