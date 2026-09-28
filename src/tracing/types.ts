/**
 * Core tracing types shared by every module in `src/tracing/`.
 *
 * This module is intentionally dependency-free (types only) so that every other
 * tracing module can import from it without creating a cycle.
 *
 * Originally these declarations lived in `src/tracing/hooks.ts`; they were
 * extracted in #1518 so that the subsystem-specific hook modules (database,
 * cache, RPC, webhooks, streaming) can depend on a stable type surface.
 */

import type { SamplingConfig } from './sampling.js';

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
