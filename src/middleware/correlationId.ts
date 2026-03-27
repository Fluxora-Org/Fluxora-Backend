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

/** Canonical header name used for correlation IDs throughout the service. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export function correlationIdMiddleware(req: any, res: any, next: any): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming.trim()
      : randomUUID();

  req.correlationId = correlationId;
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  next();
}
