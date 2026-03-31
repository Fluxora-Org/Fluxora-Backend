/**
 * Rate limiting middleware.
 *
 * Reads config from environment:
 *   RATE_LIMIT_WINDOW_MS   window in ms (default 60000 = 1 min)
 *   RATE_LIMIT_MAX         max requests per window per IP (default 100)
 *
 * Returns 429 with a standard error envelope on breach.
 */

import rateLimit from 'express-rate-limit';

export function createRateLimiter(opts?: { windowMs?: number; max?: number }) {
  const windowMs = opts?.windowMs ?? parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
  const max = opts?.max ?? parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later.',
        },
      });
    },
  });
}
