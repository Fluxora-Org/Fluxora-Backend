/**
 * Request / response logger middleware.
 *
 * Logs two structured records per request:
 *  1. "request received"  — on the way in (method, path, ip).
 *  2. "request completed" — after the response is flushed (statusCode, durationMs).
 *
 * Both records carry `correlationId`. Must be registered after `correlationIdMiddleware`.
 *
 * Security note: all metadata objects are passed through `sanitize()` before
 * being handed to the logger, so IP addresses, auth tokens, and Stellar keys
 * are redacted at the boundary and never reach persistent log storage in the clear.
 * The sanitize call is synchronous and O(n) in the number of fields — negligible
 * overhead compared to network I/O.
 */

import { logger } from '../lib/logger.js';
import { sanitize } from '../pii/sanitizer.js';

export function requestLoggerMiddleware(req: any, res: any, next: any): void {
  const { correlationId } = req;
  const startMs = Date.now();

  logger.info('request received', correlationId, sanitize({
    method: req.method,
    path: req.path,
    ip: req.ip,
  }));

  res.on('finish', () => {
    logger.info('request completed', correlationId, sanitize({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startMs,
    }));
  });

  next();
}
