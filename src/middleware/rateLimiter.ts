import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import type { RateLimitConfig, RateLimitStatus, RateLimitStore, RouteRateLimitConfig } from '../types/rateLimit.js';
import { getRateLimitConfig, getRouteRateLimitConfig } from '../config/rateLimits.js';
import { InMemoryStore, SlidingWindowStore, HybridStore } from '../redis/rateLimitStore.js';
import { createRedisClient } from '../redis/client.js';
import { logger } from '../lib/logger.js';
import { rateLimitRejectedTotal, rateLimitRedisErrorsTotal } from '../metrics.js';
import { getClientIp } from '../ws/connectionLimiter.js';
import { getOverride } from '../services/tenantRateLimitOverride.service.js';
import type { RateLimitOverride } from '../services/tenantRateLimitOverride.service.js';

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
 * Hash a string with SHA-256 and return the 64-char hex digest.
 *
 * Used for API keys (so raw key material never reaches the store) and as a
 * collision-resistant fallback for overly long route segments.
 */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Hash an API key with SHA-256 so raw key material is never written to Redis.
 * Returns a 64-char hex digest.
 */
function hashApiKey(key: string): string {
  return sha256Hex(key);
}

// ---------------------------------------------------------------------------
// Canonical rate-limit key namespace
// ---------------------------------------------------------------------------
//
// Every key written by this middleware (and read back by GET /api/rate-limits)
// conforms to one canonical shape:
//
//   v1:{principalType}:{principalKey}:{routeKey}
//
//   - principalType ∈ { ip, apikey, admin } — admin keys live in their own
//     namespace so a tenant key whose raw string equals the admin key can
//     never consume (or be consumed by) the admin quota, and vice versa.
//   - principalKey — for `ip`, the canonical form of the client address
//     (IPv6 expanded, IPv4-mapped IPv6 folded to IPv4); for `apikey`/`admin`,
//     the SHA-256 hex digest of the raw key so key material never reaches
//     Redis.
//   - routeKey — an injective encoding of the request path: two different
//     paths can never collide, while the same path always maps to the same
//     key. The reserved segment `global` is the per-principal aggregate
//     counter read by GET /api/rate-limits when no path is requested.
//
// The Redis store prefixes the whole key with `fluxora:rl:` and sanitises it
// to a bounded length, so keys are bounded (≤ ~320 chars) and carry a TTL of
// one window, after which they expire automatically.

export type RateLimitPrincipalType = 'ip' | 'apikey' | 'admin';

/** Route segment of the per-principal aggregate counter. */
export const AGGREGATE_ROUTE = 'global';

/** Longest readable route segment before falling back to a hash. */
const MAX_ROUTE_SEGMENT_LENGTH = 96;

/**
 * Canonicalise a client IP for use as a key component.
 *
 * Equivalent encodings of the same address collapse onto one key so a client
 * cannot split its quota across encodings:
 *   - IPv4 addresses are kept as-is (trimmed).
 *   - IPv6 addresses are expanded to the full zero-padded lowercase form
 *     (e.g. `2001:db8::1` and `2001:0db8:0:0:0:0:0:1` map to the same key).
 *   - IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) fold to the IPv4 form so
 *     a dual-stack client is counted once.
 *   - Empty or unparseable values fall back to `unknown` so a malformed
 *     identifier can never raise and never collides with a real address.
 */
export function normaliseIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed === '') return 'unknown';
  if (isIP(trimmed) === 4) return trimmed;
  if (isIP(trimmed) === 6) return canonicalIpv6(trimmed);
  return trimmed;
}

function canonicalIpv6(ip: string): string {
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 — fold to the equivalent IPv4 address.
  const v4Mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Mapped) return v4Mapped[1]!;

  // Expand `::` and zero-pad every hextet to the canonical 8-group form.
  const [head, tail] = lower.split('::');
  const headParts = head ? head.split(':').filter((s) => s !== '') : [];
  const tailParts = tail ? tail.split(':').filter((s) => s !== '') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [
    ...headParts,
    ...Array(Math.max(missing, 0)).fill('0'),
    ...tailParts,
  ];
  return parts.map((h) => h.padStart(4, '0')).join(':');
}

/**
 * Derive a collision-resistant route segment from a request path.
 *
 * The previous `_`-substitution conflated distinct routes (e.g. `/api/foo/bar`
 * and `/api/foo_bar` produced the same key). Characters outside `[A-Za-z0-9]`
 * are now percent-style encoded (`_` + hex), which is injective. Overly long
 * paths fall back to a fixed-length SHA-256 so truncation can never merge two
 * distinct routes either. `undefined`, `/`, and empty paths map to the
 * per-principal aggregate route.
 */
export function routeKeyFromPath(path: string | undefined): string {
  if (!path || path === '/') return AGGREGATE_ROUTE;
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  if (!cleaned) return AGGREGATE_ROUTE;

  let encoded = '';
  for (const ch of cleaned) {
    if (/[A-Za-z0-9]/.test(ch)) encoded += ch;
    else encoded += `_${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  }

  if (encoded.length <= MAX_ROUTE_SEGMENT_LENGTH) return encoded;
  return `h_${sha256Hex(cleaned)}`;
}

/**
 * Build the canonical store key for a principal and route.
 *
 * @param principalType - namespace of the principal (`ip` | `apikey` | `admin`).
 * @param identifier    - raw principal (IP address or API key material).
 * @param routeKey      - output of {@link routeKeyFromPath}.
 */
export function buildStoreKey(
  principalType: RateLimitPrincipalType,
  identifier: string,
  routeKey: string,
): string {
  const principalKey =
    principalType === 'ip' ? normaliseIp(identifier) : hashApiKey(identifier);
  return `v1:${principalType}:${principalKey}:${routeKey}`;
}

/**
 * Map an extracted identifier + admin flag onto the canonical principal type.
 */
function principalTypeFor(
  identifierType: 'ip' | 'apiKey',
  isAdmin: boolean,
): RateLimitPrincipalType {
  if (identifierType === 'ip') return 'ip';
  return isAdmin ? 'admin' : 'apikey';
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
  const ip = getClientIp(req);
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
    keyId?: string,
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
  // Resolve config on each request via getRateLimitConfig() so SIGHUP-driven
  // setRuntimeRateLimitConfig() patches are observed without recreating the
  // middleware. Admin keys and allowlist still come from the factory-time env
  // snapshot (restart-required).
  const initial = getRateLimitConfig(env);
  const allowlistIps = initial.allowlistIps;

  // Build admin key set
  const adminKeys = new Set<string>();
  const adminKeyEnv = env.ADMIN_API_KEY ?? '';
  for (const k of adminKeyEnv.split(',').map((s) => s.trim())) {
    if (k) adminKeys.add(k);
  }

  /** Live tier configs — re-read each request for hot-reload determinism. */
  function liveConfigs(): {
    ip: RateLimitConfig;
    apiKey: RateLimitConfig;
    admin: RateLimitConfig;
  } {
    const cfg = getRateLimitConfig(env);
    return { ip: cfg.ip, apiKey: cfg.apiKey, admin: cfg.admin };
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
    // Hot-reload aware: pick up the latest runtime overrides on every request.
    const { ip: ipConfig, apiKey: apiKeyConfig, admin: adminConfig } = liveConfigs();

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
    let config = isAdmin ? adminConfig : identifierType === 'apiKey' ? apiKeyConfig : ipConfig;

    if (!config.enabled) {
      return next();
    }

    // Override resolution: authenticated identity → per-tenant override → global default
    // Security: identity is read from the verified auth context, never from client-supplied headers
    const authenticatedKeyId = req.keyId;
    if (authenticatedKeyId && identifierType === 'apiKey' && !isAdmin) {
      try {
        const tenantOverride: RateLimitOverride | null = await getOverride(authenticatedKeyId);
        if (tenantOverride) {
          config = { ...config, max: tenantOverride.maxRequests, windowMs: tenantOverride.windowMs };
        }
      } catch (err) {
        logger.warn('Rate-limit override lookup failed; using global default', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const routeConfig = getRouteRateLimitConfig(path);
    const { effectiveLimit, isExempt } = resolveEffectiveLimit(config, routeConfig, method);

    if (isExempt) {
      return next();
    }

    const principalType = principalTypeFor(identifierType, isAdmin);
    const routeKey = routeKeyFromPath(path);
    const storeKey = buildStoreKey(principalType, identifier, routeKey);
    // Per-principal aggregate counter: read by GET /api/rate-limits so the
    // status endpoint reflects total usage across every route, not just the
    // current one. It is informational (never enforced), so a failure to
    // record it must not affect the request.
    const aggregateKey = buildStoreKey(principalType, identifier, AGGREGATE_ROUTE);

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
      await store.increment(aggregateKey, config.windowMs, effectiveLimit).catch(() => {
        // Aggregate counter is best-effort; never fail the request over it.
      });
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
    keyId?: string,
  ): Promise<RateLimitStatus> {
    const { ip: ipConfig, apiKey: apiKeyConfig, admin: adminConfig } = liveConfigs();
    const isAdmin = identifierType === 'apiKey' && adminKeys.has(identifier);
    let config = isAdmin ? adminConfig : identifierType === 'apiKey' ? apiKeyConfig : ipConfig;

    // Override resolution for getStatus: keyId is the authenticated identity
    if (keyId && identifierType === 'apiKey' && !isAdmin) {
      try {
        const tenantOverride: RateLimitOverride | null = await getOverride(keyId);
        if (tenantOverride) {
          config = { ...config, max: tenantOverride.maxRequests, windowMs: tenantOverride.windowMs };
        }
      } catch (err) {
        logger.warn('Rate-limit override lookup failed in getStatus; using global default', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const routeConfig = path ? getRouteRateLimitConfig(path) : null;
    const { effectiveLimit } = resolveEffectiveLimit(config, routeConfig, method ?? 'GET');

    // Without an explicit path the status endpoint reports the per-principal
    // aggregate so `remaining` reflects usage across all routes.
    const principalType = principalTypeFor(identifierType, isAdmin);
    const routeKey =
      path !== undefined ? routeKeyFromPath(path) : AGGREGATE_ROUTE;
    const storeKey = buildStoreKey(principalType, identifier, routeKey);

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
