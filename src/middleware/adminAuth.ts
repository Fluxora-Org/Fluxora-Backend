import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that gates admin routes behind a Bearer token.
 *
 * The token is compared against the `ADMIN_API_KEY` environment variable.
 * When the variable is unset the service refuses all admin requests —
 * fail-closed rather than fail-open.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    res.status(503).json({
      error: 'Admin API is not configured. Set ADMIN_API_KEY to enable admin access.',
    });
    return;
  }

  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({ error: 'Missing Authorization header.' });
    return;
  }

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({ error: 'Authorization header must use Bearer scheme.' });
    return;
  }

  const token = parts[1];
  if (!token) {
    res.status(401).json({ error: 'Bearer token is missing.' });
    return;
  }

  // Constant-time-ish comparison to reduce timing side-channels.
  if (token.length !== adminKey.length || !timingSafeEqual(token, adminKey)) {
    res.status(403).json({ error: 'Invalid admin credentials.' });
    return;
  }

  next();
}

/**
 * Best-effort constant-time string comparison.
 * Uses Node's crypto.timingSafeEqual when available, falls back to
 * a byte-by-byte OR accumulator.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  try {
    const { timingSafeEqual: nativeEqual } = require('crypto');
    return nativeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }
}
