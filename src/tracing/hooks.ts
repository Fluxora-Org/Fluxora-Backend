/**
 * Distributed Tracing Hooks for Fluxora Backend.
 *
 * Optional hooks-based tracing system that enables observability without
 * requiring a specific tracing backend. Implementations can be plugged in
 * (e.g., OpenTelemetry, custom collectors) or disabled entirely.
 *
 * Design principles:
 * - Optional: tracing can be disabled with zero overhead
 * - Hook-based: callers emit events, handlers process them
 * - Observable: explicit state transitions, auth failures, duration tracking
 * - Failure-safe: tracing failures don't impact application logic
 * - PII-aware: integrates with existing PII sanitization
 *
 * Operators can observe:
 * - Request lifecycle (start, end, duration, status)
 * - Database operations (queries, latency, error)
 * - External API calls (Stellar RPC, status, latency)
 * - Authorization events (success, failures, scopes)
 * - Stream state transitions
 * - Error classifications with context
 *
 * Event categories:
 * - `request.*` - HTTP request lifecycle
 * - `db.*` - Database operations
 * - `api.*` - External API calls
 * - `auth.*` - Authorization and authentication
 * - `stream.*` - Stream state changes
 * - `error.*` - Error tracking
 */

/**
 * Span context: metadata attached to a logical unit of work.
 * Carries correlation ID and user/service identity.
 */
export interface SpanContext {
  traceId: string; // Unique trace ID (typically from correlation ID)
  spanId: string; // Unique span ID within the trace
  parentSpanId?: string; // Parent span if nested
  userId?: string; // Authenticated user, if any
  serviceName?: string; // Calling service name
  tags?: Record<string, unknown>; // Arbitrary metadata
}

/**
 * Span event: a discrete point event within a span's lifetime.
 */
export interface SpanEvent {
  name: string; // Event name (e.g., "db.query", "auth.failure")
  timestamp: number; // Unix timestamp (ms)
  attributes?: Record<string, unknown>;
}

/**
 * Span: a logical unit of work with a start, end, and events.
 */
export interface Span {
  context: SpanContext;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: 'pending' | 'ok' | 'error';
  statusMessage?: string;
  events: SpanEvent[];
}

/**
 * Tracer hook handlers:
 * Called when a tracer event occurs. Implementations are responsible
 * for capturing, filtering, storing, or exporting trace data.
 *
 * All handlers must be defensive — exceptions are caught and logged,
 * never propagated to application code.
 */
export interface TracerHooks {
  /**
   * Called when a new span is created.
   * Typically used to initialize trace storage or allocate IDs.
   */
  onSpanStart?(span: Span): void;

  /**
   * Called when a span is ended.
   * Typically used to finalize, export, or batch spans.
   */
  onSpanEnd?(span: Span): void;

  /**
   * Called when an event is recorded within a span.
   * Typically used to refine observability (e.g., detect invariant violations).
   */
  onEvent?(span: Span, event: SpanEvent): void;

  /**
   * Called when a request-level error is recorded.
   * Includes the correlation ID for linking with request logs.
   */
  onError?(correlationId: string, error: Error, context?: Record<string, unknown>): void;
}

/**
 * Configuration for the tracer.
 */
export interface TracerConfig {
  /** Enable tracing. If false, all tracer calls are no-ops. */
  enabled: boolean;

  /** Sample rate (0.0 to 1.0). Sampled spans are exported. */
  sampleRate?: number;

  /** Maximum number of spans to buffer before flushing. */
  maxSpansPerFlush?: number;

  /** OpenTelemetry integration (optional). */
  otel?: {
    enabled: boolean;
    tracerProvider?: any; // OpenTelemetry TracerProvider
    instrumentationName?: string;
  };

  /** Custom hook handlers. */
  hooks?: TracerHooks;
}

/**
 * Default tracer configuration.
 */
export const DEFAULT_TRACER_CONFIG: TracerConfig = {
  enabled: false, // Tracing is optin
  sampleRate: 1.0, // Sample all spans if enabled
  maxSpansPerFlush: 100,
};

/**
 * Tracer: the main interface for emitting trace events.
 *
 * Thread-safe. All methods are no-ops if tracing is disabled.
 */
export class Tracer {
  private config: TracerConfig;
  private activeSpans: Map<string, Span> = new Map();
  private spanIdCounter: number = 0;
  private otelTracer: any; // OpenTelemetry Tracer, if enabled

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

    try {
      const provider = this.config.otel.tracerProvider;
      if (provider && typeof provider.getTracer === 'function') {
        this.otelTracer = provider.getTracer(
          this.config.otel.instrumentationName || 'fluxora-backend'
        );
      }
    } catch (err) {
      // OpenTelemetry initialization failed; continue with disabled OTel
      // but tracing hooks still work.
    }
  }

  /**
   * Create a new span with the given context.
   */
  startSpan(context: Omit<SpanContext, 'spanId'>): Span {
    if (!this.config.enabled) {
      return this.createNoOpSpan(context);
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
      this.recordOtelSpanStart(span);
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

    span.endTimeMs = Date.now();
    span.durationMs = span.endTimeMs - span.startTimeMs;
    span.status = status;
    span.statusMessage = statusMessage;

    this.activeSpans.delete(span.context.spanId);

    // Call hooks and OpenTelemetry
    this.safeCall(() => this.config.hooks?.onSpanEnd?.(span));
    if (this.otelTracer && span.context.tags?.['otel.enabled'] === true) {
      this.recordOtelSpanEnd(span);
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
      attributes,
    };

    span.events.push(event);

    // Call hooks and OpenTelemetry
    this.safeCall(() => this.config.hooks?.onEvent?.(span, event));
    if (this.otelTracer && span.context.tags?.['otel.enabled'] === true) {
      this.recordOtelEvent(span, event);
    }
  }

  /**
   * Record an error with correlation context.
   */
  recordError(
    correlationId: string,
    error: Error,
    context?: Record<string, unknown>
  ): void {
    if (!this.config.enabled) {
      return;
    }

    this.safeCall(() => this.config.hooks?.onError?.(correlationId, error, context));
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
   * Flush pending spans (for graceful shutdown).
   */
  async flush(): Promise<void> {
    // Hooks may implement async flushing (e.g., batched export)
    if (this.config.hooks && typeof this.config.hooks.onSpanEnd === 'function') {
      for (const span of this.activeSpans.values()) {
        await new Promise((resolve) => {
          this.safeCall(() => {
            const result = this.config.hooks!.onSpanEnd?.(span);
            if (result instanceof Promise) {
              result.then(resolve).catch(() => resolve());
            } else {
              resolve(undefined);
            }
          });
        });
      }
    }
  }

  /**
   * OpenTelemetry span start (if enabled).
   */
  private recordOtelSpanStart(span: Span): void {
    if (!this.otelTracer) return;
    try {
      span.context.tags = span.context.tags || {};
      (span.context.tags as any)._otelSpan = this.otelTracer.startSpan(
        `${span.context.parentSpanId ? 'child' : 'root'}`,
        { attributes: { traceId: span.context.traceId, spanId: span.context.spanId } }
      );
    } catch (err) {
      // OTel error; continue without it
    }
  }

  /**
   * OpenTelemetry span end (if enabled).
   */
  private recordOtelSpanEnd(span: Span): void {
    const otelSpan = (span.context.tags as any)?._otelSpan;
    if (otelSpan && typeof otelSpan.end === 'function') {
      try {
        otelSpan.setStatus({ code: span.status === 'ok' ? 0 : 1 });
        if (span.statusMessage) {
          otelSpan.addEvent(span.status, { description: span.statusMessage });
        }
        otelSpan.end();
      } catch (err) {
        // OTel error; continue without it
      }
    }
  }

  /**
   * OpenTelemetry event record (if enabled).
   */
  private recordOtelEvent(span: Span, event: SpanEvent): void {
    const otelSpan = (span.context.tags as any)?._otelSpan;
    if (otelSpan && typeof otelSpan.addEvent === 'function') {
      try {
        otelSpan.addEvent(event.name, event.attributes);
      } catch (err) {
        // OTel error; continue without it
      }
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
      // Tracer implementation errors never escape to application code
      // They're logged to stderr for debugging but don't break the request
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({
        level: 'error',
        timestamp: new Date().toISOString(),
        message: `Tracer hook error: ${message}`,
        ...(err instanceof Error && err.stack && { stack: err.stack }),
      }));
    }
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
