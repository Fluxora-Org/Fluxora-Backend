/**
 * Correlation-ID middleware.
 *
 * Attaches a correlation ID to every request so that all log lines emitted
 * during that request can be linked together.
 *
 * Behaviour:
 * - If the incoming request carries a valid UUID-shaped `x-correlation-id`
 *   header, the trimmed value is reused.
 * - Missing, blank, malformed, oversized, or control-character-bearing values
 *   are rejected and replaced.
 *
 * The resolved ID is written to `req.correlationId` and echoed back in the
 * `x-correlation-id` response header.
 *
 * Trust boundary: accepted only after validation for tracing, never auth.
 */

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { correlationStore } from '../tracing/middleware.js';


/** Canonical header name used for correlation IDs throughout the service. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Standard request-identity header echoed on every response so that clients,
 * proxies, and body-less responses (e.g. 204) can be correlated with server
 * logs without parsing a JSON envelope.  Its value is always identical to the
 * resolved `x-correlation-id`.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

export const MAX_CORRELATION_ID_LENGTH = 36;

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns whether a client-supplied correlation ID is safe to reuse.
 *
 * The middleware accepts only UUID-shaped values so untrusted request headers
 * cannot smuggle log-forging payloads or unbounded strings into downstream
 * traces and webhook headers.
 */
export function isValidCorrelationId(value: string): boolean {
  return value.length <= MAX_CORRELATION_ID_LENGTH && UUID_V4_REGEX.test(value);
}

function resolveCorrelationId(incoming: unknown): string {
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (trimmed.length > 0 && isValidCorrelationId(trimmed)) {
      return trimmed;
    }
  }

  return randomUUID();
}

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);

  correlationStore.run(correlationId, () => {
    req.correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, correlationId);
    next();
  });
}
