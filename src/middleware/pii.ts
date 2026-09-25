/**
 * PII-aware Express middleware.
 *
 * Adds privacy-related response headers and logs each request
 * through the safe logger so that IP addresses, auth tokens,
 * and Stellar keys never reach persistent log storage in the clear.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { redactKeysInString, sanitize } from '../pii/sanitizer.js';

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
 * Applies the field policy to JSON at the last response write point. Express
 * routes, direct `res.send` calls, and error handlers all pass through here.
 * Sanitizing the serialized JSON keeps Date and custom `toJSON` behavior intact.
 */
export function sanitizeResponses(req: Request, res: Response, next: NextFunction): void {
  const send = res.send.bind(res);

  res.send = ((body?: unknown): Response => {
    const contentType = res.getHeader('Content-Type');
    const mediaType =
      typeof contentType === 'string'
        ? contentType.split(';', 1)[0]?.trim().toLowerCase()
        : undefined;
    const serialized =
      typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : undefined;

    if (
      serialized === undefined ||
      !mediaType ||
      (mediaType !== 'application/json' && !mediaType.endsWith('+json'))
    ) {
      return send(body);
    }

    // The public policy document describes field rules rather than returning
    // personal data. Keep its published shape intact for clients and auditors.
    if (req.method === 'GET' && req.path === '/api/privacy/policy' && res.statusCode < 400) {
      return send(body);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      // An invalid JSON response cannot be checked against the policy.
      res.status(500);
      return send('{"error":"Response serialization failed"}');
    }

    const sanitized = sanitize(parsed as Record<string, unknown>);
    if (
      req.method === 'POST' &&
      req.path === '/api/auth/session' &&
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      isRecord(parsed) &&
      isRecord(sanitized)
    ) {
      // The session endpoint must return its newly issued token and the
      // authenticated user's address. Every other policy field stays redacted.
      if (typeof parsed.token === 'string') sanitized.token = parsed.token;
      if (
        isRecord(parsed.user) &&
        isRecord(sanitized.user) &&
        typeof parsed.user.address === 'string'
      ) {
        sanitized.user.address = parsed.user.address;
      }
    }
    res.removeHeader('Content-Length');
    res.removeHeader('ETag');
    return send(JSON.stringify(sanitized));
  }) as Response['send'];

  next();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    logger.info('http request', req.correlationId as string, {
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
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error('unhandled error', req.correlationId as string, {
    error: redactKeysInString(err.message),
    stack: process.env.NODE_ENV === 'production' ? undefined : redactKeysInString(err.stack || ''),
  });

  res.status(500).json({
    ...errorResponse('INTERNAL_ERROR', 'An unexpected error occurred. No sensitive data has been included in this response.', undefined, req.correlationId),
  });
}

/**
 * Sanitizes all outbound JSON responses to ensure no PII escapes.
 * Failures to sanitize result in a 500 error, failing closed.
 */
export function responseSanitizer(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json;
  res.json = function(body: any) {
    try {
      body = sanitize(body);
    } catch (e) {
      logger.error('failed to sanitize response body', req.correlationId as string, { error: e });
      return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Internal server error', undefined, req.correlationId));
    }
    return originalJson.call(this, body);
  };
  next();
}
