import helmet from 'helmet';
import type { Express } from 'express';

/**
 * Configure and return Helmet middleware for security headers.
 *
 * Helmet sets the following headers on all responses:
 * - Content-Security-Policy: Restricts resource loading
 * - X-Content-Type-Options: nosniff (prevents MIME sniffing)
 * - X-Frame-Options: SAMEORIGIN (prevents clickjacking)
 * - X-XSS-Protection: 0 (modern browsers ignore, but set for legacy support)
 * - Strict-Transport-Security: Enforces HTTPS
 * - X-DNS-Prefetch-Control: off (disables DNS prefetching)
 * - Referrer-Policy: strict-origin-when-cross-origin
 *
 * These headers are applied to all responses, including error responses,
 * because Helmet is mounted early in the middleware chain before route handlers.
 */
export function createHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: 'SAMEORIGIN',
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },
    xssFilter: true,
    noSniff: true,
    dnsPrefetchControl: {
      allow: false,
    },
  });
}
