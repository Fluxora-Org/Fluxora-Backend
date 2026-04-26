import { Router } from 'express';
import type { Request, Response } from 'express';
import type { RateLimiter } from '../middleware/rateLimiter.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getRuntimeRateLimitConfig,
  setRuntimeRateLimitConfig,
} from '../config/rateLimits.js';
import type { RateLimitConfig } from '../types/rateLimit.js';

/** Validates a partial RateLimitConfig patch object. Returns an error string or null. */
function validateConfigPatch(obj: unknown): string | null {
  if (typeof obj !== 'object' || obj === null) return 'must be an object';
  const { windowMs, max, enabled } = obj as Record<string, unknown>;
  if (windowMs !== undefined) {
    if (typeof windowMs !== 'number' || !Number.isInteger(windowMs) || windowMs < 1000) {
      return 'windowMs must be an integer >= 1000';
    }
  }
  if (max !== undefined) {
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
      return 'max must be a positive integer';
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  return null;
}

export interface RateLimitsRouterOptions {
  /** Env-seeded config used as the "default" baseline when no runtime override is set. */
  defaults: { ip: RateLimitConfig; apiKey: RateLimitConfig; admin: RateLimitConfig };
}

export function createRateLimitsRouter(limiter: RateLimiter, opts?: RateLimitsRouterOptions) {
  const rateLimitsRouter = Router();

  /**
   * GET /api/rate-limits
   * Returns the caller's current rate-limit status.
   * Optional query parameters: path, method - returns status for specific route
   */
  rateLimitsRouter.get('/', (req: Request, res: Response) => {
    const { identifier, identifierType } = limiter.extractClientIdentifier(req);
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    const method = typeof req.query.method === 'string' ? req.query.method.toUpperCase() : undefined;
    const status = limiter.getStatus(identifier, identifierType, path, method);

    res.setHeader('X-RateLimit-Limit', String(status.limit));
    res.setHeader('X-RateLimit-Remaining', String(status.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(new Date(status.resetsAt).getTime() / 1000)));

    res.json(status);
  });

  /**
   * GET /api/rate-limits/config
   * Returns the active runtime rate-limit configuration (admin only).
   */
  rateLimitsRouter.get('/config', requireAdminAuth, (_req: Request, res: Response) => {
    const runtime = getRuntimeRateLimitConfig();
    const defaults = opts?.defaults;
    res.json({
      ip:     runtime?.ip     ?? defaults?.ip,
      apiKey: runtime?.apiKey ?? defaults?.apiKey,
      admin:  runtime?.admin  ?? defaults?.admin,
      source: runtime ? 'runtime' : 'default',
    });
  });

  /**
   * PUT /api/rate-limits/config
   * Merges a partial config patch into the runtime store (admin only).
   *
   * Body (all keys optional):
   * { "ip": { "max": 200 }, "apiKey": { "windowMs": 120000 }, "admin": { "enabled": false } }
   *
   * Returns 409 if the resulting config would disable all tiers simultaneously.
   */
  rateLimitsRouter.put('/config', requireAdminAuth, (req: Request, res: Response) => {
    const { ip, apiKey, admin } = req.body ?? {};

    if (ip === undefined && apiKey === undefined && admin === undefined) {
      res.status(400).json({ error: 'Body must include at least one of: ip, apiKey, admin.' });
      return;
    }

    for (const [key, val] of [['ip', ip], ['apiKey', apiKey], ['admin', admin]] as const) {
      if (val !== undefined) {
        const err = validateConfigPatch(val);
        if (err) {
          res.status(400).json({ error: `Invalid config for '${key}': ${err}` });
          return;
        }
      }
    }

    const base = getRuntimeRateLimitConfig() ?? {
      ip:     { ...(opts?.defaults?.ip     ?? { windowMs: 60_000, max: 100,  enabled: true }) },
      apiKey: { ...(opts?.defaults?.apiKey ?? { windowMs: 60_000, max: 500,  enabled: true }) },
      admin:  { ...(opts?.defaults?.admin  ?? { windowMs: 60_000, max: 2000, enabled: true }) },
    };
    const merged = {
      ip:     ip     ? { ...base.ip,     ...(ip     as Partial<RateLimitConfig>) } : base.ip,
      apiKey: apiKey ? { ...base.apiKey, ...(apiKey as Partial<RateLimitConfig>) } : base.apiKey,
      admin:  admin  ? { ...base.admin,  ...(admin  as Partial<RateLimitConfig>) } : base.admin,
    };
    if (!merged.ip.enabled && !merged.apiKey.enabled && !merged.admin.enabled) {
      res.status(409).json({ error: 'Cannot disable all rate-limit tiers simultaneously.' });
      return;
    }

    const updated = setRuntimeRateLimitConfig({ ip, apiKey, admin });
    res.json({ message: 'Rate-limit config updated.', config: updated });
  });

  return rateLimitsRouter;
}
