/**
 * OpenTelemetry bridge for the custom Fluxora tracer.
 *
 * Extracted from `src/tracing/hooks.ts` in #1518. The `Tracer` class in
 * `src/tracing/tracer.ts` is transport-agnostic; this module is the single
 * place that knows how to talk to an OpenTelemetry tracer, so the core
 * tracer stays free of optional-dependency shape checks.
 *
 * Every exported function is total and failure-safe: a missing, malformed, or
 * throwing OpenTelemetry tracer is ignored rather than propagated. The OTel
 * SDK is an optional runtime dependency and may be absent entirely.
 */

import type { Span, SpanEvent } from './types.js';

/**
 * Tag key under which the active OTel span is stashed on a custom span.
 *
 * The custom tracer stores the OTel span in `span.context.tags` so that
 * enrichment helpers can reach it without a second lookup table.
 */
const OTEL_SPAN_TAG = '_otelSpan';

/** Minimal shape required from an OpenTelemetry tracer. */
interface OtelTracerLike {
  startSpan: (name: string, opts?: { attributes?: Record<string, unknown> }) => unknown;
}

/** Minimal shape required from an OpenTelemetry span. */
interface OtelSpanLike {
  end?: () => void;
  setStatus?: (status: { code: number }) => void;
  setAttribute?: (key: string, value: unknown) => void;
  addEvent?: (name: string, attrs?: Record<string, unknown>) => void;
}

/**
 * Resolve an OpenTelemetry tracer from a tracer provider.
 *
 * Returns `undefined` when no provider is configured, when the provider does
 * not expose `getTracer`, or when resolution throws. Never throws.
 *
 * @param provider            - TracerProvider-like object, if configured.
 * @param instrumentationName - Tracer name to request.
 */
export function resolveOtelTracer(
  provider: { getTracer(name: string): unknown } | undefined,
  instrumentationName: string
): unknown {
  if (!provider || typeof provider.getTracer !== 'function') {
    return undefined;
  }
  try {
    return provider.getTracer(instrumentationName);
  } catch {
    // OpenTelemetry initialization failed; continue with disabled OTel
    // but tracing hooks still work.
    return undefined;
  }
}

/**
 * Read the OTel span stashed on a custom span, if any.
 *
 * Returns `undefined` when the span carries no OTel span, which is the normal
 * case when OTel is disabled or the span was sampled out.
 */
export function readOtelSpan(span: Span): OtelSpanLike | undefined {
  const otelSpan = (span.context.tags as Record<string, unknown> | undefined)?.[
    OTEL_SPAN_TAG
  ] as OtelSpanLike | undefined;
  return otelSpan;
}

/**
 * OpenTelemetry span start (if enabled).
 *
 * Starts an OTel span named `child` or `root` depending on whether the custom
 * span has a parent, and stashes it on the custom span for later enrichment.
 * Failures are swallowed so the custom span still completes normally.
 */
export function startOtelSpan(otelTracer: unknown, span: Span): void {
  if (!otelTracer) return;
  try {
    span.context.tags = span.context.tags || {};
    const tracer = otelTracer as OtelTracerLike;
    (span.context.tags as Record<string, unknown>)[OTEL_SPAN_TAG] = tracer.startSpan(
      `${span.context.parentSpanId ? 'child' : 'root'}`,
      { attributes: { traceId: span.context.traceId, spanId: span.context.spanId } }
    );
  } catch {
    // OTel error; continue without it
  }
}

/**
 * OpenTelemetry span end (if enabled).
 *
 * Mirrors the custom span's terminal status onto the OTel span and closes it.
 * Failures are swallowed so the custom span still completes normally.
 */
export function endOtelSpan(span: Span): void {
  const otelSpan = readOtelSpan(span);
  if (otelSpan && typeof otelSpan.end === 'function') {
    try {
      otelSpan.setStatus?.({ code: span.status === 'ok' ? 0 : 1 });
      if (span.statusMessage) {
        otelSpan.addEvent?.(span.status, { description: span.statusMessage });
      }
      otelSpan.end();
    } catch {
      // OTel error; continue without it
    }
  }
}

/**
 * OpenTelemetry event record (if enabled).
 *
 * Forwards a custom span event onto the matching OTel span. Failures are
 * swallowed so the custom span still completes normally.
 */
export function recordOtelEvent(span: Span, event: SpanEvent): void {
  const otelSpan = readOtelSpan(span);
  if (otelSpan && typeof otelSpan.addEvent === 'function') {
    try {
      otelSpan.addEvent(event.name, event.attributes);
    } catch {
      // OTel error; continue without it
    }
  }
}

/**
 * Set a single attribute on a span's stashed OTel span.
 *
 * Used by the stream-enrichment helpers in `src/tracing/otelHooks.ts`.
 * No-ops when the custom span has no OTel span attached.
 */
export function setOtelSpanAttribute(span: Span, key: string, value: unknown): void {
  const otelSpan = readOtelSpan(span);
  if (otelSpan && typeof otelSpan.setAttribute === 'function') {
    try {
      otelSpan.setAttribute(key, value);
    } catch {
      // ignore OTel setAttribute errors
    }
  }
}
