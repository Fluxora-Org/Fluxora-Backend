/**
 * Distributed Tracing Hooks for Fluxora Backend — public surface.
 *
 * Optional hooks-based tracing system that enables observability without
 * requiring a specific tracing backend. Implementations can be plugged in
 * (e.g., OpenTelemetry, custom collectors) or disabled entirely.
 *
 * ## Module layout (#1518)
 *
 * This file used to be a single 1,276-line module. It is now a thin barrel
 * that re-exports the subsystem modules so that every existing import path
 * (`from './tracing/hooks.js'`) and every exported symbol keeps working
 * unchanged. Each module below owns exactly one concern:
 *
 * - `types.ts`          — span/hook type contracts shared by all modules.
 * - `sampling.ts`       — head/tail/per-route sampling decisions (#757).
 * - `tracer.ts`         — core `Tracer` span lifecycle + `traceSpan()`.
 * - `otelBridge.ts`     — OpenTelemetry adapter (optional dependency).
 * - `otelHooks.ts`      — per-subsystem hooks (db, redis, RPC, webhooks, WS).
 * - `batchExporter.ts`  — bounded batch export buffering (#758).
 * - `traceLogger.ts`    — structured logging for tracing internals.
 *
 * Design principles (unchanged by the split):
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

// ── Public surface ────────────────────────────────────────────────────────────
// Re-exported (not re-implemented) so downstream imports stay source-compatible.

export {
  DEFAULT_TRACER_CONFIG,
  type Span,
  type SpanContext,
  type SpanEvent,
  type TracerConfig,
  type TracerHooks,
} from './types.js';

export {
  resolvePerRouteOverride,
  samplingFnv1a32,
  shouldSampleHead,
  shouldSampleTail,
  type AlwaysSamplingConfig,
  type HeadSamplingConfig,
  type NeverSamplingConfig,
  type SamplingConfig,
  type SamplingStrategy,
  type TailSamplingConfig,
} from './sampling.js';

export {
  Tracer,
  getTracer,
  initializeTracer,
  resetTracer,
  traceSpan,
} from './tracer.js';

export {
  enrichActiveSpanWithStream,
  enrichSpanWithStream,
  getActiveTraceSpanIds,
  recordCircuitBreakerTransition,
  recordWsBroadcast,
  traceDbQuery,
  traceRedisCommand,
  traceStellarRpc,
  traceWebhookDispatch,
} from './otelHooks.js';

export {
  BatchSpanExporter,
  createBatchSpanExporter,
  type BatchSpanExporterConfig,
} from './batchExporter.js';
