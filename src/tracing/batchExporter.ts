/**
 * Bounded in-memory batch span exporter.
 *
 * Extracted from `src/tracing/hooks.ts` in #1518 (Issue #758).
 *
 * Accumulates completed spans and flushes them to an export target handler
 * (e.g. OTLP exporter, HTTP collector, or custom logger) either on a scheduled
 * timer or when the batch size threshold (`maxBatchSize`) is reached.
 *
 * Guarantees & Resilience:
 * - **Non-blocking**: `onSpanEnd` adds spans to the queue synchronously in O(1).
 *   Exporting occurs asynchronously without blocking application request handlers.
 * - **Bounded Memory**: If the queue reaches `maxQueueSize`, excess spans fall back
 *   to immediate direct export rather than causing unbounded memory growth.
 * - **Graceful Shutdown**: `shutdown()` and `flush()` drain all queued spans before returning.
 * - **Failure-safe**: Exceptions thrown by the `exportHandler` are caught, recorded in metrics,
 *   and never leak to application code.
 */

import { traceLogError } from './traceLogger.js';
import type { Span, TracerHooks } from './types.js';

/**
 * Configuration options for the bounded batch span exporter.
 */
export interface BatchSpanExporterConfig {
  /** Maximum number of spans to buffer before triggering an automatic flush. Default: 512 */
  maxBatchSize?: number;

  /** Maximum time (ms) to wait before flushing buffered spans if maxBatchSize is not reached. Default: 5000 */
  scheduledDelayMs?: number;

  /** Maximum capacity of the buffer queue. Default: 2048 */
  maxQueueSize?: number;

  /** Export target handler invoked with a batch of spans. */
  exportHandler?: (spans: Span[]) => void | Promise<void>;

  /** Enable logging of batch export diagnostic events. Default: false */
  logEvents?: boolean;
}

/**
 * Narrow a possibly-promise export result to a promise when it is one.
 *
 * Avoids repeating the `typeof x.then === 'function'` dance at every call site
 * and keeps the cast in exactly one place.
 */
function asPromise(result: void | Promise<void>): Promise<void> | undefined {
  return result && typeof (result as Promise<void>).then === 'function'
    ? (result as Promise<void>)
    : undefined;
}

export class BatchSpanExporter implements TracerHooks {
  private config: Required<Omit<BatchSpanExporterConfig, 'exportHandler'>> & {
    exportHandler: (spans: Span[]) => void | Promise<void>;
  };
  private queue: Span[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private isShutdown = false;

  private metrics = {
    spansEnqueued: 0,
    spansExported: 0,
    spansDropped: 0,
    flushesTriggered: 0,
    overflowDirectExports: 0,
    exportFailures: 0,
  };

  constructor(config: BatchSpanExporterConfig = {}) {
    this.config = {
      maxBatchSize: config.maxBatchSize ?? 512,
      scheduledDelayMs: config.scheduledDelayMs ?? 5000,
      maxQueueSize: config.maxQueueSize ?? 2048,
      exportHandler: config.exportHandler ?? (() => {}),
      logEvents: config.logEvents ?? false,
    };
  }

  /**
   * Enqueue a completed span into the batch buffer.
   */
  onSpanEnd(span: Span): void {
    if (this.isShutdown) {
      this.directExport([span]);
      return;
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      this.metrics.overflowDirectExports++;
      this.directExport([span]);
      return;
    }

    this.queue.push(span);
    this.metrics.spansEnqueued++;

    if (this.queue.length >= this.config.maxBatchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.scheduleTimer();
    }
  }

  private scheduleTimer(): void {
    if (this.timer || this.config.scheduledDelayMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.config.scheduledDelayMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private directExport(spans: Span[]): void {
    try {
      const result = this.config.exportHandler(spans);
      const pending = asPromise(result);
      if (pending) {
        pending.catch((err) => {
          this.metrics.exportFailures++;
          this.logError('Direct export failed', err);
        });
      }
      this.metrics.spansExported += spans.length;
    } catch (err) {
      this.metrics.exportFailures++;
      this.logError('Direct export failed', err);
    }
  }

  /**
   * Finalize a span that was never explicitly ended (e.g. abandoned at shutdown).
   * Sets endTimeMs, durationMs, and marks status as 'error' with a diagnostic message
   * so downstream exporters never receive raw pending spans.
   */
  private finalizeSpan(span: Span): void {
    if (span.status === 'pending') {
      span.endTimeMs = Date.now();
      span.durationMs = span.endTimeMs - span.startTimeMs;
      span.status = 'error';
      span.statusMessage = 'flushed at shutdown: never explicitly ended';
    }
  }

  /**
   * Flush all buffered spans in batches to the export handler.
   */
  async flush(): Promise<void> {
    this.clearTimer();

    if (this.isFlushing || this.queue.length === 0) {
      return;
    }

    this.isFlushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.config.maxBatchSize);
        if (batch.length === 0) break;

        this.metrics.flushesTriggered++;
        try {
          const result = this.config.exportHandler(batch);
          const pending = asPromise(result);
          if (pending) {
            await pending;
          }
          this.metrics.spansExported += batch.length;
        } catch (err) {
          this.metrics.exportFailures++;
          this.logError('Batch export failed', err);
        }
      }
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0 && !this.timer && !this.isShutdown) {
        this.scheduleTimer();
      }
    }
  }

  /**
   * Shut down the batch exporter, flushing all remaining spans.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;
    this.clearTimer();
    await this.flush();
  }

  /**
   * Get operational metrics for observability.
   */
  getMetrics(): {
    spansEnqueued: number;
    spansExported: number;
    spansDropped: number;
    flushesTriggered: number;
    overflowDirectExports: number;
    exportFailures: number;
    queueLength: number;
    isShutdown: boolean;
  } {
    return {
      ...this.metrics,
      queueLength: this.queue.length,
      isShutdown: this.isShutdown,
    };
  }

  /**
   * Reset state and metrics (for testing).
   */
  reset(): void {
    this.clearTimer();
    this.queue = [];
    this.isFlushing = false;
    this.isShutdown = false;
    this.metrics = {
      spansEnqueued: 0,
      spansExported: 0,
      spansDropped: 0,
      flushesTriggered: 0,
      overflowDirectExports: 0,
      exportFailures: 0,
    };
  }

  private logError(msg: string, err: unknown): void {
    if (this.config.logEvents) {
      traceLogError(
        `[BatchSpanExporter] ${msg}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Factory helper to create a BatchSpanExporter instance.
 */
export function createBatchSpanExporter(config: BatchSpanExporterConfig = {}): BatchSpanExporter {
  return new BatchSpanExporter(config);
}
