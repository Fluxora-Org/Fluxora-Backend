import type { Attributes } from '@opentelemetry/api';
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

  /**
   * Flush pending spans in the exporter/buffer.
   */
  flush?(): Promise<void>;

  /**
   * Shut down the exporter/buffer, flushing all remaining spans.
   */
  shutdown?(): Promise<void>;
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

  /** Sampling strategy configuration. When omitted, all spans are kept (100% sampling). */
  sampling?: SamplingConfig;
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

    // Span was sampled out at head or is a no-op — nothing to export.
    if (!this.activeSpans.has(span.context.spanId)) {
      return;
    }

    span.endTimeMs = Date.now();
    span.durationMs = span.endTimeMs - span.startTimeMs;
    span.status = status;
    if (statusMessage !== undefined) {
      span.statusMessage = statusMessage;
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
  recordError(correlationId: string, error: Error, context?: Record<string, unknown>): void {
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

  async flush(): Promise<void> {
    if (this.config.hooks) {
      if (typeof this.config.hooks.flush === 'function') {
        await this.config.hooks.flush();
      }
      if (typeof this.config.hooks.onSpanEnd === 'function') {
        for (const span of this.activeSpans.values()) {
          this.finalizeSpan(span);
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
          this.activeSpans.delete(span.context.spanId);
        }
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
      console.error(
        JSON.stringify({
          level: 'error',
          timestamp: new Date().toISOString(),
          message: `Tracer hook error: ${message}`,
          ...(err instanceof Error && err.stack && { stack: err.stack }),
        })
      );
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
  fn: () => Promise<T>
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan(
    'db.query',
    correlationId,
    { 'db.system': 'postgresql', 'db.name': dbName, 'db.statement': sql },
    async () => fn()
  );
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
  fn: () => Promise<T>
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan(
    'redis.command',
    correlationId,
    { 'db.system': 'redis', 'db.operation': command, 'db.redis.key': key },
    async () => fn()
  );
}

/**
 * Wrap a Stellar RPC call in an OTel span.
 *
 * @param operation — RPC method name (e.g. "getLatestLedger")
 */
export async function traceStellarRpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan(
    'stellar.rpc',
    correlationId,
    { 'rpc.system': 'stellar', 'rpc.method': operation },
    async () => fn()
  );
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
  fn: () => Promise<T>
): Promise<T> {
  const correlationId = getCorrelationIdFromContext();
  return traceSpan(
    'webhook.dispatch',
    correlationId,
    { 'webhook.event': event, 'webhook.url': url, 'webhook.retry': attempt },
    async () => fn()
  );
}

/**
 * Emit a span event on every circuit breaker state transition.
 *
 * Called by the Stellar RPC `CircuitBreaker` on each state change
 * (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED). Attaches the event to
 * both the custom Fluxora Tracer span (if one is active) and to the OTel
 * active span via `trace.getActiveSpan()`.
 *
 * Steady-state successes (no state change) must NOT call this function —
 * the caller is responsible for gating on an actual transition.
 *
 * Security: RPC endpoint URLs and credentials must never be passed here.
 * Only safe diagnostic values (state names, failure counts) are recorded.
 *
 * @param prevState        - The state before the transition.
 * @param newState         - The state after the transition.
 * @param failureCount     - Number of consecutive failures in the window.
 * @param failureKind      - Classification of the failure that caused the trip
 *                           (omit for recovery transitions where no new failure
 *                           occurred, e.g. HALF_OPEN→CLOSED on probe success).
 */
export function recordCircuitBreakerTransition(
  prevState: string,
  newState: string,
  failureCount: number,
  failureKind?: string
): void {
  const attributes: Record<string, unknown> = {
    'circuit_breaker.prev_state': prevState,
    'circuit_breaker.new_state': newState,
    'circuit_breaker.failure_count': failureCount,
  };
  if (failureKind !== undefined) {
    attributes['circuit_breaker.failure_kind'] = failureKind;
  }

  // 1. OTel active span (no-throw guard)
  try {
    trace
      .getActiveSpan()
      ?.addEvent('circuit_breaker.state_change', attributes as unknown as Attributes);
  } catch {
    // tracing failures must never affect application logic
  }

  // 2. Custom Fluxora tracer (no-throw guard)
  try {
    const tracer = getTracer();
    const spans = tracer.getActiveSpans();
    if (spans.length > 0) {
      tracer.recordEvent(spans[spans.length - 1], 'circuit_breaker.state_change', attributes);
    }
  } catch {
    // tracing failures must never affect application logic
  }
}

/**
 * Record a WebSocket broadcast event on the active OTel span (if any).
 * Does not create a new span — attaches an event to the current context.
 */
export function recordWsBroadcast(streamId: string, eventId: string, recipients: number): void {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return;
  activeSpan.addEvent('ws.broadcast', {
    'ws.stream_id': streamId,
    'ws.event_id': eventId,
    'ws.recipients': recipients,
  });
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
 * Retrieve the active traceId and spanId from the current OpenTelemetry
 * span context, if a distributed trace is in progress.
 *
 * Reads from the same OTel AsyncLocalStorage context used by the rest of
 * src/tracing/hooks.ts (via `trace.getActiveSpan().spanContext()`) rather
 * than deriving trace context independently.  This guarantees a single
 * source of truth for trace-identity fields in log records.
 *
 * When no active span exists (e.g. background jobs outside a request,
 * tracing disabled, or called before middleware sets up the span), the
 * returned object is empty and callers should spread it into log metadata
 * without adding undefined keys.
 *
 * Errors thrown by the OTel SDK are silently swallowed — a broken
 * exporter or collector must never affect application error-logging.
 *
 * @returns Object with `traceId` and `spanId` when available, otherwise `{}`.
 */
export function getActiveTraceSpanIds(): { traceId?: string; spanId?: string } {
  try {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext?.traceId && spanContext?.spanId) {
      return { traceId: spanContext.traceId, spanId: spanContext.spanId };
    }
  } catch {
    // OTel unavailable or broken — degrade gracefully.
  }
  return {};
}

/**
 * Enrich a specific Span (custom tracer span) and any associated OTel span/active OTel span with stream attributes.
 */
export function enrichSpanWithStream(
  span: Span,
  streamId?: string,
  sender?: string,
  recipient?: string
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
  recipient?: string
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

// ── Sampling Strategies ───────────────────────────────────────────────────────
//
// Issue #757: Head-based and tail-based trace sampling strategies.
//
// Head-based sampling: the decision to keep or drop a trace is made at the
// beginning of the trace, keyed off the trace ID hash. Because the decision
// is derived deterministically from the trace ID, all services in the call
// graph that see the same trace ID make the same keep/drop decision, so you
// never get partial traces.
//
// Tail-based sampling: the decision is made at span-end time based on the
// span's outcome. The current implementation always keeps spans that contain
// an error status or an error event, without buffering all spans in memory.
//
// Per-route overrides: individual API routes can have their own sample rates
// configured via TRACING_PER_ROUTE_OVERRIDES (JSON env var), overriding the
// global rate for traffic on that route.

/**
 * Available sampling strategy identifiers.
 *
 * - `'head'`   — deterministic decision keyed on trace ID (recommended for production)
 * - `'tail'`   — decision made at span-end time; keeps error spans always
 * - `'always'` — keep every span (useful for development / debugging)
 * - `'never'`  — drop every span (useful for benchmarking overhead)
 */
export type SamplingStrategy = 'head' | 'tail' | 'always' | 'never';

/**
 * Configuration for head-based sampling.
 *
 * The sample decision is made once at trace creation time using a
 * deterministic hash of the trace ID. All services observing the same
 * trace ID will make the same decision.
 */
export interface HeadSamplingConfig {
  strategy: 'head';
  /** Fraction of traces to keep, in [0, 1]. Default 1.0 (keep all). */
  sampleRate: number;
  /**
   * Per-route sample rate overrides.
   * Keys are route path prefixes (e.g. `"/health"`, `"/api/streams"`).
   * Values are sample rates in [0, 1].
   * Exact matches are checked first; then longest prefix match.
   */
  perRouteOverrides?: Record<string, number>;
  /**
   * Per-tenant sample rate overrides.
   * Keys are tenant IDs.
   * Values are sample rates in [0, 1].
   * Exact matches only.
   */
  perTenantOverrides?: Record<string, number>;
}

/**
 * Configuration for tail-based sampling.
 *
 * The decision is made at span-end time. Error spans are always kept when
 * `keepErrorSpans` is true, without requiring full in-memory buffering.
 */
export interface TailSamplingConfig {
  strategy: 'tail';
  /** Fraction of non-error spans to keep, in [0, 1]. Default 0.1. */
  sampleRate: number;
  /**
   * When true, any span with status `'error'` or an event named `'error'`
   * is always kept regardless of `sampleRate`.
   */
  keepErrorSpans: boolean;
}

/** Always-on (keep every span) sampling config. */
export interface AlwaysSamplingConfig {
  strategy: 'always';
}

/** Always-off (drop every span) sampling config. */
export interface NeverSamplingConfig {
  strategy: 'never';
}

/** Union of all supported sampling config shapes. */
export type SamplingConfig =
  | HeadSamplingConfig
  | TailSamplingConfig
  | AlwaysSamplingConfig
  | NeverSamplingConfig;

// ─── FNV-1a 32-bit hash (no dependencies, pure function) ──────────────────────

/**
 * Compute a 32-bit FNV-1a hash of a UTF-16 string.
 *
 * Used by head-based sampling so the trace-ID → keep/drop decision is:
 * - Deterministic: same traceId → same hash → same bucket → same decision.
 * - Uniform: good distribution across the [0, 999] bucket space.
 * - Fast: O(n) time, zero allocations.
 *
 * @param input - Any string (typically a trace ID).
 * @returns Unsigned 32-bit integer.
 */
export function samplingFnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash >>> 0) * 16777619; // FNV prime
    hash >>>= 0; // keep 32-bit unsigned
  }
  return hash >>> 0;
}

/**
 * Determine whether a trace should be sampled using head-based (upfront) logic.
 *
 * The bucket is derived as `samplingFnv1a32(traceId) % 1000`, giving 1000
 * evenly-sized slots. A trace is kept when its bucket is less than
 * `Math.round(sampleRate * 1000)`.
 *
 * This function is **pure** — identical inputs always produce identical
 * outputs, across processes and replicas, with no shared state.
 *
 * @param traceId    - The W3C trace ID (hex string) or correlation ID.
 * @param sampleRate - Fraction in [0, 1]. 0 = never, 1 = always.
 * @returns `true` if the trace should be kept.
 */
export function shouldSampleHead(traceId: string, sampleRate: number): boolean {
  if (Number.isNaN(sampleRate) || !Number.isFinite(sampleRate)) return false;
  const clampedRate = Math.max(0, Math.min(1, sampleRate));
  if (clampedRate <= 0) return false;
  if (clampedRate >= 1) return true;
  const bucket = samplingFnv1a32(traceId) % 1000;
  return bucket < Math.round(clampedRate * 1000);
}

/**
 * Determine whether a finished span should be kept using tail-based logic.
 *
 * Rules (applied in order):
 * 1. If `config.keepErrorSpans` is true and the span has `status === 'error'`,
 *    keep it unconditionally.
 * 2. If `config.keepErrorSpans` is true and the span has any event named
 *    `'error'`, keep it unconditionally.
 * 3. Otherwise, apply a random sample at `config.sampleRate`.
 *
 * Note: Step 3 uses `Math.random()` (non-deterministic) deliberately — tail
 * sampling is about keeping a representative sample of healthy traffic after
 * the fact. Only head-based sampling uses deterministic hashing.
 *
 * @param span   - The completed span to evaluate.
 * @param config - Tail sampling configuration.
 * @returns `true` if the span should be kept.
 */
export function shouldSampleTail(span: Span, config: TailSamplingConfig): boolean {
  if (config.keepErrorSpans) {
    if (span.status === 'error') return true;
    if (span.events.some((e) => e.name === 'error')) return true;
  }
  if (config.sampleRate >= 1) return true;
  if (config.sampleRate <= 0) return false;
  return Math.random() < config.sampleRate;
}

/**
 * Resolve a per-route sample rate override for a given route path.
 *
 * Lookup order:
 * 1. Exact match (`overrides[route]`)
 * 2. Longest prefix match (the override key that is a prefix of `route`
 *    and is the longest such key)
 * 3. `undefined` — no override applies; use the global sample rate
 *
 * @param route     - The incoming request path (e.g. `"/api/streams/abc"`).
 * @param overrides - Map of route path → sample rate.
 * @returns Override sample rate in [0, 1], or `undefined` if no match.
 */
export function resolvePerRouteOverride(
  route: string,
  overrides: Record<string, number>
): { rate: number; key: string } | undefined {
  // 1. Exact match
  if (Object.prototype.hasOwnProperty.call(overrides, route)) {
    return { rate: overrides[route], key: route };
  }

  // 2. Longest prefix match (segment-aware)
  let best: { key: string; rate: number } | undefined;
  for (const [key, rate] of Object.entries(overrides)) {
    const isPrefix = key.endsWith('/') ? route.startsWith(key) : route.startsWith(`${key}/`);
    if (isPrefix) {
      if (best === undefined || key.length > best.key.length) {
        best = { key, rate };
      }
    }
  }

  return best;
}

// ── Span Export Batching (Issue #758) ──────────────────────────────────────────

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
 * Bounded in-memory batch exporter for finished spans.
 *
 * Accumulates completed spans and flushes them to an export target handler
 * (e.g. OTLP exporter, HTTP collector, or custom logger) either on a scheduled timer
 * or when the batch size threshold (`maxBatchSize`) is reached.
 *
 * Guarantees & Resilience:
 * - **Non-blocking**: `onSpanEnd` adds spans to the queue synchronously in O(1).
 *   Exporting occurs asynchronously without blocking application request handlers.
 * - **Bounded Memory**: If the queue reaches `maxQueueSize`, excess spans fall back
 *   to immediate direct export (or drop/flush) rather than causing unbounded memory growth.
 * - **Graceful Shutdown**: `shutdown()` and `flush()` drain all queued spans before returning.
 * - **Failure-safe**: Exceptions thrown by the `exportHandler` are caught, recorded in metrics,
 *   and never leak to application code.
 */
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
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err) => {
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
   * Flush all buffered spans in batches to the export handler.
   */

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
          if (result && typeof (result as Promise<void>).then === 'function') {
            await result;
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
      console.error(
        JSON.stringify({
          level: 'error',
          timestamp: new Date().toISOString(),
          message: `[BatchSpanExporter] ${msg}: ${err instanceof Error ? err.message : String(err)}`,
        })
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
