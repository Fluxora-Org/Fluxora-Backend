/**
 * Rate limiting middleware for Fluxora Backend.
 *
 * Uses a sliding-window counter stored in the cache layer (Redis in production,
 * in-memory in tests). Falls back to allowing requests when the cache is
 * unavailable so a Redis outage never takes down the API.
 *
 * Trust boundaries
 * ----------------
 * - Applied per IP address (X-Forwarded-For respected when behind a proxy).
 * - Administrators can configure limits per route via RateLimitOptions.
 *
 * Failure modes
 * -------------
 * - Cache unavailable → requests are allowed (fail-open); logged as warn.
 * - Limit exceeded    → 429 Too Many Requests with Retry-After header.
 *
 * @module middleware/rateLimit
 */

import type { Request, Response, NextFunction } from 'express';
import { getCacheClient } from '../cache/redis.js';
import { logger } from '../lib/logger.js';

export interface RateLimitOptions {
  /** Maximum requests allowed in the window. */
  max: number;
  /** Window duration in seconds. */
  windowSeconds: number;
  /** Cache key prefix to namespace different limiters. */
  keyPrefix?: string;
}

const DEFAULT_OPTIONS: RateLimitOptions = {
  max: 100,
  windowSeconds: 60,
  keyPrefix: 'rl',
};

/**
 * Extract the client IP, respecting X-Forwarded-For when set.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0];
    /* istanbul ignore next */
    if (first !== undefined) return first.trim();
  }
  /* istanbul ignore next */
  return req.ip ?? 'unknown';
}

/**
 * Build the cache key for a given IP and window bucket.
 */
function buildKey(prefix: string, ip: string, windowSeconds: number): string {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  return `fluxora:${prefix}:${ip}:${bucket}`;
}

/**
 * Create a rate-limiting middleware with the given options.
 *
 * @example
 * app.use('/api/streams', createRateLimiter({ max: 50, windowSeconds: 60 }));
 */
export function createRateLimiter(options: Partial<RateLimitOptions> = {}) {
  const opts: RateLimitOptions = { ...DEFAULT_OPTIONS, ...options };

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const cache = getCacheClient();
    const ip = getClientIp(req);
    const key = buildKey(opts.keyPrefix ?? 'rl', ip, opts.windowSeconds);

    try {
      const current = await cache.get<number>(key);
      const count = (current ?? 0) + 1;

      if (count > opts.max) {
        const retryAfter = opts.windowSeconds;
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-RateLimit-Limit', String(opts.max));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + retryAfter));

        logger.warn('Rate limit exceeded', req.correlationId, { ip, count, max: opts.max });

        res.status(429).json({
          error: {
            code: 'rate_limit_exceeded',
            message: `Too many requests. Limit is ${opts.max} per ${opts.windowSeconds}s window.`,
            status: 429,
            retryAfter,
          },
        });
        return;
      }

      // Increment counter; set TTL on first write
      await cache.set(key, count, opts.windowSeconds);

      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + opts.windowSeconds));
    } catch (err) {
      // Fail-open: log and continue
      logger.warn('Rate limiter cache error — allowing request', req.correlationId, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    next();
  };
}
