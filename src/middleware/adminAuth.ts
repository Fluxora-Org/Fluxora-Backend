import type { Request, Response, NextFunction } from 'express';
import { authApiKeyLookupDurationSeconds } from '../metrics/businessMetrics.js';

/**
 * Middleware that gates admin routes behind a Bearer token.
 *
 * The token is compared against the `ADMIN_API_KEY` environment variable.
 * When the variable is unset the service refuses all admin requests —
 * fail-closed rather than fail-open.
 *
 * The check is recorded in `fluxora_auth_apikey_lookup_duration_seconds`
 * with an `outcome` label only — no token material is ever included.
 * "Unconfigured" outcomes are recorded as `failure` so a missing env-var
 * is visible in the same panel as a credential mismatch.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const endTimer = authApiKeyLookupDurationSeconds.startTimer();

  const recordOutcome = (outcome: 'success' | 'failure') => {
    endTimer({ outcome });
  };

  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    recordOutcome('failure');
    res.status(503).json({
      error: 'Admin API is not configured. Set ADMIN_API_KEY to enable admin access.',
    });
    return;
  }

  const header = req.headers.authorization;
  if (!header) {
    recordOutcome('failure');
    res.status(401).json({ error: 'Missing Authorization header.' });
    return;
  }

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    recordOutcome('failure');
    res.status(401).json({ error: 'Authorization header must use Bearer scheme.' });
    return;
  }

  const token = parts[1];
  if (!token) {
    recordOutcome('failure');
    res.status(401).json({ error: 'Bearer token is missing.' });
    return;
  }

  // Constant-time-ish comparison to reduce timing side-channels.
  if (token.length !== adminKey.length || !timingSafeEqual(token, adminKey)) {
    recordOutcome('failure');
    res.status(403).json({ error: 'Invalid admin credentials.' });
    return;
  }

  recordOutcome('success');
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
