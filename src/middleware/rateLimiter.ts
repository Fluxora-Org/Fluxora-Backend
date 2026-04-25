import type { Request, Response, NextFunction } from 'express';
import type { RateLimitConfig, RateLimitStatus, RouteRateLimitConfig } from '../types/rateLimit.js';
import { getRateLimitConfig, getRouteRateLimitConfig } from '../config/rateLimits.js';

interface ClientState {
  identifier: string;
  identifierType: 'ip' | 'apiKey';
  config: RateLimitConfig;
  routeConfig: RouteRateLimitConfig | null;
  resetAt: number;
  count: number;
}

const EXEMPT_PATHS = new Set(['/', '/health', '/api/rate-limits']);

function buildErrorBody(
  identifier: string,
  identifierType: string,
  limit: number,
  windowMs: number,
  retryAfterSeconds: number,
  route?: string,
  method?: string
) {
  const body: any = {
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

function maskApiKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function getCurrentReset(windowMs: number): number {
  return Date.now() + windowMs;
}

function getRemainingRequests(count: number, max: number): number {
  return Math.max(0, max - count);
}

function secondsUntil(resetAt: number): number {
  return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
}

export function extractClientIdentifier(req: Request): {
  identifier: string;
  identifierType: 'ip' | 'apiKey';
} {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return { identifier: apiKey, identifierType: 'apiKey' };
  }
  const ip = (req as Request & { ip?: string }).ip ?? req.socket.remoteAddress ?? 'unknown';
  return { identifier: ip, identifierType: 'ip' };
}

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  getStatus(identifier: string, identifierType: 'ip' | 'apiKey', path?: string, method?: string): RateLimitStatus;
  extractClientIdentifier(req: Request): { identifier: string; identifierType: 'ip' | 'apiKey' };
}

export function createRateLimiter(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): RateLimiter {
  const { ip: ipConfig, apiKey: apiKeyConfig, admin: adminConfig, allowlistIps } = getRateLimitConfig(env);

  const adminKeys = new Set<string>();
  const adminKeyEnv = env.ADMIN_API_KEY ?? '';
  if (adminKeyEnv) {
    for (const k of adminKeyEnv.split(',').map((s) => s.trim())) {
      if (k) adminKeys.add(k);
    }
  }

  const ipCounters = new Map<string, { count: number; resetAt: number }>();
  const apiKeyCounters = new Map<string, { count: number; resetAt: number }>();

  function getOrInitCounter(
    map: Map<string, { count: number; resetAt: number }>,
    key: string,
    windowMs: number
  ) {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: getCurrentReset(windowMs) };
      map.set(key, entry);
    }
    return entry;
  }

  function clientState(identifier: string, identifierType: 'ip' | 'apiKey', path?: string, method?: string): ClientState {
    const isAdmin = identifierType === 'apiKey' && adminKeys.has(identifier);
    const config = isAdmin ? adminConfig : identifierType === 'apiKey' ? apiKeyConfig : ipConfig;
    const counters = identifierType === 'apiKey' ? apiKeyCounters : ipCounters;
    const entry = getOrInitCounter(counters, identifier, config.windowMs);
    
    // Get route-specific configuration if path is provided
    let routeConfig: RouteRateLimitConfig | null = null;
    if (path) {
      routeConfig = getRouteRateLimitConfig(path);
    }
    
    return {
      identifier,
      identifierType,
      config,
      routeConfig,
      resetAt: entry.resetAt,
      count: entry.count,
    };
  }

  function rateLimitHandler(req: Request, res: Response, next: NextFunction): void {
    if (!ipConfig.enabled && !apiKeyConfig.enabled) {
      return next();
    }

    const path = req.path;
    const method = req.method;
    
    // Check if path is exempt
    if (EXEMPT_PATHS.has(path)) {
      return next();
    }

    const { identifier, identifierType } = extractClientIdentifier(req);
    
    // Check if IP is in allowlist for health probes
    if (identifierType === 'ip' && allowlistIps.has(identifier)) {
      return next();
    }

    const state = clientState(identifier, identifierType, path, method);

    if (!state.config.enabled) {
      return next();
    }

    // Check route-specific configuration
    let effectiveLimit = state.config.max;
    let isExempt = false;
    
    if (state.routeConfig) {
      if (state.routeConfig.exempt) {
        isExempt = true;
      } else {
        // Use route-specific limit
        effectiveLimit = state.routeConfig.baseLimit > 0 ? state.routeConfig.baseLimit : state.config.max;
        
        // Apply stricter write limits for write methods
        const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        if (isWriteMethod && state.routeConfig.writeLimit > 0) {
          effectiveLimit = state.routeConfig.writeLimit;
        }
      }
    }

    if (isExempt) {
      return next();
    }

    if (state.count >= effectiveLimit) {
      const retryAfter = secondsUntil(state.resetAt);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));
      res.status(429).json(buildErrorBody(
        identifier, 
        identifierType, 
        effectiveLimit, 
        state.config.windowMs, 
        retryAfter,
        path,
        method
      ));
      return;
    }

    const entry = getOrInitCounter(
      identifierType === 'apiKey' ? apiKeyCounters : ipCounters,
      identifier,
      state.config.windowMs
    );
    entry.count += 1;
    entry.resetAt = state.resetAt;

    res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
    res.setHeader('X-RateLimit-Remaining', String(getRemainingRequests(entry.count, effectiveLimit)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    next();
  }

  function getStatus(identifier: string, identifierType: 'ip' | 'apiKey', path?: string, method?: string): RateLimitStatus {
    const isAdmin = identifierType === 'apiKey' && adminKeys.has(identifier);
    const config = isAdmin ? adminConfig : identifierType === 'apiKey' ? apiKeyConfig : ipConfig;
    const entry = getOrInitCounter(
      identifierType === 'apiKey' ? apiKeyCounters : ipCounters,
      identifier,
      config.windowMs
    );
    
    // Calculate effective limit based on route if provided
    let effectiveLimit = config.max;
    if (path) {
      const routeConfig = getRouteRateLimitConfig(path);
      if (routeConfig && !routeConfig.exempt) {
        effectiveLimit = routeConfig.baseLimit > 0 ? routeConfig.baseLimit : config.max;
        
        // Apply stricter write limits for write methods
        const isWriteMethod = method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        if (isWriteMethod && routeConfig.writeLimit > 0) {
          effectiveLimit = routeConfig.writeLimit;
        }
      }
    }
    
    return {
      identifier: identifierType === 'ip' ? identifier : maskApiKey(identifier),
      identifierType,
      limit: effectiveLimit,
      remaining: getRemainingRequests(entry.count, effectiveLimit),
      resetsAt: new Date(entry.resetAt).toISOString(),
      window: config.windowMs === 60_000 ? 'minute' : 'unknown',
      route: path,
      method,
    };
  }

  rateLimitHandler.getStatus = getStatus;
  rateLimitHandler.extractClientIdentifier = extractClientIdentifier;

  return rateLimitHandler;
}

export function isAdminKey(
  key: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): boolean {
  const adminKeyEnv = env.ADMIN_API_KEY ?? '';
  if (!adminKeyEnv) return false;
  const adminKeys = new Set(adminKeyEnv.split(',').map((s) => s.trim()).filter(Boolean));
  return adminKeys.has(key);
}
