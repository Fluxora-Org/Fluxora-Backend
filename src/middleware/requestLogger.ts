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

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logging/logger.js';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { correlationId } = req;
  const startMs = Date.now();

  logger.info('request received', correlationId as string, {
    method: req.method,
    path: req.path,
  });

  res.on('finish', () => {
    const meta = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startMs,
    };

    if (res.statusCode >= 500) {
      logger.error('request failed', correlationId as string, meta);
      return;
    }

    logger.info('request completed', correlationId as string, meta);
  });

  next();
}
