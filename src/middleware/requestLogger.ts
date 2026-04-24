/**
 * Request / response logger middleware.
 *
 * Logs structured records per request:
 *  1. "request received"  — on the way in (method, path).
 *  2. "request completed" — for successful/non-5xx responses.
 *  3. "request failed"    — for 5xx responses (single terminal error log).
 *
 * Both records carry `correlationId`. Must be registered after `correlationIdMiddleware`.
 *
 * Security note: this middleware emits only non-sensitive request attributes
 * (method/path/status/duration/correlationId). Redaction is still enforced by
 * the logger implementation before serialization.
 */

import { logger } from '../logging/logger.js';

export function requestLoggerMiddleware(req: any, res: any, next: any): void {
  const { correlationId } = req;
  const startMs = Date.now();

  logger.info('request received', {
    method: req.method,
    path: req.path,
    correlationId,
  });

  res.on('finish', () => {
    const meta = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startMs,
      correlationId,
    };

    if (res.statusCode >= 500) {
      logger.error('request failed', meta);
      return;
    }

    logger.info('request completed', meta);
  });

  next();
}
