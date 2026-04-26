/**
 * Correlation-ID middleware.
 *
 * Attaches a correlation ID to every request so that all log lines emitted
 * during that request can be linked together.
 *
 * Behaviour:
 * - If the incoming request carries an `x-correlation-id` header with a
 *   non-empty string value, that value is reused.
 * - Otherwise a new UUID v4 is generated via `crypto.randomUUID()`.
 *
 * The resolved ID is written to `req.correlationId` and echoed back in the
 * `x-correlation-id` response header.
 *
 * Trust boundary: accepted as-is for tracing only — never used for auth.
 */

import { randomUUID } from 'crypto';
import { correlationStore } from '../tracing/middleware.js';

/** Canonical header name used for correlation IDs throughout the service. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidCorrelationId(value: string): boolean {
  return UUID_V4_REGEX.test(value);
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

export function correlationIdMiddleware(req: any, res: any, next: any): void {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);

  correlationStore.run(correlationId, () => {
    req.correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  });
}
