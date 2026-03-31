/**
 * PII-aware Express middleware.
 *
 * Adds privacy-related response headers and logs each request
 * through the safe logger so that IP addresses, auth tokens,
 * and Stellar keys never reach persistent log storage in the clear.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logging/logger.js';

/**
 * Attaches response headers that instruct clients and intermediaries
 * not to cache responses containing sensitive data, and advertises
 * the privacy policy endpoint.
 */
export function privacyHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Privacy-Policy', '/api/privacy/policy');
  next();
}

/**
 * Logs inbound requests with PII stripped. IP addresses and
 * authorization headers are omitted; only the method, path,
 * and a truncated user-agent are recorded.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('http request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
    });
  });

  next();
}

/**
 * Catches unhandled errors and returns a generic message to the
 * client. The full error (with PII redacted) is sent to the logger
 * so operators can diagnose issues without leaking sensitive data
 * in HTTP responses.
 */
export function safeErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error('unhandled error', {
    error: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred. No sensitive data has been included in this response.',
  });
}
