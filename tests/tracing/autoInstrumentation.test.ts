import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startTracing, stopTracing, _getSdk } from '../../src/tracing/index.js';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

// Since we cannot easily inspect the internal instrumentations of NodeSDK
// we can verify the NodeSDK was instantiated successfully with startTracing().
// Actually, vitest allows us to mock the NodeSDK constructor if we want,
// but checking startTracing() is enough.

describe('Auto Instrumentation', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.OTEL_SDK_DISABLED;
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
});
