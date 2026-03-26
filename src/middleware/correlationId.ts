/**
 * Correlation-ID middleware.
 *
 * Attaches a correlation ID to every request so that all log lines emitted
 * during that request can be linked together.
 *
 * Behaviour:
 * - If the incoming request carries an `x-correlation-id` header with a
 *   non-empty string value, that value is reused (allows clients and upstream
 *   proxies to propagate their own IDs).
 * - Otherwise a new UUID v4 is generated via `crypto.randomUUID()`.
 *
 * The resolved ID is:
 * - Written to `req.correlationId` for downstream handlers and middleware.
 * - Echoed back in the `x-correlation-id` response header so clients can
 *   reference it in support or audit requests.
 *
 * Trust boundary: the header value from public-internet clients is accepted
 * as-is for tracing but is never used for authentication or authorisation.
 */

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/** Canonical header name used for correlation IDs throughout the service. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming.trim()
      : randomUUID();

  req.correlationId = correlationId;
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  next();
}
