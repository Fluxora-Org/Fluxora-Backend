/**
 * Built-in Tracer Hooks: Default implementations for tracing observability.
 *
 * Provides a simple in-memory tracer that:
 * - Buffers recent spans for debugging and metrics
 * - Logs structured events for operational visibility
 * - Integrates with existing PII-safe logging
 *
 * No external dependencies; suitable for development and small deployments.
 * For production, operators should configure custom hooks (e.g., Jaeger, Datadog).
 *
 * Failure modes:
 * - If buffer fills, oldest spans are dropped (configurable)
 * - If logging fails, errors are silent (never propagates)
 * - Memory is bounded by maxSpans config
 */

import { Span, SpanEvent, TracerHooks, SpanContext } from './hooks.js';

/**
 * In-memory span buffer configuration.
 */
export interface SpanBufferConfig {
  /** Maximum spans to keep in memory. Oldest are dropped when full. */
  maxSpans?: number;

  /** Enable logging of span events to structured logs. */
  logEvents?: boolean;

  /** Log level for emitted events ('debug', 'info', 'warn', 'error'). */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Built-in span buffer: stores recent spans in-memory.
 * Useful for debugging, metrics collection, and operational dashboards.
 */
export class SpanBuffer implements TracerHooks {
  private spans: Span[] = [];
  private config: SpanBufferConfig;

  constructor(config: SpanBufferConfig = {}) {
    this.config = {
      maxSpans: 1000,
      logEvents: true,
      logLevel: 'debug',
      ...config,
    };
  }

  onSpanStart(span: Span): void {
    // Store span in buffer
    this.spans.push(span);

    // Trim buffer if it exceeds max
    if (this.spans.length > (this.config.maxSpans ?? 1000)) {
      this.spans.shift();
    }

    // Log span start if configured
    if (this.config.logEvents) {
      this.logEvent('span.start', {
        traceId: span.context.traceId,
        spanId: span.context.spanId,
        parent: span.context.parentSpanId,
        userId: span.context.userId,
        tags: JSON.stringify(span.context.tags),
      });
    }
  }

  onSpanEnd(span: Span): void {
    // Span already in buffer from onSpanStart
    // Log span end if configured
    if (this.config.logEvents) {
      this.logEvent('span.end', {
        traceId: span.context.traceId,
        spanId: span.context.spanId,
        status: span.status,
        durationMs: span.durationMs,
        eventCount: span.events.length,
      });
    }
  }

  onEvent(span: Span, event: SpanEvent): void {
    // Log event if configured
    if (this.config.logEvents) {
      this.logEvent(`event.${event.name}`, {
        traceId: span.context.traceId,
        spanId: span.context.spanId,
        ...event.attributes,
      });
    }
  }

  onError(correlationId: string, error: Error, context?: Record<string, unknown>): void {
    // Log error if configured
    if (this.config.logEvents) {
      this.logEvent('error.recorded', {
        correlationId,
        errorName: error.name,
        errorMessage: error.message,
        ...context,
      });
    }
  }

  /**
   * Get all buffered spans.
   */
  getSpans(): Span[] {
    return this.spans.slice();
  }

  /**
   * Get spans for a specific trace.
   */
  getSpansByTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.context.traceId === traceId);
  }

  /**
   * Get recently completed spans (useful for metrics).
   */
  getRecentSpans(limitMs: number = 60000): Span[] {
    const cutoff = Date.now() - limitMs;
    return this.spans.filter(
      (s) => s.endTimeMs && s.endTimeMs >= cutoff
    );
  }

  /**
   * Get span metrics for operational dashboards.
   */
  getMetrics(): {
    totalSpans: number;
    pendingSpans: number;
    okSpans: number;
    errorSpans: number;
    avgDurationMs: number;
    maxDurationMs: number;
    minDurationMs: number;
  } {
    const completed = this.spans.filter((s) => s.endTimeMs !== undefined);
    const durations = completed
      .map((s) => s.durationMs ?? 0)
      .filter((d) => d > 0);

    return {
      totalSpans: this.spans.length,
      pendingSpans: this.spans.filter((s) => s.status === 'pending').length,
      okSpans: this.spans.filter((s) => s.status === 'ok').length,
      errorSpans: this.spans.filter((s) => s.status === 'error').length,
      avgDurationMs:
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0,
      maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      minDurationMs: durations.length > 0 ? Math.min(...durations) : 0,
    };
  }

  /**
   * Clear all buffered spans (for testing).
   */
  clear(): void {
    this.spans = [];
  }

  /**
   * Log an event using structured JSON (compatible with existing logger).
   */
  private logEvent(name: string, attributes: Record<string, unknown>): void {
    try {
      const level = this.config.logLevel ?? 'debug';
      const message = `[tracing] ${name}`;
      const record = {
        level,
        timestamp: new Date().toISOString(),
        message,
        ...attributes,
      };

      if (level === 'error') {
        console.error(JSON.stringify(record));
      } else {
        console.log(JSON.stringify(record));
      }
    } catch (err) {
      // Logging error; silent failure
    }
  }
}

/**
 * Collector: aggregates metrics from spans in real-time.
 * Useful for Prometheus-style metric export.
 */
export class MetricsCollector implements TracerHooks {
  private metrics = {
    requestsStarted: 0,
    requestsCompleted: 0,
    requestsErrored: 0,
    totalDurationMs: 0,
    dbQueriesExecuted: 0,
    apiCallsMade: 0,
    authFailures: 0,
  };

  onSpanStart(span: Span): void {
    if (span.context.tags?.['http.method']) {
      this.metrics.requestsStarted++;
    }
  }

  onSpanEnd(span: Span): void {
    if (span.context.tags?.['http.method']) {
      this.metrics.requestsCompleted++;
      if (span.status === 'error') {
        this.metrics.requestsErrored++;
      }
      if (span.durationMs) {
        this.metrics.totalDurationMs += span.durationMs;
      }
    }
  }

  onEvent(span: Span, event: SpanEvent): void {
    switch (event.name) {
      case 'db.query':
        this.metrics.dbQueriesExecuted++;
        break;
      case 'api.call':
        this.metrics.apiCallsMade++;
        break;
      case 'auth.failure':
        this.metrics.authFailures++;
        break;
    }
  }

  onError(): void {
    // Error tracking handled by onSpanEnd
  }

  /**
   * Get current metrics.
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Reset metrics (for testing).
   */
  reset(): void {
    this.metrics = {
      requestsStarted: 0,
      requestsCompleted: 0,
      requestsErrored: 0,
      totalDurationMs: 0,
      dbQueriesExecuted: 0,
      apiCallsMade: 0,
      authFailures: 0,
    };
  }
}

/**
 * Error Classifier: categorizes errors for observability.
 * Helps operators understand error modes and trends.
 */
export class ErrorClassifier {
  /**
   * Classify an error for observability purposes.
   * Returns a tuple of [category, subcategory].
   */
  static classify(error: Error): [string, string] {
    const name = error.name;
    const message = error.message.toLowerCase();

    // Database errors
    if (
      name.includes('Database') ||
      name.includes('SQL') ||
      message.includes('database') ||
      message.includes('sql')
    ) {
      if (message.includes('timeout')) {
        return ['database', 'timeout'];
      }
      if (message.includes('connection')) {
        return ['database', 'connection'];
      }
      if (message.includes('constraint')) {
        return ['database', 'constraint'];
      }
      return ['database', 'other'];
    }

    // Authentication errors
    if (
      name.includes('Auth') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('invalid token')
    ) {
      return ['auth', 'failure'];
    }

    // API / RPC errors
    if (
      name.includes('RPC') ||
      message.includes('stellar') ||
      message.includes('horizon')
    ) {
      if (message.includes('timeout')) {
        return ['api', 'timeout'];
      }
      if (message.includes('not found')) {
        return ['api', 'not_found'];
      }
      return ['api', 'error'];
    }

    // Validation errors
    if (
      name.includes('Validation') ||
      name.includes('Zod') ||
      message.includes('invalid')
    ) {
      return ['validation', 'failure'];
    }

    // Default
    return ['unknown', name];
  }
}

/**
 * Create a built-in tracer hook chain.
 * Combines SpanBuffer, MetricsCollector, and other handlers.
 */
export function createBuiltInHooks(config: {
  enableBuffer?: boolean;
  enableMetrics?: boolean;
  bufferConfig?: SpanBufferConfig;
}): TracerHooks {
  const handlers: TracerHooks[] = [];

  if (config.enableBuffer !== false) {
    handlers.push(new SpanBuffer(config.bufferConfig));
  }

  if (config.enableMetrics !== false) {
    handlers.push(new MetricsCollector());
  }

  return {
    onSpanStart(span: Span): void {
      handlers.forEach((h) => {
        try {
          h.onSpanStart?.(span);
        } catch (err) {
          // Silent failure
        }
      });
    },
    onSpanEnd(span: Span): void {
      handlers.forEach((h) => {
        try {
          h.onSpanEnd?.(span);
        } catch (err) {
          // Silent failure
        }
      });
    },
    onEvent(span: Span, event: SpanEvent): void {
      handlers.forEach((h) => {
        try {
          h.onEvent?.(span, event);
        } catch (err) {
          // Silent failure
        }
      });
    },
    onError(correlationId: string, error: Error, context?: Record<string, unknown>): void {
      handlers.forEach((h) => {
        try {
          h.onError?.(correlationId, error, context);
        } catch (err) {
          // Silent failure
        }
      });
    },
  };
}
