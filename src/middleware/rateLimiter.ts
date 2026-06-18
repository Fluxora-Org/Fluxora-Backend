import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { RateLimitConfig, RateLimitStatus, RateLimitStore, RouteRateLimitConfig } from '../types/rateLimit.js';
import { getRateLimitConfig, getRouteRateLimitConfig } from '../config/rateLimits.js';
import { InMemoryStore, SlidingWindowStore, HybridStore } from '../redis/rateLimitStore.js';
import { createRedisClient } from '../redis/client.js';
import { logger } from '../lib/logger.js';
import { rateLimitRejectedTotal, rateLimitRedisErrorsTotal } from '../metrics.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEMPT_PATHS = new Set(['/', '/health', '/api/rate-limits']);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function maskApiKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function getRemainingRequests(count: number, max: number): number {
  return Math.max(0, max - count);
}

function secondsUntil(resetAt: number): number {
  return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
}

/**
 * Hash an API key with SHA-256 so raw key material is never written to Redis.
 * Returns a 64-char hex digest.
 */
function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function buildStoreKey(
  identifierType: 'ip' | 'apiKey',
  identifier: string,
  routeKey: string,
): string {
  // API keys are hashed before reaching the store; IPs are passed as-is.
  // The SlidingWindowStore will sanitise the identifier further.
  const id = identifierType === 'apiKey' ? hashApiKey(identifier) : identifier;
  return `${identifierType}:${id}:${routeKey}`;
}

function routeKeyFromPath(path: string | undefined): string {
  if (!path) return 'global';
  return path.replace(/\//g, '_').replace(/^_/, '') || 'global';
}

function buildErrorBody(
  identifier: string,
  identifierType: string,
  limit: number,
  windowMs: number,
  retryAfterSeconds: number,
  route?: string,
  method?: string,
) {
  const body: {
    error: {
      code: string;
      message: string;
      retryAfter: number;
      limit: number;
      window: string;
      identifier: string;
      route?: string;
      method?: string;
    };
  } = {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Retry after ${retryAfterSeconds} seconds.`,
      retryAfter: retryAfterSeconds,
      limit,
      window: windowMs === 60_000 ? 'minute' : 'unknown',
      identifier: identifierType === 'ip' ? identifier : maskApiKey(identifier),
    },
  };
  if (route) body.error.route = route;
  if (method) body.error.method = method;
  return body;
}

// ---------------------------------------------------------------------------
// Public identifier extractor (unchanged contract)
// ---------------------------------------------------------------------------

export function extractClientIdentifier(req: Request): {
  identifier: string;
  identifierType: 'ip' | 'apiKey';
} {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return { identifier: apiKey, identifierType: 'apiKey' };
  }
  const ip =
    (req as Request & { ip?: string }).ip ??
    req.socket.remoteAddress ??
    'unknown';
  return { identifier: ip, identifierType: 'ip' };
}

// ---------------------------------------------------------------------------
// RateLimiter interface
// ---------------------------------------------------------------------------

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Returns the caller's current rate-limit status (async — queries the store). */
  getStatus(
    identifier: string,
    identifierType: 'ip' | 'apiKey',
    path?: string,
    method?: string,
  ): Promise<RateLimitStatus>;
  extractClientIdentifier(req: Request): { identifier: string; identifierType: 'ip' | 'apiKey' };
  /** The backing store — used by GET /api/rate-limits to read live counts. */
  store: RateLimitStore;
  /** Closes the backing store (called during graceful shutdown). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRateLimiter(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  /** Optional store injection — used in tests to bypass Redis. */
  injectedStore?: RateLimitStore,
): RateLimiter {
  const { ip: ipConfig, apiKey: apiKeyConfig, admin: adminConfig, allowlistIps } =
    getRateLimitConfig(env);

  // Build admin key set
  const adminKeys = new Set<string>();
  const adminKeyEnv = env.ADMIN_API_KEY ?? '';
  for (const k of adminKeyEnv.split(',').map((s) => s.trim())) {
    if (k) adminKeys.add(k);
  }

  // ── Store selection ──────────────────────────────────────────────────────
  let store: RateLimitStore;

  if (injectedStore) {
    store = injectedStore;
  } else if (env.REDIS_ENABLED === 'false') {
    // Redis explicitly disabled — use in-memory only
    logger.warn('Redis disabled (REDIS_ENABLED=false); using in-memory rate-limit store');
    store = new InMemoryStore();
  } else {
    // Build HybridStore: SlidingWindowStore (primary) + InMemoryStore (fallback)
    const fallback = new InMemoryStore();

    const onRedisError = (err: unknown, op: string) => {
      logger.warn('Rate-limit Redis error — falling back to in-memory store', undefined, {
        operation: op,
        error: err instanceof Error ? err.message : String(err),
      });
      rateLimitRedisErrorsTotal.inc({ operation: op });
    };

    try {
      const redisUrl = env.REDIS_URL ?? 'redis://localhost:6379';
      // createRedisClient is async; we build the store lazily via a promise
      // and swap it in once connected. Until then HybridStore uses fallback.
      const primary = new InMemoryStore(); // temporary placeholder
      const hybrid = new HybridStore(primary, fallback, onRedisError);
      store = hybrid;

      // Kick off async Redis connection; replace primary when ready
      createRedisClient({ url: redisUrl, enabled: true })
        .then((client) => {
          const slidingWindow = new SlidingWindowStore(client);
          // Swap the primary inside the hybrid by replacing the store reference
          // We rebuild the hybrid with the real primary
          const realHybrid = new HybridStore(slidingWindow, fallback, onRedisError);
          store = realHybrid;
          // Update the handler's store reference
          rateLimitHandler.store = realHybrid;
        })
        .catch((err) => {
          logger.warn('Failed to connect to Redis for rate limiting; using in-memory store', undefined, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      logger.warn('Failed to initialise Redis rate-limit store; using in-memory store', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
      store = fallback;
    }
  }

  // ── Effective limit resolver ─────────────────────────────────────────────

  function resolveEffectiveLimit(
    baseConfig: RateLimitConfig,
    routeConfig: RouteRateLimitConfig | null,
    method: string,
  ): { effectiveLimit: number; isExempt: boolean } {
    if (!routeConfig) return { effectiveLimit: baseConfig.max, isExempt: false };
    if (routeConfig.exempt) return { effectiveLimit: baseConfig.max, isExempt: true };

    let effectiveLimit =
      routeConfig.baseLimit > 0 ? routeConfig.baseLimit : baseConfig.max;

    const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (isWriteMethod && routeConfig.writeLimit > 0) {
      effectiveLimit = routeConfig.writeLimit;
    }

    return { effectiveLimit, isExempt: false };
  }

  // ── Request handler ──────────────────────────────────────────────────────

  async function rateLimitHandlerAsync(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!ipConfig.enabled && !apiKeyConfig.enabled) {
      return next();
    }

    const path = req.path;
    const method = req.method;

    if (EXEMPT_PATHS.has(path)) {
      return next();
    }

    const { identifier, identifierType } = extractClientIdentifier(req);

    if (identifierType === 'ip' && allowlistIps.has(identifier)) {
      return next();
    }

    const isAdmin = identifierType === 'apiKey' && adminKeys.has(identifier);
    const config = isAdmin ? adminConfig : identifierType === 'apiKey' ? apiKeyConfig : ipConfig;

    if (!config.enabled) {
      return next();
    }

    const routeConfig = getRouteRateLimitConfig(path);
    const { effectiveLimit, isExempt } = resolveEffectiveLimit(config, routeConfig, method);

    if (isExempt) {
      return next();
    }

    const routeKey = routeKeyFromPath(path);
    const storeKey = buildStoreKey(identifierType, identifier, routeKey);

    let count: number;
    let resetAt: number;
    let storeBackend: 'redis' | 'memory';

    try {
      const result = await store.increment(storeKey, config.windowMs, effectiveLimit);
      count = result.count;
      resetAt = result.resetAt;
      // Detect which backend was used
      storeBackend =
        store instanceof HybridStore && store.usingFallback ? 'memory' : 'redis';
    } catch (err) {
      // Should not reach here (HybridStore swallows errors), but be safe
      logger.warn('Unexpected rate-limit store error; allowing request', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
      return next();
    }

    // Set store indicator header
    res.setHeader('X-RateLimit-Store', storeBackend);

    const resetAtSeconds = Math.ceil(resetAt / 1000);

    if (count > effectiveLimit) {
      const retryAfter = secondsUntil(resetAt);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(resetAtSeconds));

      // Observability
      logger.warn('Rate limit exceeded', undefined, {
        identifier: identifierType === 'ip' ? identifier : maskApiKey(identifier),
        identifierType,
        route: path,
        method,
        limit: effectiveLimit,
        window: config.windowMs,
      });
      rateLimitRejectedTotal.inc({ identifier_type: identifierType, route: routeKey });

      res
        .status(429)
        .json(buildErrorBody(identifier, identifierType, effectiveLimit, config.windowMs, retryAfter, path, method));
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
    res.setHeader('X-RateLimit-Remaining', String(getRemainingRequests(count, effectiveLimit)));
    res.setHeader('X-RateLimit-Reset', String(resetAtSeconds));

    next();
  }

  function rateLimitHandler(req: Request, res: Response, next: NextFunction): void {
    rateLimitHandlerAsync(req, res, next).catch(next);
  }

  // ── getStatus (async — queries live store) ───────────────────────────────

  async function getStatus(
    identifier: string,
    identifierType: 'ip' | 'apiKey',
    path?: string,
    method?: string,
  ): Promise<RateLimitStatus> {
    const isAdmin = identifierType === 'apiKey' && adminKeys.has(identifier);
    const config = isAdmin ? adminConfig : identifierType === 'apiKey' ? apiKeyConfig : ipConfig;

    const routeConfig = path ? getRouteRateLimitConfig(path) : null;
    const { effectiveLimit } = resolveEffectiveLimit(config, routeConfig, method ?? 'GET');

    const routeKey = routeKeyFromPath(path);
    const storeKey = buildStoreKey(identifierType, identifier, routeKey);

    let count = 0;
    let resetAt = Date.now() + config.windowMs;
    let storeBackend: 'redis' | 'memory' = 'redis';
    let degraded = false;

    try {
      const result = await store.getCount(storeKey, config.windowMs);
      count = result.count;
      resetAt = result.resetAt;
      if (store instanceof HybridStore && store.usingFallback) {
        storeBackend = 'memory';
        degraded = true;
      }
    } catch {
      // Fallback to zero count on unexpected error
      degraded = true;
      storeBackend = 'memory';
    }

    const status: RateLimitStatus = {
      identifier: identifierType === 'ip' ? identifier : maskApiKey(identifier),
      identifierType,
      limit: effectiveLimit,
      remaining: getRemainingRequests(count, effectiveLimit),
      resetsAt: new Date(resetAt).toISOString(),
      window: config.windowMs === 60_000 ? 'minute' : 'unknown',
      store: storeBackend,
      degraded: degraded || undefined,
    };
    if (path !== undefined) status.route = path;
    if (method !== undefined) status.method = method;
    return status;
  }

  rateLimitHandler.getStatus = getStatus;
  rateLimitHandler.extractClientIdentifier = extractClientIdentifier;
  rateLimitHandler.store = store;
  rateLimitHandler.close = async () => {
    await rateLimitHandler.store.close();
  };

  return rateLimitHandler;
}

// ---------------------------------------------------------------------------
// Utility export (unchanged)
// ---------------------------------------------------------------------------

export function isAdminKey(
  key: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  const adminKeyEnv = env.ADMIN_API_KEY ?? '';
  if (!adminKeyEnv) return false;
  const adminKeys = new Set(
    adminKeyEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return adminKeys.has(key);
}
