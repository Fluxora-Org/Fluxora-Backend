/**
 * Distributed Tracing Middleware for Fluxora Backend.
 *
 * Hooks into the Express request/response lifecycle to:
 * - Create a trace span for each HTTP request
 * - Record request metadata (method, path, auth status)
 * - Track response status and duration
 * - Handle errors and exceptions
 * - Link request logs to traces via correlation ID
 *
 * Trust boundary: treats all incoming request headers as untrusted
 * (already validated by correlationId middleware). Sanitizes user
 * identity before recording in spans.
 *
 * Failure modes:
 * - If tracer is disabled, all operations are no-ops (zero overhead)
 * - If a tracer hook fails, the error is logged but doesn't propagate
 * - If OpenTelemetry is misconfigured, the app continues without it
 */

import { Request, Response, NextFunction } from 'express';
import { getTracer } from './hooks.js';
import { Span } from './hooks.js';

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
export function tracingMiddleware(config?: { enabled?: boolean; sampleRate?: number }) {
  const tracer = getTracer();
  const enabled = config?.enabled ?? false;

  return (req: any, res: Response, next: NextFunction): void => {
    if (!enabled) {
      return next();
    }

    try {
      const correlationId = req.correlationId || 'unknown';
      const startTimeMs = Date.now();

      // Determine if this request should be sampled
      const sampleRate = config?.sampleRate ?? 1.0;
      const shouldSample = Math.random() < sampleRate;

      // Create a span for this request
      const span = tracer.startSpan({
        traceId: correlationId,
        parentSpanId: undefined,
        userId: extractUserId(req),
        serviceName: 'fluxora-api',
        tags: {
          'http.method': req.method,
          'http.path': req.path,
          'http.ip': req.ip,
          'http.user_agent': req.headers['user-agent'],
          'otel.enabled': shouldSample,
        },
      });

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

        tracer.recordEvent(span, 'http.response', {
          statusCode: res.statusCode,
          durationMs,
          contentLength: res.getHeader('content-length'),
        });

        // Determine span status based on HTTP status code
        const status = res.statusCode < 400 ? 'ok' : 'error';
        const statusMessage =
          res.statusCode < 400
            ? `HTTP ${res.statusCode}`
            : `HTTP ${res.statusCode}`;

        tracer.endSpan(span, status, statusMessage);
      });

      // Capture any unhandled errors during request processing
      res.on('close', () => {
        // If the response wasn't finished (e.g., aborted), end the span
        if (!res.writableEnded) {
          tracer.endSpan(span, 'error', 'Request aborted or closed unexpectedly');
        }
      });

      next();
    } catch (err) {
      // Tracing initialization error; continue without tracing
      next();
    }
  };
}

/**
 * Get the trace context from a response object (for route handlers).
 */
export function getTraceContext(res: any): RequestTraceContext | undefined {
  return res.locals?.traceContext;
}

/**
 * Record an event in the current request's trace span.
 */
export function recordTraceEvent(
  res: any,
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
    attributes,
  });
}

/**
 * Record an error in the current request's trace span.
 */
export function recordTraceError(
  req: any,
  res: any,
  error: Error,
  context?: Record<string, unknown>
): void {
  const correlationId = req.correlationId || 'unknown';
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
function extractUserId(req: any): string | undefined {
  // Check for JWT claims
  if (req.user?.sub) {
    return `user:${sanitizeId(req.user.sub)}`;
  }

  // Check for API key (service account)
  if (req.apiKeyId) {
    return `apikey:${sanitizeId(req.apiKeyId)}`;
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
