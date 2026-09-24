/**
 * OTel-aware per-subsystem instrumentation hooks.
 *
 * Extracted from `src/tracing/hooks.ts` in #1518. These thin wrappers call
 * `traceSpan()` with well-known semantic attribute keys so that spans emitted
 * by business code are consistent with the OTel SDK spans produced by
 * auto-instrumentation. All helpers are no-ops when tracing is disabled
 * (`traceSpan` delegates to the global `Tracer` which short-circuits).
 *
 * Each helper is grouped by the subsystem it instruments:
 * - Database (`traceDbQuery`)
 * - Cache / Redis (`traceRedisCommand`)
 * - Stellar RPC (`traceStellarRpc`, `recordCircuitBreakerTransition`)
 * - Webhooks (`traceWebhookDispatch`)
 * - WebSocket streaming (`recordWsBroadcast`, `enrichSpanWithStream`,
 *   `enrichActiveSpanWithStream`)
 * - Log correlation (`getActiveTraceSpanIds`)
 */

import { trace, type Attributes } from '@opentelemetry/api';
import { redactKeysInString } from '../pii/sanitizer.js';
import { getTracer, traceSpan } from './tracer.js';
import { setOtelSpanAttribute } from './otelBridge.js';
import type { Span } from './types.js';

// ── Database ──────────────────────────────────────────────────────────────────

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

// ── Cache / Redis ─────────────────────────────────────────────────────────────

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

// ── Stellar RPC ───────────────────────────────────────────────────────────────

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

// ── Webhooks ──────────────────────────────────────────────────────────────────

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

// ── WebSocket streaming ───────────────────────────────────────────────────────

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

  const safeSender = sender ? redactKeysInString(sender) : undefined;
  const safeRecipient = recipient ? redactKeysInString(recipient) : undefined;

  // 1. Enrich custom span tags
  if (streamId) span.context.tags['fluxora.stream_id'] = streamId;
  if (safeSender) span.context.tags['fluxora.sender'] = safeSender;
  if (safeRecipient) span.context.tags['fluxora.recipient'] = safeRecipient;

  // 2. Enrich the internal OTel span if it exists in tags
  if (streamId) setOtelSpanAttribute(span, 'fluxora.stream_id', streamId);
  if (safeSender) setOtelSpanAttribute(span, 'fluxora.sender', safeSender);
  if (safeRecipient) setOtelSpanAttribute(span, 'fluxora.recipient', safeRecipient);

  // 3. Enrich the global active OTel span if one exists
  try {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      if (streamId) activeSpan.setAttribute('fluxora.stream_id', streamId);
      if (safeSender) activeSpan.setAttribute('fluxora.sender', safeSender);
      if (safeRecipient) activeSpan.setAttribute('fluxora.recipient', safeRecipient);
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
      if (sender) activeSpan.setAttribute('fluxora.sender', redactKeysInString(sender));
      if (recipient) activeSpan.setAttribute('fluxora.recipient', redactKeysInString(recipient));
    }
  } catch {
    // ignore active span errors
  }
}

// ── Log correlation ───────────────────────────────────────────────────────────

/**
 * Retrieve the current correlation ID from the OTel context (traceparent trace-id)
 * or fall back to 'unknown'.  Used internally by the helpers above.
 */
function getCorrelationIdFromContext(): string {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext?.traceId) return spanContext.traceId;
  return 'unknown';
}

/**
 * Retrieve the active traceId and spanId from the current OpenTelemetry
 * span context, if a distributed trace is in progress.
 *
 * Reads from the same OTel AsyncLocalStorage context used by the rest of
 * `src/tracing/` (via `trace.getActiveSpan().spanContext()`) rather
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
