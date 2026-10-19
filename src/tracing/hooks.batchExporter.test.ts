import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchSpanExporter, createBatchSpanExporter, type Span } from './hooks.js';

function createSpan(id: string): Span {
  return {
    context: { traceId: `trace-${id}`, spanId: `span-${id}` },
    startTimeMs: 0,
    endTimeMs: 1,
    durationMs: 1,
    status: 'ok',
    events: [],
  };
}

describe('BatchSpanExporter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an exporter through the factory and flushes buffered spans', async () => {
    const exportHandler = vi.fn();
    const exporter = createBatchSpanExporter({
      maxBatchSize: 2,
      scheduledDelayMs: 0,
      exportHandler,
    });
    const first = createSpan('first');
    const second = createSpan('second');

    exporter.onSpanEnd(first);
    exporter.onSpanEnd(second);

    await exporter.flush();

    expect(exportHandler).toHaveBeenCalledOnce();
    expect(exportHandler).toHaveBeenCalledWith([first, second]);
    expect(exporter.getMetrics()).toMatchObject({
      spansEnqueued: 2,
      spansExported: 2,
      flushesTriggered: 1,
      queueLength: 0,
      isShutdown: false,
    });
  });

  it('leaves an empty queue unchanged when flushed', async () => {
    const exportHandler = vi.fn();
    const exporter = new BatchSpanExporter({ exportHandler });

    await exporter.flush();

    expect(exportHandler).not.toHaveBeenCalled();
    expect(exporter.getMetrics()).toMatchObject({
      spansEnqueued: 0,
      spansExported: 0,
      flushesTriggered: 0,
      queueLength: 0,
    });
  });

  it('flushes exactly at the configured batch and queue limits', () => {
    const exportHandler = vi.fn();
    const exporter = new BatchSpanExporter({
      maxBatchSize: 3,
      maxQueueSize: 3,
      scheduledDelayMs: 0,
      exportHandler,
    });
    const spans = [createSpan('one'), createSpan('two'), createSpan('three')];

    exporter.onSpanEnd(spans[0]);
    exporter.onSpanEnd(spans[1]);
    expect(exportHandler).not.toHaveBeenCalled();
    expect(exporter.getMetrics().queueLength).toBe(2);

    exporter.onSpanEnd(spans[2]);

    expect(exportHandler).toHaveBeenCalledOnce();
    expect(exportHandler).toHaveBeenCalledWith(spans);
    expect(exporter.getMetrics()).toMatchObject({
      spansEnqueued: 3,
      spansExported: 3,
      overflowDirectExports: 0,
      queueLength: 0,
    });
  });

  it('does not schedule a timer when the configured delay is zero', async () => {
    vi.useFakeTimers();
    const exportHandler = vi.fn();
    const exporter = new BatchSpanExporter({
      maxBatchSize: 2,
      scheduledDelayMs: 0,
      exportHandler,
    });

    exporter.onSpanEnd(createSpan('manual-flush'));

    expect(vi.getTimerCount()).toBe(0);
    expect(exportHandler).not.toHaveBeenCalled();

    await exporter.flush();

    expect(exportHandler).toHaveBeenCalledOnce();
  });

  it('directly exports every span when the queue capacity is zero', () => {
    const exportHandler = vi.fn();
    const exporter = new BatchSpanExporter({
      maxQueueSize: 0,
      scheduledDelayMs: 0,
      exportHandler,
    });
    const span = createSpan('zero-capacity');

    exporter.onSpanEnd(span);

    expect(exportHandler).toHaveBeenCalledWith([span]);
    expect(exporter.getMetrics()).toMatchObject({
      spansEnqueued: 0,
      spansExported: 1,
      overflowDirectExports: 1,
      queueLength: 0,
    });
  });

  it('resets queued spans, pending timers, and metrics', () => {
    vi.useFakeTimers();
    const exporter = new BatchSpanExporter({
      maxBatchSize: 2,
      scheduledDelayMs: 100,
      exportHandler: vi.fn(),
    });

    exporter.onSpanEnd(createSpan('before-reset'));
    expect(vi.getTimerCount()).toBe(1);

    exporter.reset();

    expect(vi.getTimerCount()).toBe(0);
    expect(exporter.getMetrics()).toMatchObject({
      spansEnqueued: 0,
      spansExported: 0,
      spansDropped: 0,
      flushesTriggered: 0,
      overflowDirectExports: 0,
      exportFailures: 0,
      queueLength: 0,
      isShutdown: false,
    });

    exporter.onSpanEnd(createSpan('after-reset'));
    expect(exporter.getMetrics().queueLength).toBe(1);
  });

  it('records synchronous and asynchronous export failures without rejecting flush', async () => {
    const syncFailure = new BatchSpanExporter({
      maxBatchSize: 1,
      exportHandler: () => {
        throw new Error('sync failure');
      },
    });
    const asyncFailure = new BatchSpanExporter({
      scheduledDelayMs: 0,
      exportHandler: async () => {
        throw new Error('async failure');
      },
    });

    expect(() => syncFailure.onSpanEnd(createSpan('sync-failure'))).not.toThrow();
    await expect(syncFailure.flush()).resolves.toBeUndefined();
    asyncFailure.onSpanEnd(createSpan('async-failure'));
    await expect(asyncFailure.flush()).resolves.toBeUndefined();

    expect(syncFailure.getMetrics().exportFailures).toBe(1);
    expect(asyncFailure.getMetrics().exportFailures).toBe(1);
  });
});
