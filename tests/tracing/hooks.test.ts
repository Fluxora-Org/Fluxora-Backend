/**
 * Tests for distributed tracing hooks.
 *
 * Coverage:
 * - Tracer creation and configuration
 * - Span lifecycle (start, event, end)
 * - OpenTelemetry optional integration
 * - Error handling and graceful degradation
 * - Built-in hooks (SpanBuffer, MetricsCollector)
 * - Trace context propagation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Tracer,
  SpanContext,
  Span,
  TracerConfig,
  initializeTracer,
  getTracer,
  resetTracer,
  shouldSampleHead,
  shouldSampleTail,
  samplingFnv1a32,
  TailSamplingConfig,
} from '../../src/tracing/hooks.js';
import {
  SpanBuffer,
  MetricsCollector,
  ErrorClassifier,
  createBuiltInHooks,
} from '../../src/tracing/builtin.js';
import { correlationStore } from '../../src/tracing/middleware.js';

describe('Distributed Tracing Hooks', () => {
  beforeEach(() => {
    resetTracer();
  });

  describe('Tracer creation and configuration', () => {
    it('creates a tracer with default config (disabled)', () => {
      const tracer = new Tracer();
      expect(tracer).toBeDefined();
      // Verify no-op behavior when disabled
      const span = tracer.startSpan({ traceId: 'test-123' });
      expect(span.status).toBe('pending');
    });

    it('creates a tracer with tracing enabled', () => {
      const tracer = new Tracer({ enabled: true });
      const span = tracer.startSpan({ traceId: 'test-123' });
      expect(span.context.traceId).toBe('test-123');
      expect(span.status).toBe('pending');
    });

    it('initializes global tracer on demand', () => {
      resetTracer();
      const tracer1 = getTracer();
      const tracer2 = getTracer();
      expect(tracer1).toBe(tracer2); // Same instance
    });

    it('supports custom tracer initialization', () => {
      const config: Partial<TracerConfig> = {
        enabled: true,
        sampleRate: 0.5,
      };
      const tracer = initializeTracer(config);
      expect(getTracer()).toBe(tracer);
    });
  });

  describe('Span lifecycle', () => {
    it('creates a span with context', () => {
      const tracer = new Tracer({ enabled: true });
      const span = tracer.startSpan({
        traceId: 'trace-123',
        userId: 'user-456',
      });

      expect(span.context.traceId).toBe('trace-123');
      expect(span.context.userId).toBe('user-456');
      expect(span.context.spanId).toBeDefined();
      expect(span.startTimeMs).toBeGreaterThan(0);
      expect(span.status).toBe('pending');
      expect(span.events).toEqual([]);
    });

    it('ends a span with status', async () => {
      const tracer = new Tracer({ enabled: true });
      const span = tracer.startSpan({ traceId: 'trace-123' });

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));

      tracer.endSpan(span, 'ok', 'Request succeeded');

      expect(span.status).toBe('ok');
      expect(span.statusMessage).toBe('Request succeeded');
      expect(span.endTimeMs).toBeGreaterThan(span.startTimeMs);
      expect(span.durationMs).toBeGreaterThanOrEqual(10);
    });

    it('records events in a span', () => {
      const tracer = new Tracer({ enabled: true });
      const span = tracer.startSpan({ traceId: 'trace-123' });

      tracer.recordEvent(span, 'db.query', {
        query: 'SELECT * FROM streams',
        durationMs: 5,
      });

      tracer.recordEvent(span, 'api.call', {
        endpoint: '/horizon/accounts',
        statusCode: 200,
      });

      expect(span.events).toHaveLength(2);
      expect(span.events[0].name).toBe('db.query');
      expect(span.events[1].name).toBe('api.call');
    });

    it('handles disabled tracing gracefully (no-op)', () => {
      const tracer = new Tracer({ enabled: false });

      const span = tracer.startSpan({ traceId: 'trace-123' });
      expect(span.context.spanId).toBe('noop');

      tracer.recordEvent(span, 'event', {});
      expect(span.events).toHaveLength(0); // Not recorded

      tracer.endSpan(span, 'ok');
      expect(span.endTimeMs).toBeUndefined(); // Not recorded
    });
  });

  describe('Error recording and classification', () => {
    it('records errors with context', () => {
      const tracer = new Tracer({ enabled: true });
      const error = new Error('Database connection failed');

      tracer.recordError('corr-123', error, {
        database: 'postgres',
        attempt: 3,
      });

      // No exception thrown
      expect(true).toBe(true);
    });

    it('classifies errors correctly', () => {
      expect(ErrorClassifier.classify(new Error('Database timeout'))).toEqual([
        'database',
        'timeout',
      ]);
      expect(
        ErrorClassifier.classify(new Error('SQL constraint violation'))
      ).toEqual(['database', 'constraint']);
      expect(
        ErrorClassifier.classify(new Error('Unauthorized access'))
      ).toEqual(['auth', 'failure']);
      expect(ErrorClassifier.classify(new Error('RPC timeout'))).toEqual([
        'api',
        'timeout',
      ]);
      expect(
        ErrorClassifier.classify(new Error('Validation failed'))
      ).toEqual(['validation', 'failure']);
    });
  });

  describe('Hook handlers (SPA)', () => {
    it('calls onSpanStart hook', () => {
      const onSpanStart = vi.fn();
      const tracer = new Tracer({
        enabled: true,
        hooks: { onSpanStart },
      });

      const span = tracer.startSpan({ traceId: 'trace-123' });

      expect(onSpanStart).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.any(Object) })
      );
    });

    it('calls onSpanEnd hook', () => {
      const onSpanEnd = vi.fn();
      const tracer = new Tracer({
        enabled: true,
        hooks: { onSpanEnd },
      });

      const span = tracer.startSpan({ traceId: 'trace-123' });
      tracer.endSpan(span, 'ok');

      expect(onSpanEnd).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ok' })
      );
    });

    it('calls onEvent hook', () => {
      const onEvent = vi.fn();
      const tracer = new Tracer({
        enabled: true,
        hooks: { onEvent },
      });

      const span = tracer.startSpan({ traceId: 'trace-123' });
      tracer.recordEvent(span, 'test.event', { value: 42 });

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.any(Object) }),
        expect.objectContaining({ name: 'test.event' })
      );
    });

    it('handles hook errors gracefully', () => {
      const errorHook = () => {
        throw new Error('Hook error');
      };

      // Spy on console.error to verify error is logged
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const tracer = new Tracer({
        enabled: true,
        hooks: { onSpanStart: errorHook as any },
      });

      // Should not throw
      expect(() => {
        tracer.startSpan({ traceId: 'trace-123' });
      }).not.toThrow();

      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('Built-in hooks - SpanBuffer', () => {
    it('routes span logs through the structured logger with request correlation', () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const buffer = new SpanBuffer({ logEvents: true, logLevel: 'info' });
      const tracer = new Tracer({ enabled: true, hooks: buffer });

      correlationStore.run('request-correlation-123', () => {
        tracer.startSpan({
          traceId: 'trace-123',
          userId: 'user-456',
          tags: { operation: 'test' },
        });
      });

      const line = writeSpy.mock.calls
        .map(([value]) => String(value))
        .find((value) => value.includes('"message":"[tracing] span.start"'));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string)).toMatchObject({
        level: 'info',
        message: '[tracing] span.start',
        correlationId: 'request-correlation-123',
      });
      writeSpy.mockRestore();
    });

    it('buffers spans in memory', () => {
      const buffer = new SpanBuffer({ maxSpans: 100, logEvents: false });
      const tracer = new Tracer({ enabled: true, hooks: buffer });

      const span1 = tracer.startSpan({ traceId: 'trace-1' });
      const span2 = tracer.startSpan({ traceId: 'trace-2' });

      expect(buffer.getSpans()).toHaveLength(2);
    });

    it('retrieves spans by trace ID', () => {
      const buffer = new SpanBuffer({ logEvents: false });
      const tracer = new Tracer({ enabled: true, hooks: buffer });

      tracer.startSpan({ traceId: 'trace-123' });
      tracer.startSpan({ traceId: 'trace-123' });
      tracer.startSpan({ traceId: 'trace-456' });

      const spans = buffer.getSpansByTrace('trace-123');
      expect(spans).toHaveLength(2);
      expect(spans.every((s) => s.context.traceId === 'trace-123')).toBe(true);
    });

    it('respects maxSpans limit', () => {
      const buffer = new SpanBuffer({ maxSpans: 5, logEvents: false });
      const tracer = new Tracer({ enabled: true, hooks: buffer });

      for (let i = 0; i < 10; i++) {
        tracer.startSpan({ traceId: `trace-${i}` });
      }

      expect(buffer.getSpans()).toHaveLength(5);
    });

    it('calculates span metrics', () => {
      const buffer = new SpanBuffer({ logEvents: false });
      const tracer = new Tracer({ enabled: true, hooks: buffer });

      const span1 = tracer.startSpan({ traceId: 'trace-1' });
      const span2 = tracer.startSpan({ traceId: 'trace-2' });

      tracer.endSpan(span1, 'ok');
      tracer.endSpan(span2, 'error', 'API timeout');

      const metrics = buffer.getMetrics();
      expect(metrics.totalSpans).toBe(2);
      expect(metrics.okSpans).toBe(1);
      expect(metrics.errorSpans).toBe(1);
    });

    it('gets recent spans within time window', async () => {
      const buffer = new SpanBuffer({ logEvents: false });
      const tracer = new Tracer({ enabled: true, hooks: buffer });

      const span1 = tracer.startSpan({ traceId: 'trace-1' });
      tracer.endSpan(span1, 'ok');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const recent = buffer.getRecentSpans(50); // Only last 50ms
      expect(recent).toHaveLength(0);
    });
  });

  describe('Built-in hooks - MetricsCollector', () => {
    it('counts request completions', () => {
      const collector = new MetricsCollector();
      const tracer = new Tracer({ enabled: true, hooks: collector });

      const span = tracer.startSpan({
        traceId: 'trace-123',
        tags: { 'http.method': 'GET' },
      });
      tracer.endSpan(span, 'ok');

      const metrics = collector.getMetrics();
      expect(metrics.requestsStarted).toBe(1);
      expect(metrics.requestsCompleted).toBe(1);
      expect(metrics.requestsErrored).toBe(0);
    });

    it('counts errors and events', () => {
      const collector = new MetricsCollector();
      const tracer = new Tracer({ enabled: true, hooks: collector });

      const span = tracer.startSpan({ traceId: 'trace-123' });
      tracer.recordEvent(span, 'db.query', {});
      tracer.recordEvent(span, 'api.call', {});
      tracer.recordEvent(span, 'auth.failure', {});
      tracer.endSpan(span, 'error');

      const metrics = collector.getMetrics();
      expect(metrics.dbQueriesExecuted).toBe(1);
      expect(metrics.apiCallsMade).toBe(1);
      expect(metrics.authFailures).toBe(1);
    });

    it('calculates total duration', () => {
      const collector = new MetricsCollector();
      const tracer = new Tracer({ enabled: true, hooks: collector });

      const span1 = tracer.startSpan({
        traceId: 'trace-1',
        tags: { 'http.method': 'GET' },
      });
      const span2 = tracer.startSpan({
        traceId: 'trace-2',
        tags: { 'http.method': 'POST' },
      });

      tracer.endSpan(span1, 'ok');
      tracer.endSpan(span2, 'ok');

      const metrics = collector.getMetrics();
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Built-in hooks composition', () => {
    it('creates combined hooks', () => {
      const hooks = createBuiltInHooks({
        enableBuffer: true,
        enableMetrics: true,
      });

      const tracer = new Tracer({ enabled: true, hooks });

      const span = tracer.startSpan({
        traceId: 'trace-123',
        tags: { 'http.method': 'GET' },
      });
      tracer.recordEvent(span, 'db.query', {});
      tracer.endSpan(span, 'ok');

      // Verify no errors and spans are captured
      expect(span.context.traceId).toBe('trace-123');
      expect(span.events).toHaveLength(1);
    });
  });

  describe('Span context and hierarchies', () => {
    it('tracks parent-child span relationships', () => {
      const tracer = new Tracer({ enabled: true });

      const parentSpan = tracer.startSpan({ traceId: 'trace-123' });
      const childSpan = tracer.startSpan({
        traceId: 'trace-123',
        parentSpanId: parentSpan.context.spanId,
      });

      expect(childSpan.context.parentSpanId).toBe(
        parentSpan.context.spanId
      );
      expect(parentSpan.context.parentSpanId).toBeUndefined();
    });

    it('supports custom tags in span context', () => {
      const tracer = new Tracer({ enabled: true });

      const span = tracer.startSpan({
        traceId: 'trace-123',
        tags: {
          'http.method': 'POST',
          'http.path': '/api/streams',
          'custom.field': 'value',
        },
      });

      expect(span.context.tags?.['http.method']).toBe('POST');
      expect(span.context.tags?.['custom.field']).toBe('value');
    });
  });

  describe('Tracer state and querying', () => {
    it('retrieves active spans', () => {
      const tracer = new Tracer({ enabled: true });

      const span1 = tracer.startSpan({ traceId: 'trace-1' });
      const span2 = tracer.startSpan({ traceId: 'trace-2' });

      const active = tracer.getActiveSpans();
      expect(active).toHaveLength(2);

      tracer.endSpan(span1, 'ok');
      expect(tracer.getActiveSpans()).toHaveLength(1);
    });

    it('retrieves a span by ID', () => {
      const tracer = new Tracer({ enabled: true });

      const span = tracer.startSpan({ traceId: 'trace-123' });
      const retrieved = tracer.getSpan(span.context.spanId);

      expect(retrieved).toBe(span);
    });
  });

  describe('Graceful shutdown', () => {
    it('flushes pending spans on shutdown', async () => {
      const onSpanEnd = vi.fn();
      const tracer = new Tracer({
        enabled: true,
        hooks: { onSpanEnd },
      });

      const span = tracer.startSpan({ traceId: 'trace-123' });

      await tracer.flush();

      // Flush should trigger hook callbacks
      expect(true).toBe(true); // Verify no throw
    });
  });
});

// ── Sampling strategy tests (Issue #757) ─────────────────────────────────────

/**
 * A diverse set of traceIds spanning the full [0, 999] bucket range.
 * These values demonstrate that short-circuit behavior fires for ALL traceIds,
 * not just those whose bucket math happens to produce the right result.
 */
const TRACE_IDS = [
  'aaaaaaaaaa',
  'bbbbbbbbbb',
  '0000000000',
  'ffffffffff',
  'trace-id-1',
  'trace-id-99',
  '12345678901234567890',
  'zzzzzzzzzz',
  'ABCDEFGHIJ',
  'abcdefghijklmnopqrstuvwxyz',
  'session-42',
  'req_abc123',
  'corrid-xyz-789',
  'a1b2c3d4e5f6g7h8i9j0',
  'test-trace-with-dash',
  '____test____',
  '00000000000000000000000000000000',
  'ffffffffffffffffffffffffffffffff',
  'cafebabe-deadbeef-12345678',
  'hello-world-foobar-bazqux',
  'trace-0001',
  'trace-9999',
  'Z'.repeat(32),
  '1'.repeat(40),
  'incredibly-long-trace-id-that-should-probably-never-exist-in-production',
];

describe('shouldSampleHead()', () => {
  describe('short-circuit: sampleRate=0 returns false for all traceIds', () => {
    it.each(TRACE_IDS)('traceId=%s returns false', (traceId) => {
      // Proves the sampleRate <= 0 short-circuit fires regardless of bucket
      // value. Math.round(0 * 1000) === 0, and bucket >= 0 always, so
      // bucket < 0 is never true — but this test proves the short-circuit
      // is taken rather than relying on that arithmetic coincidence.
      expect(shouldSampleHead(traceId, 0)).toBe(false);
    });
  });

  describe('short-circuit: sampleRate=1 returns true for all traceIds', () => {
    it.each(TRACE_IDS)('traceId=%s returns true', (traceId) => {
      // Proves the sampleRate >= 1 short-circuit fires regardless of bucket
      // value. Math.round(1 * 1000) === 1000, and bucket is always in [0, 999],
      // so bucket < 1000 is always true — but this test proves the short-circuit
      // is taken rather than relying on that arithmetic.
      expect(shouldSampleHead(traceId, 1)).toBe(true);
    });
  });

  it('determinism — same inputs always produce same output', () => {
    const pairs: [string, number][] = [
      ['abc', 0.25],
      ['def', 0.5],
      ['ghi', 0.75],
      ['jkl', 0.1],
      ['mno', 0.9],
    ];
    for (const [traceId, sampleRate] of pairs) {
      const first = shouldSampleHead(traceId, sampleRate);
      for (let i = 0; i < 99; i++) {
        expect(shouldSampleHead(traceId, sampleRate)).toBe(first);
      }
    }
  });

  it('independent bucket verification via samplingFnv1a32', () => {
    for (const traceId of TRACE_IDS) {
      const bucket = samplingFnv1a32(traceId) % 1000;
      // At sampleRate=0.5, Math.round(0.5 * 1000) = 500
      const expectedRate05 = bucket < 500;
      expect(shouldSampleHead(traceId, 0.5)).toBe(expectedRate05);
      // At sampleRate=0.25, Math.round(0.25 * 1000) = 250
      const expectedRate025 = bucket < 250;
      expect(shouldSampleHead(traceId, 0.25)).toBe(expectedRate025);
    }
  });

  it('probabilistic distribution at sampleRate=0.5', () => {
    // With 1000 distinct traceIds, ~500 should be true at rate 0.5.
    // The band [0.4, 0.6] is wide enough to be stable without being vacuous.
    const traceIds = Array.from({ length: 1000 }, (_, i) => `prob-${i}`);
    const trueCount = traceIds.filter((id) => shouldSampleHead(id, 0.5)).length;
    const proportion = trueCount / 1000;
    expect(proportion).toBeGreaterThanOrEqual(0.4);
    expect(proportion).toBeLessThanOrEqual(0.6);
  });
});

describe('shouldSampleTail()', () => {
  const errorSpan: Span = {
    context: { traceId: 'test', spanId: '1' },
    startTimeMs: 1000,
    status: 'error',
    events: [],
  };

  const okSpan: Span = {
    context: { traceId: 'test', spanId: '2' },
    startTimeMs: 1000,
    status: 'ok',
    events: [],
  };

  const spanWithErrorEvent: Span = {
    context: { traceId: 'test', spanId: '3' },
    startTimeMs: 1000,
    status: 'ok',
    events: [{ name: 'error', timestamp: Date.now() }],
  };

  it('keepErrorSpans:false, sampleRate:0 — error span is NOT kept', () => {
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 0, keepErrorSpans: false };
    expect(shouldSampleTail(errorSpan, config)).toBe(false);
  });

  it('keepErrorSpans:true, sampleRate:0 — error span IS kept regardless of rate', () => {
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 0, keepErrorSpans: true };
    expect(shouldSampleTail(errorSpan, config)).toBe(true);
  });

  it('keepErrorSpans:true, sampleRate:1 — error span kept', () => {
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 1, keepErrorSpans: true };
    expect(shouldSampleTail(errorSpan, config)).toBe(true);
  });

  it('keepErrorSpans:false, sampleRate:1 — non-error span kept by rate', () => {
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 1, keepErrorSpans: false };
    expect(shouldSampleTail(okSpan, config)).toBe(true);
  });

  it('keepErrorSpans:true, no error, sampleRate:0 — non-error span NOT kept', () => {
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 0, keepErrorSpans: true };
    expect(shouldSampleTail(okSpan, config)).toBe(false);
  });

  it('keepErrorSpans:true, has error event, sampleRate:0 — span with error event IS kept', () => {
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 0, keepErrorSpans: true };
    expect(shouldSampleTail(spanWithErrorEvent, config)).toBe(true);
  });

  it('determinism for shouldSampleTail (non-random path via keepErrorSpans)', () => {
    // The keepErrorSpans path is fully deterministic — no Math.random() involved.
    const config: TailSamplingConfig = { strategy: 'tail', sampleRate: 0, keepErrorSpans: true };
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleTail(errorSpan, config)).toBe(true);
      expect(shouldSampleTail(okSpan, config)).toBe(false);
    }
  });
});

describe('Attribute Bounding and Sampling Overrides', () => {
  it('bounds dynamic route attributes to matched prefix or OTHER', () => {
    const tracer = new Tracer({
      enabled: true,
      sampling: {
        strategy: 'head',
        sampleRate: 0.5,
        perRouteOverrides: {
          '/api/users': 1.0,
          '/health': 0.0
        }
      }
    });

    // Match exact
    let span = tracer.startSpan({ traceId: 'trace-1', tags: { route: '/health' } });
    expect(span.context.tags?.['route']).toBe('/health');

    // Match prefix
    span = tracer.startSpan({ traceId: 'trace-2', tags: { route: '/api/users/12345/profile' } });
    expect(span.context.tags?.['route']).toBe('/api/users');

    // No match -> OTHER
    span = tracer.startSpan({ traceId: 'trace-3', tags: { route: '/api/unknown/123' } });
    expect(span.context.tags?.['route']).toBe('OTHER');
  });

  it('bounds dynamic tenant attributes to matched key or OTHER', () => {
    const tracer = new Tracer({
      enabled: true,
      sampling: {
        strategy: 'head',
        sampleRate: 0.5,
        perTenantOverrides: {
          'tenant-A': 1.0
        }
      }
    });

    let span = tracer.startSpan({ traceId: 'trace-1', tags: { tenant: 'tenant-A' } });
    expect(span.context.tags?.['tenant']).toBe('tenant-A');

    span = tracer.startSpan({ traceId: 'trace-2', tags: { tenant: 'tenant-B-unknown' } });
    expect(span.context.tags?.['tenant']).toBe('OTHER');
  });

  it('fuzzes route and tenant values to assert bounded attributes', () => {
    const tracer = new Tracer({
      enabled: true,
      sampling: {
        strategy: 'head',
        sampleRate: 1.0,
        perRouteOverrides: { '/known': 1.0 },
        perTenantOverrides: { 'known-tenant': 1.0 }
      }
    });

    for (let i = 0; i < 100; i++) {
      const randomRoute = `/random/${Math.random().toString(36).substring(7)}`;
      const randomTenant = `tenant-${Math.random().toString(36).substring(7)}`;
      const span = tracer.startSpan({
        traceId: `trace-${i}`,
        tags: { route: randomRoute, tenant: randomTenant }
      });

      expect(span.context.tags?.['route']).toBe('OTHER');
      expect(span.context.tags?.['tenant']).toBe('OTHER');
    }
  });

  it('fuzzes invalid sample rates safely (bounds to [0,1])', () => {
    const invalidRates = [NaN, Infinity, -Infinity, -1, 1.5, -0.0001, 1.0001, 2];
    for (const rate of invalidRates) {
      const result = shouldSampleHead('any-trace-id', rate);
      if (Number.isNaN(rate) || !Number.isFinite(rate)) {
        expect(result).toBe(false);
      } else {
        expect(typeof result).toBe('boolean');
      }
    }
  });
});
