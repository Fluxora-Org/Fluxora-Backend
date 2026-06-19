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
   *
   * Implementations may return a Promise — the tracer awaits it during
   * `flush()` so async exporters can drain before shutdown.
   */
  onSpanEnd?(span: Span): void | Promise<void>;

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
    tracerProvider?: { getTracer(name: string): unknown }; // OpenTelemetry TracerProvider
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
  // OpenTelemetry Tracer, if enabled.  Typed as `unknown` so we can defer all
  // shape-checking to the call-sites below — the OTel SDK is an optional
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

    try {
      const provider = this.config.otel.tracerProvider;
      if (provider && typeof provider.getTracer === 'function') {
        this.otelTracer = provider.getTracer(
          this.config.otel.instrumentationName || 'fluxora-backend'
        );
      }
    } catch {
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
    if (statusMessage !== undefined) {
      span.statusMessage = statusMessage;
    }

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
      ...(attributes !== undefined ? { attributes } : {}),
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
        await new Promise<void>((resolve) => {
          this.safeCall(() => {
            const result: void | Promise<void> = this.config.hooks!.onSpanEnd?.(span);
            if (result && typeof (result as Promise<void>).then === 'function') {
              (result as Promise<void>).then(() => resolve()).catch(() => resolve());
            } else {
              resolve();
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
      const tracer = this.otelTracer as {
        startSpan: (name: string, opts?: { attributes?: Record<string, unknown> }) => unknown;
      };
      (span.context.tags as Record<string, unknown>)._otelSpan = tracer.startSpan(
        `${span.context.parentSpanId ? 'child' : 'root'}`,
        { attributes: { traceId: span.context.traceId, spanId: span.context.spanId } }
      );
    } catch {
      // OTel error; continue without it
    }
  }

  /**
   * OpenTelemetry span end (if enabled).
   */
  private recordOtelSpanEnd(span: Span): void {
    const otelSpan = (span.context.tags as Record<string, unknown> | undefined)?.['_otelSpan'] as
      | {
          end: () => void;
          setStatus: (status: { code: number }) => void;
          addEvent: (name: string, attrs?: Record<string, unknown>) => void;
        }
      | undefined;
    if (otelSpan && typeof otelSpan.end === 'function') {
      try {
        otelSpan.setStatus({ code: span.status === 'ok' ? 0 : 1 });
        if (span.statusMessage) {
          otelSpan.addEvent(span.status, { description: span.statusMessage });
        }
        otelSpan.end();
      } catch {
        // OTel error; continue without it
      }
    }
  }

  /**
   * OpenTelemetry event record (if enabled).
   */
  private recordOtelEvent(span: Span, event: SpanEvent): void {
    const otelSpan = (span.context.tags as Record<string, unknown> | undefined)?.['_otelSpan'] as
      | { addEvent: (name: string, attrs?: Record<string, unknown>) => void }
      | undefined;
    if (otelSpan && typeof otelSpan.addEvent === 'function') {
      try {
        otelSpan.addEvent(event.name, event.attributes);
      } catch {
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
  parentSpanId?: string,
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
 * Wrap local Server-Sent Events fan-out in a tracing span.
 *
 * The span records fan-out size and event identity without storing payload
 * bodies, token material, or client addresses.
 */
export function traceSseDispatch<T>(
  streamId: string,
  eventId: string,
  subscriberCount: number,
  correlationId: string | undefined,
  fn: (span: Span) => T,
): T {
  const tracer = getTracer();
  const traceId = correlationId?.trim() || getCorrelationIdFromContext();
  const span = tracer.startSpan({
    traceId,
    serviceName: 'fluxora-sse',
    tags: {
      'span.name': 'sse.dispatch',
      'sse.stream_id': streamId,
      'sse.event_id': eventId,
      'sse.subscribers': subscriberCount,
      'sse.correlation_id': traceId,
    },
  });

  try {
    const result = fn(span);
    tracer.recordEvent(span, 'sse.dispatch', {
      streamId,
      eventId,
      subscribers: subscriberCount,
      correlationId: traceId,
    });
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

// ── OTel-aware business span helpers ─────────────────────────────────────────
//
// These thin wrappers call traceSpan() with well-known semantic attribute keys
// so that spans emitted by business code are consistent with the OTel SDK spans
// produced by auto-instrumentation.  All helpers are no-ops when tracing is
// disabled (traceSpan delegates to the global Tracer which short-circuits).

import { trace, context, SpanStatusCode } from '@opentelemetry/api';

/**
 * Wrap a database query in an OTel span.
 *
 * @param sql     — SQL text (must not contain user-supplied values; use params)
 * @param dbName  — logical database name for the `db.name` attribute
 * @param fn      — async operation to wrap
 *
 * Security: `sql` is recorded as a span attribute.  Never interpolate
 * user-controlled values into `sql`; always use parameterised queries.
 */
export async function traceDbQuery<T>(
  sql: string,
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan('db.query', correlationId, { 'db.system': 'postgresql', 'db.name': dbName, 'db.statement': sql }, async () => fn());
}

/**
 * Wrap a Redis command in an OTel span.
 *
 * @param command — Redis command name (e.g. "GET", "SET")
 * @param key     — cache key (must not contain PII)
 */
export async function traceRedisCommand<T>(
  command: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan('redis.command', correlationId, { 'db.system': 'redis', 'db.operation': command, 'db.redis.key': key }, async () => fn());
}

/**
 * Wrap a Stellar RPC call in an OTel span.
 *
 * @param operation — RPC method name (e.g. "getLatestLedger")
 */
export async function traceStellarRpc<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan('stellar.rpc', correlationId, { 'rpc.system': 'stellar', 'rpc.method': operation }, async () => fn());
}

/**
 * Wrap a webhook dispatch attempt in an OTel span.
 *
 * @param event   — event type (e.g. "stream.created")
 * @param url     — destination URL (must not contain secrets)
 * @param attempt — retry attempt number (0 = first attempt)
 */
export async function traceWebhookDispatch<T>(
  event: string,
  url: string,
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan('webhook.dispatch', correlationId, { 'webhook.event': event, 'webhook.url': url, 'webhook.retry': attempt }, async () => fn());
}

/**
 * Record a WebSocket broadcast event on the active OTel span (if any).
 * Does not create a new span — attaches an event to the current context.
 */
export function recordWsBroadcast(streamId: string, eventId: string, recipients: number): void {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return;
  activeSpan.addEvent('ws.broadcast', { 'ws.stream_id': streamId, 'ws.event_id': eventId, 'ws.recipients': recipients });
}

/**
 * Retrieve the current correlation ID from the OTel context (traceparent trace-id)
 * or fall back to 'unknown'.  Used internally by the helpers above.
 */
function getCorrelationIdFromContext(): string {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext?.traceId) return spanContext.traceId;
  // Fall back to the AsyncLocalStorage-based correlation ID if available.
  try {
    // Dynamic import avoided — use a lazy require-style approach.
    // The correlationStore is in middleware.ts; we avoid a circular dep by
    // reading from the OTel context only.
  } catch {
    // ignore
  }
  return 'unknown';
}

/**
 * Enrich a specific Span (custom tracer span) and any associated OTel span/active OTel span with stream attributes.
 */
export function enrichSpanWithStream(
  span: Span,
  streamId?: string,
  sender?: string,
  recipient?: string,
): void {
  if (!span) return;
  if (!span.context) {
    span.context = { traceId: 'unknown', spanId: 'noop' };
  }
  if (!span.context.tags) {
    span.context.tags = {};
  }

  // 1. Enrich custom span tags
  if (streamId) span.context.tags['fluxora.stream_id'] = streamId;
  if (sender) span.context.tags['fluxora.sender'] = sender;
  if (recipient) span.context.tags['fluxora.recipient'] = recipient;

  // 2. Enrich the internal OTel span if it exists in tags
  const otelSpan = span.context.tags['_otelSpan'] as any;
  if (otelSpan && typeof otelSpan.setAttribute === 'function') {
    try {
      if (streamId) otelSpan.setAttribute('fluxora.stream_id', streamId);
      if (sender) otelSpan.setAttribute('fluxora.sender', sender);
      if (recipient) otelSpan.setAttribute('fluxora.recipient', recipient);
    } catch {
      // ignore OTel setAttribute errors
    }
  }

  // 3. Enrich the global active OTel span if one exists
  try {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      if (streamId) activeSpan.setAttribute('fluxora.stream_id', streamId);
      if (sender) activeSpan.setAttribute('fluxora.sender', sender);
      if (recipient) activeSpan.setAttribute('fluxora.recipient', recipient);
    }
  } catch {
    // ignore active span errors
  }
}

/**
 * Enrich the active OpenTelemetry span with stream attributes.
 */
export function enrichActiveSpanWithStream(
  streamId?: string,
  sender?: string,
  recipient?: string,
): void {
  try {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      if (streamId) activeSpan.setAttribute('fluxora.stream_id', streamId);
      if (sender) activeSpan.setAttribute('fluxora.sender', sender);
      if (recipient) activeSpan.setAttribute('fluxora.recipient', recipient);
    }
  } catch {
    // ignore active span errors
  }
}
