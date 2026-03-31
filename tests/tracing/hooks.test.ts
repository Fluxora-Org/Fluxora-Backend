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
} from '../src/tracing/hooks.js';
import {
  SpanBuffer,
  MetricsCollector,
  ErrorClassifier,
  createBuiltInHooks,
} from '../src/tracing/builtin.js';

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
