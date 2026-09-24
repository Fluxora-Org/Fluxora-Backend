/**
 * Core distributed tracer.
 *
 * Extracted from `src/tracing/hooks.ts` in #1518. This module owns span
 * lifecycle only — creating, ending, annotating, and flushing spans, plus the
 * process-wide tracer instance. Subsystem-specific instrumentation lives in
 * `src/tracing/otelHooks.ts`, export batching in `src/tracing/batchExporter.ts`,
 * and the OpenTelemetry adapter in `src/tracing/otelBridge.ts`.
 *
 * Design principles (unchanged by the split):
 * - Optional: tracing can be disabled with zero overhead
 * - Hook-based: callers emit events, handlers process them
 * - Observable: explicit state transitions, auth failures, duration tracking
 * - Failure-safe: tracing failures don't impact application logic
 * - PII-aware: integrates with existing PII sanitization
 */

import { redactKeysInString, sanitize, sanitizeError } from '../pii/sanitizer.js';
import { resolvePerRouteOverride, shouldSampleHead, shouldSampleTail } from './sampling.js';
import { endOtelSpan, recordOtelEvent, resolveOtelTracer, startOtelSpan } from './otelBridge.js';
import { traceLogError } from './traceLogger.js';
import {
  DEFAULT_TRACER_CONFIG,
  type Span,
  type SpanContext,
  type SpanEvent,
  type TracerConfig,
} from './types.js';

/**
 * Tracer: the main interface for emitting trace events.
 *
 * Thread-safe. All methods are no-ops if tracing is disabled.
 */
export class Tracer {
  private config: TracerConfig;
  private activeSpans: Map<string, Span> = new Map();
  private spanIdCounter: number = 0;
  // OpenTelemetry Tracer, if enabled.  Typed as `unknown` so we can defer all
  // shape-checking to the OTel bridge — the OTel SDK is an optional
  // dependency and may be absent at runtime.
  private otelTracer: unknown;

  constructor(config: Partial<TracerConfig> = {}) {
    this.config = { ...DEFAULT_TRACER_CONFIG, ...config };
    this.initializeOtel();
  }

  /**
   * Initialize OpenTelemetry if configured.
   */
  private initializeOtel(): void {
    if (!this.config.enabled || !this.config.otel?.enabled) {
      return;
    }

    this.otelTracer = resolveOtelTracer(
      this.config.otel.tracerProvider,
      this.config.otel.instrumentationName || 'fluxora-backend'
    );
  }

  /**
   * Create a new span with the given context.
   */
  startSpan(context: Omit<SpanContext, 'spanId'>): Span {
    if (!this.config.enabled) {
      return this.createNoOpSpan(context);
    }

    // Head-based sampling decision: skip span creation when sampled out.
    if (this.config.sampling) {
      const sampling = this.config.sampling;
      if (sampling.strategy === 'never') {
        return this.createNoOpSpan(context);
      }
      if (sampling.strategy === 'head') {
        let rate = sampling.sampleRate;

        if (context.tags) {
          const tenant = context.tags['tenant'] as string | undefined;
          if (tenant !== undefined) {
            if (sampling.perTenantOverrides && Object.prototype.hasOwnProperty.call(sampling.perTenantOverrides, tenant)) {
              rate = sampling.perTenantOverrides[tenant];
            } else {
              context.tags['tenant'] = 'OTHER';
            }
          }

          const route = context.tags['route'] as string | undefined;
          if (route !== undefined) {
            if (sampling.perRouteOverrides) {
              const override = resolvePerRouteOverride(route, sampling.perRouteOverrides);
              if (override !== undefined) {
                rate = override.rate;
                context.tags['route'] = override.key;
              } else {
                context.tags['route'] = 'OTHER';
              }
            } else {
              context.tags['route'] = 'OTHER';
            }
          }
        }

        if (!shouldSampleHead(context.traceId, rate)) {
          return this.createNoOpSpan(context);
        }
      }
    }

    const spanId = String(++this.spanIdCounter);
    const span: Span = {
      context: { ...context, spanId },
      startTimeMs: Date.now(),
      status: 'pending',
      events: [],
    };

    this.activeSpans.set(spanId, span);

    // Call hooks and OpenTelemetry
    this.safeCall(() => this.config.hooks?.onSpanStart?.(span));
    if (this.otelTracer && context.tags?.['otel.enabled'] === true) {
      startOtelSpan(this.otelTracer, span);
    }

    return span;
  }

  /**
   * End a previously created span.
   */
  endSpan(span: Span, status: 'ok' | 'error' = 'ok', statusMessage?: string): void {
    if (!this.config.enabled) {
      return;
    }

    // Span was sampled out at head or is a no-op — nothing to export.
    if (!this.activeSpans.has(span.context.spanId)) {
      return;
    }

    span.endTimeMs = Date.now();
    span.durationMs = span.endTimeMs - span.startTimeMs;
    span.status = status;
    if (statusMessage !== undefined) {
      span.statusMessage = redactKeysInString(statusMessage);
    }

    this.activeSpans.delete(span.context.spanId);

    // Tail-based sampling: drop non-error spans that fall below the sample rate.
    if (this.config.sampling?.strategy === 'tail') {
      if (!shouldSampleTail(span, this.config.sampling)) {
        return;
      }
    }

    // Call hooks and OpenTelemetry
    this.safeCall(() => this.config.hooks?.onSpanEnd?.(span));
    if (this.otelTracer && span.context.tags?.['otel.enabled'] === true) {
      endOtelSpan(span);
    }
  }

  /**
   * Record an event within a span.
   */
  recordEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    if (!this.config.enabled) {
      return;
    }

    const event: SpanEvent = {
      name,
      timestamp: Date.now(),
      ...(attributes !== undefined ? { attributes: sanitize(attributes) } : {}),
    };

    span.events.push(event);

    // Call hooks and OpenTelemetry
    this.safeCall(() => this.config.hooks?.onEvent?.(span, event));
    if (this.otelTracer && span.context.tags?.['otel.enabled'] === true) {
      recordOtelEvent(span, event);
    }
  }

  /**
   * Record an error with correlation context.
   */
  recordError(correlationId: string, error: Error, context?: Record<string, unknown>): void {
    if (!this.config.enabled) {
      return;
    }

    const sanitized = sanitizeError(error);
    const safeError = new Error(sanitized.message as string);
    safeError.name = error.name;
    if (sanitized.stack) safeError.stack = sanitized.stack as string;
    this.safeCall(() => this.config.hooks?.onError?.(
      correlationId,
      safeError,
      context ? sanitize(context) : undefined,
    ));
  }

  /**
   * Get a span by ID (for testing).
   */
  getSpan(spanId: string): Span | undefined {
    return this.activeSpans.get(spanId);
  }

  /**
   * Get all active spans (for testing).
   */
  getActiveSpans(): Span[] {
    return Array.from(this.activeSpans.values());
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
   * Flush pending spans and drain async `onSpanEnd` hooks.
   *
   * Every remaining span is finalized first so exporters never receive raw
   * pending spans, then handed to the `onSpanEnd` hook. A hook that returns a
   * promise is awaited (settled either way) before its span is dropped, so
   * async exporters can drain during graceful shutdown.
   */
  async flush(): Promise<void> {
    const hooks = this.config.hooks;
    if (!hooks) {
      return;
    }

    if (typeof hooks.flush === 'function') {
      await hooks.flush();
    }

    const onSpanEnd = hooks.onSpanEnd;
    if (typeof onSpanEnd !== 'function') {
      return;
    }

    for (const span of this.activeSpans.values()) {
      this.finalizeSpan(span);
      await new Promise<void>((resolve) => {
        this.safeCall(() => {
          const result: void | Promise<void> = onSpanEnd(span);
          if (result && typeof (result as Promise<void>).then === 'function') {
            result.then(() => resolve()).catch(() => resolve());
          } else {
            resolve();
          }
        });
      });
      this.activeSpans.delete(span.context.spanId);
    }
  }

  /**
   * Create a no-op span (for when tracing is disabled).
   */
  private createNoOpSpan(context: Omit<SpanContext, 'spanId'>): Span {
    return {
      context: { ...context, spanId: 'noop' },
      startTimeMs: Date.now(),
      status: 'pending',
      events: [],
    };
  }

  /**
   * Call a function safely, catching and logging any errors.
   */
  private safeCall(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // Tracer implementation errors never escape to application code.
      // They're reported as a structured stderr record for debugging but
      // don't break the request.
      const message = err instanceof Error ? err.message : String(err);
      traceLogError(`Tracer hook error: ${message}`, {
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      });
    }
  }
}

/**
 * Wrap an async operation in a span.
 *
 * Creates a child span under the given correlationId, runs fn, then ends the
 * span with 'ok' or 'error' depending on whether fn throws.
 *
 * Usage:
 *   const result = await traceSpan('db.query', correlationId, { sql }, async () => {
 *     return pool.query(sql, params);
 *   });
 */
export async function traceSpan<T>(
  name: string,
  correlationId: string,
  tags: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
  parentSpanId?: string
): Promise<T> {
  const tracer = getTracer();
  const startContext: Omit<SpanContext, 'spanId'> = {
    traceId: correlationId,
    serviceName: 'fluxora-api',
    tags: { 'span.name': name, ...tags },
  };
  if (parentSpanId !== undefined) {
    startContext.parentSpanId = parentSpanId;
  }
  const span = tracer.startSpan(startContext);

  try {
    const result = await fn(span);
    tracer.endSpan(span, 'ok');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.endSpan(span, 'error', message);
    throw err;
  }
}

/**
 * Global tracer instance.
 */
let globalTracer: Tracer | null = null;

/**
 * Initialize the global tracer.
 */
export function initializeTracer(config: Partial<TracerConfig> = {}): Tracer {
  globalTracer = new Tracer(config);
  return globalTracer;
}

/**
 * Get the global tracer instance.
 */
export function getTracer(): Tracer {
  if (!globalTracer) {
    globalTracer = new Tracer();
  }
  return globalTracer;
}

/**
 * Reset the global tracer (for testing).
 */
export function resetTracer(): void {
  globalTracer = null;
}
