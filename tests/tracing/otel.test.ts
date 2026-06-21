/**
 * Tests for src/tracing/index.ts — OTel SDK bootstrap.
 *
 * Coverage:
 *   - startTracing() returns false when OTEL_SDK_DISABLED=true
 *   - startTracing() is idempotent (second call is a no-op)
 *   - startTracing() survives an unreachable OTLP endpoint (no crash)
 *   - stopTracing() is safe to call when SDK was never started
 *   - stopTracing() is safe to call multiple times
 *   - OTLP header parsing (valid, empty, malformed)
 *   - OTLP endpoint URL validation (invalid URL falls back to default)
 *
 * Tests for src/tracing/hooks.ts — business span helpers.
 *
 * Coverage:
 *   - traceDbQuery wraps fn and records db.* attributes
 *   - traceRedisCommand wraps fn and records db.system=redis
 *   - traceStellarRpc wraps fn and records rpc.* attributes
 *   - traceWebhookDispatch wraps fn and records webhook.* attributes
 *   - recordWsBroadcast is a no-op when no active OTel span
 *   - All helpers propagate errors and re-throw
 *   - All helpers work when tracing is disabled (OTEL_SDK_DISABLED=true)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initializeTracer,
  resetTracer,
  traceDbQuery,
  traceRedisCommand,
  traceStellarRpc,
  traceWebhookDispatch,
  traceSseDispatch,
  recordWsBroadcast,
} from '../../src/tracing/hooks.js';
import { SpanBuffer } from '../../src/tracing/builtin.js';

// ── SDK bootstrap ─────────────────────────────────────────────────────────────
// These tests use vi.resetModules() to isolate env mutations.
// They are kept in a separate describe block so module resets don't affect
// the static imports used by the business-helper tests below.

describe('OTel SDK bootstrap (src/tracing/index.ts)', () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    // Stop any running SDK instance.
    try {
      const { stopTracing } = await import('../../src/tracing/index.js');
      await stopTracing();
    } catch {
      // ignore
    }
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  it('returns false and does not start when OTEL_SDK_DISABLED=true', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    vi.resetModules();
    const { startTracing, _getSdk } = await import('../../src/tracing/index.js');
    const started = startTracing();
    expect(started).toBe(false);
    expect(_getSdk()).toBeNull();
  });

  it('returns true on first call and false on subsequent calls (idempotent)', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    const first = startTracing();
    const second = startTracing();
    expect(first).toBe(true);
    expect(second).toBe(false);
    await stopTracing();
  });

  it('does not crash when OTLP endpoint is unreachable', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:19999';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    expect(() => startTracing()).not.toThrow();
    await stopTracing();
  });

  it('falls back to default endpoint when OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'not-a-url';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    expect(() => startTracing()).not.toThrow();
    await stopTracing();
  });

  it('stopTracing() is safe when SDK was never started', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    vi.resetModules();
    const { stopTracing } = await import('../../src/tracing/index.js');
    await expect(stopTracing()).resolves.toBeUndefined();
  });

  it('stopTracing() is safe to call multiple times', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    startTracing();
    await stopTracing();
    await expect(stopTracing()).resolves.toBeUndefined();
  });
});

// ── OTLP header parsing ───────────────────────────────────────────────────────

describe('OTLP header parsing', () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    try {
      const { stopTracing } = await import('../../src/tracing/index.js');
      await stopTracing();
    } catch { /* ignore */ }
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  it('accepts empty OTEL_EXPORTER_OTLP_HEADERS', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = '';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    expect(() => startTracing()).not.toThrow();
    await stopTracing();
  });

  it('accepts valid key=value header pairs', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer token123,x-tenant=acme';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    expect(() => startTracing()).not.toThrow();
    await stopTracing();
  });

  it('ignores malformed header pairs (no = separator)', async () => {
    process.env.OTEL_SDK_DISABLED = 'false';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'badheader,another=ok';
    vi.resetModules();
    const { startTracing, stopTracing } = await import('../../src/tracing/index.js');
    expect(() => startTracing()).not.toThrow();
    await stopTracing();
  });
});

// ── Business span helpers ─────────────────────────────────────────────────────
// These tests use static imports (no vi.resetModules) so the global tracer
// state set in beforeEach is visible to the helpers.

describe('traceDbQuery', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });
  });
  afterEach(() => resetTracer());

  it('returns the result of fn', async () => {
    const result = await traceDbQuery('SELECT 1', 'fluxora', async () => 42);
    expect(result).toBe(42);
  });

  it('records a span with db.* attributes', async () => {
    await traceDbQuery('SELECT id FROM streams', 'fluxora', async () => []);

    const spans = buffer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].context.tags?.['db.system']).toBe('postgresql');
    expect(spans[0].context.tags?.['db.name']).toBe('fluxora');
    expect(spans[0].context.tags?.['db.statement']).toBe('SELECT id FROM streams');
    expect(spans[0].status).toBe('ok');
  });

  it('marks span as error and re-throws when fn throws', async () => {
    await expect(
      traceDbQuery('BAD SQL', 'fluxora', async () => { throw new Error('syntax error'); }),
    ).rejects.toThrow('syntax error');

    expect(buffer.getSpans()[0].status).toBe('error');
  });
});

describe('traceRedisCommand', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });
  });
  afterEach(() => resetTracer());

  it('returns the result of fn', async () => {
    const result = await traceRedisCommand('GET', 'session:abc', async () => 'value');
    expect(result).toBe('value');
  });

  it('records a span with db.system=redis', async () => {
    await traceRedisCommand('SET', 'dedup:xyz', async () => 'OK');

    const spans = buffer.getSpans();
    expect(spans[0].context.tags?.['db.system']).toBe('redis');
    expect(spans[0].context.tags?.['db.operation']).toBe('SET');
    expect(spans[0].context.tags?.['db.redis.key']).toBe('dedup:xyz');
    expect(spans[0].status).toBe('ok');
  });

  it('re-throws errors', async () => {
    await expect(
      traceRedisCommand('GET', 'k', async () => { throw new Error('ECONNREFUSED'); }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('traceStellarRpc', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });
  });
  afterEach(() => resetTracer());

  it('returns the result of fn', async () => {
    const result = await traceStellarRpc('getLatestLedger', async () => ({ sequence: 100 }));
    expect(result).toEqual({ sequence: 100 });
  });

  it('records a span with rpc.* attributes', async () => {
    await traceStellarRpc('getTransaction', async () => ({}));

    const spans = buffer.getSpans();
    expect(spans[0].context.tags?.['rpc.system']).toBe('stellar');
    expect(spans[0].context.tags?.['rpc.method']).toBe('getTransaction');
    expect(spans[0].status).toBe('ok');
  });

  it('marks span as error when RPC throws', async () => {
    await expect(
      traceStellarRpc('getLatestLedger', async () => { throw new Error('circuit open'); }),
    ).rejects.toThrow('circuit open');

    expect(buffer.getSpans()[0].status).toBe('error');
  });
});

describe('traceWebhookDispatch', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });
  });
  afterEach(() => resetTracer());

  it('returns the result of fn', async () => {
    const result = await traceWebhookDispatch('stream.created', 'https://example.com/hook', 0, async () => 'sent');
    expect(result).toBe('sent');
  });

  it('records a span with webhook.* attributes', async () => {
    await traceWebhookDispatch('stream.updated', 'https://example.com/hook', 2, async () => {});

    const spans = buffer.getSpans();
    expect(spans[0].context.tags?.['webhook.event']).toBe('stream.updated');
    expect(spans[0].context.tags?.['webhook.url']).toBe('https://example.com/hook');
    expect(spans[0].context.tags?.['webhook.retry']).toBe(2);
    expect(spans[0].status).toBe('ok');
  });

  it('marks span as error when dispatch throws', async () => {
    await expect(
      traceWebhookDispatch('stream.created', 'https://x.com', 3, async () => { throw new Error('network error'); }),
    ).rejects.toThrow('network error');

    expect(buffer.getSpans()[0].status).toBe('error');
  });
});

describe('traceSseDispatch', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });
  });
  afterEach(() => resetTracer());

  it('returns the result of fn', () => {
    const result = traceSseDispatch('stream-1', 'evt-1', 2, 'corr-1', () => 'sent');
    expect(result).toBe('sent');
  });

  it('records a span with sse.* attributes', () => {
    traceSseDispatch('stream-1', 'evt-1', 2, 'corr-1', () => {});

    const spans = buffer.getSpans();
    expect(spans[0].context.traceId).toBe('corr-1');
    expect(spans[0].context.tags?.['sse.stream_id']).toBe('stream-1');
    expect(spans[0].context.tags?.['sse.event_id']).toBe('evt-1');
    expect(spans[0].context.tags?.['sse.subscriber_count']).toBe(2);
    expect(spans[0].status).toBe('ok');
  });

  it('marks span as error when fan-out throws', () => {
    expect(() => traceSseDispatch('stream-1', 'evt-1', 2, 'corr-1', () => {
      throw new Error('write failed');
    })).toThrow('write failed');

    expect(buffer.getSpans()[0].status).toBe('error');
  });
});

describe('recordWsBroadcast', () => {
  it('is a no-op when there is no active OTel span', () => {
    expect(() => recordWsBroadcast('stream-1', 'evt-1', 5)).not.toThrow();
  });
});

describe('helpers with tracing disabled', () => {
  beforeEach(() => {
    resetTracer();
    initializeTracer({ enabled: false });
  });
  afterEach(() => resetTracer());

  it('traceDbQuery still returns fn result when tracing is disabled', async () => {
    const result = await traceDbQuery('SELECT 1', 'db', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('traceStellarRpc still returns fn result when tracing is disabled', async () => {
    const result = await traceStellarRpc('getLatestLedger', async () => 99);
    expect(result).toBe(99);
  });

  it('traceWebhookDispatch still returns fn result when tracing is disabled', async () => {
    const result = await traceWebhookDispatch('stream.created', 'https://x.com', 0, async () => true);
    expect(result).toBe(true);
  });

  it('traceSseDispatch still returns fn result when tracing is disabled', () => {
    const result = traceSseDispatch('stream-1', 'evt-1', 0, undefined, () => true);
    expect(result).toBe(true);
  });
});
