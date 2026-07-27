/**
 * Unit and integration tests for Span Export Batching (Issue #758).
 *
 * Coverage:
 * - Batching spans up to size threshold (`maxBatchSize`).
 * - Scheduled timer-based flushing (`scheduledDelayMs`).
 * - Bounded queue capacity & non-blocking overflow fallback (`maxQueueSize`).
 * - Graceful shutdown and flushing (`shutdown()`, `flush()`).
 * - Error resilience (export handler failures caught and logged).
 * - Integration with Tracer and `createBuiltInHooks`.
 * - Environment variable configuration parsing (`getOTelBatchConfig`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BatchSpanExporter,
  createBatchSpanExporter,
  Tracer,
  initializeTracer,
  resetTracer,
  getTracer,
  Span,
} from '../../src/tracing/hooks.js';
import { createBuiltInHooks } from '../../src/tracing/builtin.js';
import { getOTelBatchConfig, stopTracing } from '../../src/tracing/index.js';

describe('Span Export Batching (Issue #758)', () => {
  let exporter: BatchSpanExporter;
  let exportedBatches: Span[][];
  let exportHandler: vi.Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    exportedBatches = [];
    exportHandler = vi.fn((spans: Span[]) => {
      exportedBatches.push([...spans]);
    });
    exporter = new BatchSpanExporter({
      maxBatchSize: 5,
      scheduledDelayMs: 1000,
      maxQueueSize: 10,
      exportHandler,
      logEvents: false,
    });
  });

  afterEach(() => {
    exporter.reset();
    vi.useRealTimers();
    resetTracer();
  });

  const createDummySpan = (id: string): Span => ({
    context: { traceId: `trace-${id}`, spanId: `span-${id}` },
    startTimeMs: Date.now(),
    endTimeMs: Date.now() + 10,
    durationMs: 10,
    status: 'ok',
    events: [],
  });

  // ── 1. Size Threshold Batching ─────────────────────────────────────────────

  describe('Batching by Size Threshold (maxBatchSize)', () => {
    it('buffers spans without exporting until maxBatchSize is reached', () => {
      exporter.onSpanEnd(createDummySpan('1'));
      exporter.onSpanEnd(createDummySpan('2'));
      exporter.onSpanEnd(createDummySpan('3'));
      exporter.onSpanEnd(createDummySpan('4'));

      expect(exportHandler).not.toHaveBeenCalled();
      expect(exporter.getMetrics().queueLength).toBe(4);

      // 5th span hits maxBatchSize=5, triggering immediate flush
      exporter.onSpanEnd(createDummySpan('5'));

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0]).toHaveLength(5);
      expect(exporter.getMetrics().queueLength).toBe(0);
      expect(exporter.getMetrics().spansExported).toBe(5);
      expect(exporter.getMetrics().flushesTriggered).toBe(1);
    });

    it('flushes multiple consecutive full batches', () => {
      for (let i = 1; i <= 12; i++) {
        exporter.onSpanEnd(createDummySpan(String(i)));
      }

      // Should have flushed 2 full batches of 5 spans immediately
      expect(exportHandler).toHaveBeenCalledTimes(2);
      expect(exportedBatches[0]).toHaveLength(5);
      expect(exportedBatches[1]).toHaveLength(5);
      expect(exporter.getMetrics().queueLength).toBe(2);
      expect(exporter.getMetrics().spansExported).toBe(10);
    });
  });

  // ── 2. Timer-Based Flushing ───────────────────────────────────────────────

  describe('Scheduled Timer Flushing (scheduledDelayMs)', () => {
    it('flushes buffered spans after scheduledDelayMs expires', () => {
      exporter.onSpanEnd(createDummySpan('1'));
      exporter.onSpanEnd(createDummySpan('2'));

      expect(exportHandler).not.toHaveBeenCalled();

      // Advance time past scheduledDelayMs (1000ms)
      vi.advanceTimersByTime(1001);

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0]).toHaveLength(2);
      expect(exporter.getMetrics().queueLength).toBe(0);
      expect(exporter.getMetrics().spansExported).toBe(2);
    });

    it('cancels timer and reschedules when queue is drained', async () => {
      exporter.onSpanEnd(createDummySpan('1'));
      vi.advanceTimersByTime(500);

      // Explicit flush drains queue
      await exporter.flush();
      expect(exportHandler).toHaveBeenCalledTimes(1);

      // Advance timer to 1000ms — timer should not flush empty queue again
      vi.advanceTimersByTime(600);
      expect(exportHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. Queue Capacity & Overflow Fallback ──────────────────────────────────

  describe('Bounded Queue & Overflow Handling (maxQueueSize)', () => {
    it('falls back to non-blocking direct export when maxQueueSize is reached', () => {
      const smallExporter = new BatchSpanExporter({
        maxBatchSize: 10,
        maxQueueSize: 3,
        scheduledDelayMs: 5000,
        exportHandler,
      });

      // Fill queue up to maxQueueSize=3
      smallExporter.onSpanEnd(createDummySpan('1'));
      smallExporter.onSpanEnd(createDummySpan('2'));
      smallExporter.onSpanEnd(createDummySpan('3'));

      expect(smallExporter.getMetrics().queueLength).toBe(3);
      expect(exportHandler).not.toHaveBeenCalled();

      // 4th span exceeds queue capacity — falls back to direct export
      smallExporter.onSpanEnd(createDummySpan('4'));

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0]).toHaveLength(1);
      expect(exportedBatches[0][0].context.spanId).toBe('span-4');
      expect(smallExporter.getMetrics().queueLength).toBe(3);
      expect(smallExporter.getMetrics().overflowDirectExports).toBe(1);
    });
  });

  // ── 4. Graceful Shutdown & Flushing ───────────────────────────────────────

  describe('Graceful Shutdown & Flushing', () => {
    it('flushes all remaining buffered spans on shutdown()', async () => {
      exporter.onSpanEnd(createDummySpan('1'));
      exporter.onSpanEnd(createDummySpan('2'));
      exporter.onSpanEnd(createDummySpan('3'));

      expect(exportHandler).not.toHaveBeenCalled();

      await exporter.shutdown();

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0]).toHaveLength(3);
      expect(exporter.getMetrics().queueLength).toBe(0);
      expect(exporter.getMetrics().isShutdown).toBe(true);
    });

    it('directly exports spans ending after shutdown() has been called', async () => {
      await exporter.shutdown();
      expect(exportHandler).not.toHaveBeenCalled();

      exporter.onSpanEnd(createDummySpan('post-shutdown'));

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0][0].context.spanId).toBe('span-post-shutdown');
    });

    it('is idempotent on multiple shutdown() calls', async () => {
      exporter.onSpanEnd(createDummySpan('1'));
      await exporter.shutdown();
      await exporter.shutdown();

      expect(exportHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── 5. Error Resilience ────────────────────────────────────────────────────

  describe('Error Resilience & Safety', () => {
    it('catches export handler errors without propagating or breaking caller', async () => {
      const failingHandler = vi.fn(() => {
        throw new Error('OTLP Exporter network error');
      });

      const failingExporter = new BatchSpanExporter({
        maxBatchSize: 2,
        exportHandler: failingHandler,
        logEvents: true,
      });

      // Ending spans triggers flush on failingHandler
      expect(() => {
        failingExporter.onSpanEnd(createDummySpan('1'));
        failingExporter.onSpanEnd(createDummySpan('2'));
      }).not.toThrow();

      await failingExporter.flush();

      expect(failingExporter.getMetrics().exportFailures).toBeGreaterThanOrEqual(1);
    });

    it('handles async export handler rejections safely', async () => {
      const asyncFailingHandler = vi.fn(async () => {
        throw new Error('Async network failure');
      });

      const asyncFailingExporter = new BatchSpanExporter({
        maxBatchSize: 2,
        exportHandler: asyncFailingHandler,
      });

      asyncFailingExporter.onSpanEnd(createDummySpan('1'));
      asyncFailingExporter.onSpanEnd(createDummySpan('2'));

      await expect(asyncFailingExporter.flush()).resolves.toBeUndefined();
      expect(asyncFailingExporter.getMetrics().exportFailures).toBe(1);
    });
  });

  // ── 6. Tracer & BuiltInHooks Integration ───────────────────────────────────

  describe('Tracer & createBuiltInHooks Integration', () => {
    it('integrates BatchSpanExporter via createBuiltInHooks', async () => {
      const hooks = createBuiltInHooks({
        enableBuffer: false,
        enableMetrics: false,
        enableBatching: true,
        batchConfig: {
          maxBatchSize: 2,
          exportHandler,
        },
      });

      const tracer = new Tracer({
        enabled: true,
        hooks,
      });

      const s1 = tracer.startSpan({ traceId: 't1' });
      tracer.endSpan(s1);

      expect(exportHandler).not.toHaveBeenCalled();

      const s2 = tracer.startSpan({ traceId: 't2' });
      tracer.endSpan(s2);

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0]).toHaveLength(2);
    });

    it('flushes batch exporter when tracer.flush() is called', async () => {
      const batchExp = createBatchSpanExporter({
        maxBatchSize: 10,
        exportHandler,
      });

      const tracer = new Tracer({
        enabled: true,
        hooks: batchExp,
      });

      const s1 = tracer.startSpan({ traceId: 't1' });
      tracer.endSpan(s1);

      expect(exportHandler).not.toHaveBeenCalled();

      await tracer.flush();

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0]).toHaveLength(1);
    });
  });

  // ── 7. OTel Batch Config Parsing ──────────────────────────────────────────

  describe('OTel Batch Config Environment Parsing (getOTelBatchConfig)', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    });

    it('returns default values when environment variables are unset', () => {
      delete process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE;
      delete process.env.OTEL_BSP_SCHEDULED_DELAY_MILLIS;
      delete process.env.OTEL_BSP_MAX_QUEUE_SIZE;
      delete process.env.TRACING_BATCH_MAX_SIZE;
      delete process.env.TRACING_BATCH_TIMEOUT_MS;
      delete process.env.TRACING_BATCH_QUEUE_SIZE;

      const config = getOTelBatchConfig();
      expect(config.maxExportBatchSize).toBe(512);
      expect(config.scheduledDelayMillis).toBe(5000);
      expect(config.maxQueueSize).toBe(2048);
    });

    it('parses OTEL_BSP_* environment variables correctly', () => {
      process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '100';
      process.env.OTEL_BSP_SCHEDULED_DELAY_MILLIS = '1000';
      process.env.OTEL_BSP_MAX_QUEUE_SIZE = '500';

      const config = getOTelBatchConfig();
      expect(config.maxExportBatchSize).toBe(100);
      expect(config.scheduledDelayMillis).toBe(1000);
      expect(config.maxQueueSize).toBe(500);
    });

    it('falls back to TRACING_BATCH_* environment variables', () => {
      delete process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE;
      process.env.TRACING_BATCH_MAX_SIZE = '250';
      process.env.TRACING_BATCH_TIMEOUT_MS = '2000';
      process.env.TRACING_BATCH_QUEUE_SIZE = '1000';

      const config = getOTelBatchConfig();
      expect(config.maxExportBatchSize).toBe(250);
      expect(config.scheduledDelayMillis).toBe(2000);
      expect(config.maxQueueSize).toBe(1000);
    });

    it('falls back to default values when env vars are non-numeric or invalid', () => {
      process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = 'invalid';
      process.env.OTEL_BSP_SCHEDULED_DELAY_MILLIS = '-5';

      const config = getOTelBatchConfig();
      expect(config.maxExportBatchSize).toBe(512);
      expect(config.scheduledDelayMillis).toBe(5000);
    });
  });

  // ── 8. Shutdown & stopTracing Integration ─────────────────────────────────

  describe('stopTracing Integration', () => {
    it('stopTracing flushes global tracer', async () => {
      const batchExp = createBatchSpanExporter({
        maxBatchSize: 10,
        exportHandler,
      });

      resetTracer();
      const tracer = initializeTracer({ enabled: true, hooks: batchExp });

      const span = tracer.startSpan({ traceId: 'shutdown-trace' });
      tracer.endSpan(span);

      expect(exportHandler).not.toHaveBeenCalled();

      await stopTracing();

      expect(exportHandler).toHaveBeenCalledTimes(1);
      expect(exportedBatches[0][0].context.traceId).toBe('shutdown-trace');
    });
  });
});
