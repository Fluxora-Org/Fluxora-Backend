/**
 * Distributed Tracing Middleware for Fluxora Backend.
 *
 * Hooks into the Express request/response lifecycle to:
 * - Create a trace span for each HTTP request
 * - Record request metadata (method, path, auth status)
 * - Track response status and duration
 * - Handle errors and exceptions
 * - Link request logs to traces via correlation ID
 * - Propagate correlationId through async boundaries via AsyncLocalStorage
 * - Parse inbound W3C traceparent headers to continue upstream traces
 * - Attach outbound W3C traceparent headers on Stellar RPC and webhook calls
 *
 * Trust boundary: treats all incoming request headers as untrusted.
 * The traceparent header is validated against the W3C Trace Context spec
 * (version-traceId-parentId-flags) before use. Any malformed or oversized
 * value is silently dropped and a new trace is started.
 *
 * Failure modes:
 * - If tracer is disabled, all operations are no-ops (zero overhead)
 * - If a tracer hook fails, the error is logged but doesn't propagate
 * - If OpenTelemetry is misconfigured, the app continues without it
 * - If traceparent is missing/invalid, correlation-id fallback is used
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { getTracer } from './hooks.js';
import { Span, type SpanContext } from './hooks.js';
import { trace } from '@opentelemetry/api';

// ── W3C Trace Context helpers ─────────────────────────────────────────────────

/**
 * Maximum allowed length for a traceparent header value.
 *
 * The W3C spec maximum for version 00 is exactly 55 chars:
 *   00-<32hex>-<16hex>-<2hex>  = 2+1+32+1+16+1+2 = 55
 * We add a small buffer for future spec versions with extra fields.
 * Values longer than this cap are rejected without further parsing to
 * prevent DoS via pathological regex backtracking.
 */
const MAX_TRACEPARENT_LENGTH = 200;

/**
 * W3C Trace Context version 00 regex.
 * Format: version(2)-traceId(32)-parentId(16)-flags(2)
 *
 * Security: anchored with ^ and $ to prevent partial matching.
 * The regex is constant-complexity (no backtracking) on valid inputs.
 * Invalid version ff is reserved by the spec and must be rejected.
 *
 * Reference: https://www.w3.org/TR/trace-context/#traceparent-header
 */
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * All-zero trace IDs and span IDs are explicitly invalid per W3C spec §2.2.4.
 */
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/**
 * Parsed W3C traceparent fields.
 */
export interface TraceparentFields {
  /** Version byte, e.g. "00". */
  version: string;
  /** 128-bit trace ID as 32 lowercase hex chars. */
  traceId: string;
  /** 64-bit parent span ID as 16 lowercase hex chars. */
  parentId: string;
  /** Trace flags as 2 hex chars (bit 0 = sampled). */
  flags: string;
  /** True when the sampled flag (bit 0) is set. */
  sampled: boolean;
}

/**
 * Parse and validate a W3C traceparent header value.
 *
 * Returns `null` for any invalid, missing, or spec-reserved value so callers
 * can fall back gracefully to correlation-ID-only tracing.
 *
 * Security hardening:
 * 1. Length-bounds check before regex (prevents ReDoS on pathological inputs).
 * 2. Anchored regex — no partial match possible.
 * 3. Reserved version ff → rejected.
 * 4. All-zero traceId / parentId → rejected (spec §2.2.4).
 * 5. Input always lower-cased so comparison is case-insensitive but stored
 *    in canonical form.
 *
 * @param raw - Raw header value from the HTTP request (untrusted).
 * @returns Parsed fields, or `null` if invalid.
 */
export function parseTraceparent(raw: unknown): TraceparentFields | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_TRACEPARENT_LENGTH) return null;

  const lower = raw.toLowerCase().trim();
  const m = TRACEPARENT_REGEX.exec(lower);
  if (!m) return null;

  const [, version, traceId, parentId, flags] = m as unknown as [string, string, string, string, string];

  // Reserved version — spec says receivers MUST NOT forward unknown versions
  // without understanding them.
  if (version === 'ff') return null;

  // All-zero IDs are explicitly invalid (spec §2.2.4 / §2.2.5).
  if (traceId === ZERO_TRACE_ID) return null;
  if (parentId === ZERO_SPAN_ID) return null;

  const flagByte = parseInt(flags, 16);
  const sampled = (flagByte & 0x01) === 1;

  return { version, traceId, parentId, flags, sampled };
}

/**
 * Build a W3C traceparent header string from component parts.
 *
 * Always uses version "00" (the only defined version at time of writing).
 *
 * @param traceId  32 lowercase hex chars.
 * @param parentId 16 lowercase hex chars (the span that is the parent of the
 *                 outbound call's new child span).
 * @param sampled  Whether to set the sampled flag.
 * @returns        A spec-compliant traceparent string.
 */
export function buildTraceparent(
  traceId: string,
  parentId: string,
  sampled: boolean = true,
): string {
  const flags = sampled ? '01' : '00';
  return `00-${traceId}-${parentId}-${flags}`;
}

/**
 * AsyncLocalStorage that carries the active trace context for outbound calls.
 * Populated by tracingMiddleware and consumed by Stellar RPC / webhook helpers
 * when building outbound traceparent headers.
 */
export const traceContextStore = new AsyncLocalStorage<TraceparentFields | null>();

/**
 * Retrieve the active W3C trace context from the current async scope.
 * Returns `null` when no upstream traceparent was received or tracing is
 * disabled.
 */
export function getActiveTraceContext(): TraceparentFields | null {
  return traceContextStore.getStore() ?? null;
}


/**
 * AsyncLocalStorage for propagating correlationId through async boundaries.
 * Any code that calls `getCorrelationId()` within the same async context
 * (including callbacks, promises, and timers) will receive the correct ID.
 */
export const correlationStore = new AsyncLocalStorage<string>();

/**
 * Get the correlationId for the current async context.
 * Returns 'unknown' if called outside a request context.
 */
export function getCorrelationId(): string {
  return correlationStore.getStore() ?? 'unknown';
}

/**
 * Request-scoped tracer state.
 * Attached to req.locals so it can be accessed by route handlers.
 */
export interface RequestTraceContext {
  span: Span;
  startTimeMs: number;
  eventLog: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

/**
 * Tracing middleware: hooks request/response lifecycle.
 *
 * Must be registered early in the middleware stack (after correlationId
 * and before routes) so it captures accurate timings.
 *
 * Usage:
 *   app.use(tracingMiddleware(config));
 */
/**
 * Helper to extract stream_id from request headers, body, query, parameters, or path segments.
 */
export function extractStreamId(req: Request): string | undefined {
  const fromHeader = req.headers['x-stream-id'] || req.headers['stream-id'] || req.headers['fluxora-stream-id'];
  if (fromHeader && typeof fromHeader === 'string') return fromHeader;

  const fromBody = req.body?.stream_id || req.body?.streamId || req.body?.id;
  if (fromBody && typeof fromBody === 'string') return fromBody;

  const fromQuery = req.query?.stream_id || req.query?.streamId || req.query?.id;
  if (fromQuery && typeof fromQuery === 'string') return fromQuery;

  const fromParams = req.params?.id || req.params?.streamId;
  if (fromParams && typeof fromParams === 'string') return fromParams;

  const match = req.path.match(/^\/api\/streams\/([^/]+)/);
  if (match && match[1] && match[1] !== 'rate-limits' && match[1] !== 'health') {
    return match[1];
  }
  return undefined;
}

/**
 * Helper to extract sender_address from request headers, body, or query.
 */
export function extractSenderAddress(req: Request): string | undefined {
  const fromHeader = req.headers['x-sender-address'] || req.headers['sender-address'] || req.headers['x-sender'];
  if (fromHeader && typeof fromHeader === 'string') return fromHeader;

  const fromBody = req.body?.sender_address || req.body?.senderAddress || req.body?.sender;
  if (fromBody && typeof fromBody === 'string') return fromBody;

  const fromQuery = req.query?.sender_address || req.query?.senderAddress || req.query?.sender;
  if (fromQuery && typeof fromQuery === 'string') return fromQuery;

  return undefined;
}

/**
 * Helper to extract recipient_address from request headers, body, or query.
 */
export function extractRecipientAddress(req: Request): string | undefined {
  const fromHeader = req.headers['x-recipient-address'] || req.headers['recipient-address'] || req.headers['x-recipient'];
  if (fromHeader && typeof fromHeader === 'string') return fromHeader;

  const fromBody = req.body?.recipient_address || req.body?.recipientAddress || req.body?.recipient;
  if (fromBody && typeof fromBody === 'string') return fromBody;

  const fromQuery = req.query?.recipient_address || req.query?.recipientAddress || req.query?.recipient;
  if (fromQuery && typeof fromQuery === 'string') return fromQuery;

  return undefined;
}

export function tracingMiddleware(
  config?: { enabled?: boolean; sampleRate?: number },
): (req: Request, res: Response, next: NextFunction) => void {
  const tracer = getTracer();
  const enabled = config?.enabled ?? false;

  return (req: Request, res: Response, next: NextFunction): void => {
    const correlationId = req.correlationId ?? 'unknown';

    // ── W3C traceparent parsing ──────────────────────────────────────────────
    // Attempt to continue an upstream trace by parsing the inbound
    // `traceparent` header.  On success, the upstream traceId is used for
    // this request's span so all service-boundary hops share a single trace.
    // On failure (missing / malformed header) we fall back to the local
    // correlation ID as the traceId, preserving existing behaviour.
    const inboundTraceparent = parseTraceparent(req.headers['traceparent']);

    if (!enabled) {
      // Still propagate correlationId and traceContext even when tracing is disabled.
      return correlationStore.run(correlationId, () =>
        traceContextStore.run(inboundTraceparent, () => next())
      );
    }

    correlationStore.run(correlationId, () => {
      traceContextStore.run(inboundTraceparent, () => {
      try {
        const startTimeMs = Date.now();

        // Determine if this request should be sampled.
        // If the upstream explicitly set the sampled flag, honour it.
        const sampleRate = config?.sampleRate ?? 1.0;
        const shouldSample = inboundTraceparent?.sampled ?? (Math.random() < sampleRate);

        // Use the upstream traceId when a valid traceparent was received so
        // this span is part of the same distributed trace.
        const effectiveTraceId = inboundTraceparent?.traceId ?? correlationId;

        // Create a span for this request.  Optional fields are only assigned
        // when defined to satisfy `exactOptionalPropertyTypes: true`.
        const startContext: Omit<SpanContext, 'spanId'> = {
          traceId: effectiveTraceId,
          serviceName: 'fluxora-api',
          tags: {
            'http.method': req.method,
            'http.path': req.path,
            'http.ip': req.ip,
            'http.user_agent': req.headers['user-agent'],
            'otel.enabled': shouldSample,
          },
        };

        // When continuing an upstream trace, record the upstream parentId
        // so the full parent→child chain is visible in trace UIs.
        if (inboundTraceparent) {
          startContext.parentSpanId = inboundTraceparent.parentId;
          if (startContext.tags) {
            startContext.tags['traceparent.version'] = inboundTraceparent.version;
            startContext.tags['traceparent.flags'] = inboundTraceparent.flags;
            startContext.tags['traceparent.sampled'] = inboundTraceparent.sampled;
          }
        }

        const streamId = extractStreamId(req);
        const sender = extractSenderAddress(req);
        const recipient = extractRecipientAddress(req);

        if (streamId !== undefined) {
          startContext.tags!['fluxora.stream_id'] = streamId;
        }
        if (sender !== undefined) {
          startContext.tags!['fluxora.sender'] = sender;
        }
        if (recipient !== undefined) {
          startContext.tags!['fluxora.recipient'] = recipient;
        }

        const userId = extractUserId(req);
        if (userId !== undefined) {
          startContext.userId = userId;
        }
        const span = tracer.startSpan(startContext);

        // Try to attach attributes to active OTel span immediately if it exists
        try {
          const activeSpan = trace.getActiveSpan();
          if (activeSpan) {
            if (streamId) activeSpan.setAttribute('fluxora.stream_id', streamId);
            if (sender) activeSpan.setAttribute('fluxora.sender', sender);
            if (recipient) activeSpan.setAttribute('fluxora.recipient', recipient);
          }
        } catch {
          // ignore OTel errors
        }

        // Attach span to request locals for access by routes
        if (!res.locals) {
          res.locals = {};
        }
        res.locals.traceContext = {
          span,
          startTimeMs,
          eventLog: [],
        } as RequestTraceContext;

        // Record response and finalize span
        res.on('finish', () => {
          const durationMs = Date.now() - startTimeMs;

          // Re-extract in case they were added dynamically during request execution
          const finalStreamId = extractStreamId(req);
          const finalSender = extractSenderAddress(req);
          const finalRecipient = extractRecipientAddress(req);

          try {
            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
              if (finalStreamId) activeSpan.setAttribute('fluxora.stream_id', finalStreamId);
              if (finalSender) activeSpan.setAttribute('fluxora.sender', finalSender);
              if (finalRecipient) activeSpan.setAttribute('fluxora.recipient', finalRecipient);
            }
          } catch {
            // ignore
          }

          if (span.context.tags) {
            if (finalStreamId) span.context.tags['fluxora.stream_id'] = finalStreamId;
            if (finalSender) span.context.tags['fluxora.sender'] = finalSender;
            if (finalRecipient) span.context.tags['fluxora.recipient'] = finalRecipient;
          }

          tracer.recordEvent(span, 'http.response', {
            statusCode: res.statusCode,
            durationMs,
            contentLength: res.getHeader('content-length'),
          });

          const status = res.statusCode < 400 ? 'ok' : 'error';
          tracer.endSpan(span, status, `HTTP ${res.statusCode}`);
        });

        // Capture any unhandled errors during request processing
        res.on('close', () => {
          if (!res.writableEnded) {
            tracer.endSpan(span, 'error', 'Request aborted or closed unexpectedly');
          }
        });

        next();
      } catch {
        // Tracing initialization error; continue without tracing
        next();
      }
      });
    });
  };
}

/**
 * Get the trace context from a response object (for route handlers).
 */
export function getTraceContext(res: Response): RequestTraceContext | undefined {
  return (res.locals as { traceContext?: RequestTraceContext } | undefined)?.traceContext;
}

/**
 * Record an event in the current request's trace span.
 */
export function recordTraceEvent(
  res: Response,
  eventName: string,
  attributes?: Record<string, unknown>
): void {
  const context = getTraceContext(res);
  if (!context) {
    return;
  }

  const tracer = getTracer();
  tracer.recordEvent(context.span, eventName, attributes);

  // Also buffer in request locals for debugging
  context.eventLog.push({
    name: eventName,
    timestamp: Date.now(),
    ...(attributes !== undefined ? { attributes } : {}),
  });
}

/**
 * Record an error in the current request's trace span.
 */
export function recordTraceError(
  req: Request,
  res: Response,
  error: Error,
  context?: Record<string, unknown>
): void {
  const correlationId = req.correlationId ?? 'unknown';
  const tracer = getTracer();

  tracer.recordError(correlationId, error, {
    ...context,
    path: req.path,
    method: req.method,
  });

  // Also record in the span if available
  const traceContext = getTraceContext(res);
  if (traceContext) {
    tracer.recordEvent(traceContext.span, 'error', {
      errorName: error.name,
      errorMessage: error.message,
      ...context,
    });
  }
}

/**
 * Extract user identity from request (for audit/identity tracking).
 *
 * Looks for:
 * 1. JWT claims (from authMiddleware)
 * 2. API key metadata (from apiKeyMiddleware)
 *
 * Returns undefined if no user identity found (public endpoints).
 * Sanitized to prevent PII leakage.
 */
function extractUserId(req: Request): string | undefined {
  // Check for JWT claims.  Some deployments populate `sub` on `req.user`; we
  // narrow it here without coupling to a wider auth type.
  const user = req.user as (Express.Request['user'] & { sub?: string }) | undefined;
  if (user?.sub) {
    return `user:${sanitizeId(user.sub)}`;
  }

  // Check for API key (service account)
  const apiKeyId = (req as Request & { apiKeyId?: string }).apiKeyId;
  if (apiKeyId) {
    return `apikey:${sanitizeId(apiKeyId)}`;
  }

  // No authenticated identity
  return undefined;
}

/**
 * Sanitize an ID for safe logging (no PII).
 */
function sanitizeId(id: string): string {
  if (!id) return 'unknown';
  // Take first 8 chars or hash for long IDs, never include full value
  return id.length > 16 ? `${id.substring(0, 8)}...` : id;
}
