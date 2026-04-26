import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';

/**
 * Attach a fresh per-request CSP nonce to res.locals.cspNonce.
 * Mount this before createHelmetMiddleware() so the nonce is available
 * when helmet builds the Content-Security-Policy header.
 */
export function cspNonceMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.locals.cspNonce = randomBytes(16).toString('base64');
  next();
}

/**
 * Configure and return Helmet middleware for security headers.
 *
 * CSP policy (strict):
 * - default-src 'self'
 * - script-src  'self' 'nonce-<per-request>'   (no unsafe-inline/eval)
 * - style-src   'self' 'nonce-<per-request>'   (no unsafe-inline)
 * - img-src     'self' data: https:
 * - connect-src 'self'
 * - font-src    'self'
 * - object-src  'none'
 * - media-src   'self'
 * - frame-src   'none'
 * - upgrade-insecure-requests
 *
 * Deviation from baseline: 'unsafe-inline' is intentionally removed from
 * style-src. Any inline styles must use the per-request nonce instead.
 * See API_BEHAVIOR.md § Content Security Policy for rationale.
 */
export function createHelmetMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const nonce = res.locals.cspNonce as string | undefined;
    const nonceDirective = nonce ? [`'nonce-${nonce}'`] : [];

    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...nonceDirective],
          styleSrc: ["'self'", ...nonceDirective],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
          upgradeInsecureRequests: [],
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
    })(req, res, next);
  };
}
