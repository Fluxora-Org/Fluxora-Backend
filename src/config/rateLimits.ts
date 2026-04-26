import type { RateLimitConfig, RouteRateLimitConfig, RouteBudget } from '../types/rateLimit.js';

export const DEFAULT_IP_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  max: 100,
  enabled: true,
};

export const DEFAULT_APIKEY_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  max: 500,
  enabled: true,
};

export const DEFAULT_ADMIN_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  max: 2000,
  enabled: true,
};

export const DEFAULT_ROUTE_CONFIG: RouteRateLimitConfig = {
  baseLimit: 0, // 0 means use global limit
  writeLimit: 0, // 0 means use baseLimit
  exempt: false,
};

// Per-route rate limit budgets
export const ROUTE_BUDGETS: RouteBudget[] = [
  // Public read endpoints - higher limits
  {
    path: '/api/streams',
    config: { baseLimit: 100, writeLimit: 20, exempt: false }
  },
  {
    path: '/api/auth',
    config: { baseLimit: 50, writeLimit: 10, exempt: false }
  },
  // Write endpoints - stricter limits
  {
    path: '/api/streams/:id',
    config: { baseLimit: 30, writeLimit: 5, exempt: false }
  },
  // Admin endpoints - different limits
  {
    path: '/api/admin',
    config: { baseLimit: 50, writeLimit: 10, exempt: false }
  },
  // Internal endpoints - exempt or very high limits
  {
    path: '/internal/indexer',
    config: { baseLimit: 1000, writeLimit: 100, exempt: false }
  },
  {
    path: '/metrics',
    config: { baseLimit: 0, writeLimit: 0, exempt: true }
  },
  {
    path: '/health',
    config: { baseLimit: 0, writeLimit: 0, exempt: true }
  }
];

export function getRateLimitConfig(env: Record<string, string | undefined>): {
  ip: RateLimitConfig;
  apiKey: RateLimitConfig;
  admin: RateLimitConfig;
  trustProxy: boolean;
  allowlistIps: Set<string>;
} {
  const enabled = env.RATE_LIMIT_ENABLED !== 'false';

  const ip: RateLimitConfig = {
    windowMs: parseInt(env.RATE_LIMIT_IP_WINDOW_MS ?? '', 10) || DEFAULT_IP_CONFIG.windowMs,
    max: parseInt(env.RATE_LIMIT_IP_MAX ?? '', 10) || DEFAULT_IP_CONFIG.max,
    enabled,
  };

  const apiKey: RateLimitConfig = {
    windowMs: parseInt(env.RATE_LIMIT_APIKEY_WINDOW_MS ?? '', 10) || DEFAULT_APIKEY_CONFIG.windowMs,
    max: parseInt(env.RATE_LIMIT_APIKEY_MAX ?? '', 10) || DEFAULT_APIKEY_CONFIG.max,
    enabled,
  };

  const admin: RateLimitConfig = {
    windowMs: parseInt(env.RATE_LIMIT_ADMIN_WINDOW_MS ?? '', 10) || DEFAULT_ADMIN_CONFIG.windowMs,
    max: parseInt(env.RATE_LIMIT_ADMIN_MAX ?? '', 10) || DEFAULT_ADMIN_CONFIG.max,
    enabled,
  };

  const trustProxy = env.RATE_LIMIT_TRUST_PROXY !== 'false';
  
  // Parse allowlist IPs for health probes
  const allowlistIps = new Set<string>();
  const allowlistEnv = env.RATE_LIMIT_ALLOWLIST_IPS ?? '';
  if (allowlistEnv) {
    for (const ip of allowlistEnv.split(',').map(s => s.trim()).filter(Boolean)) {
      allowlistIps.add(ip);
    }
  }

  return { ip, apiKey, admin, trustProxy, allowlistIps };
}

/**
 * Get route-specific rate limit configuration for a given path
 */
export function getRouteRateLimitConfig(path: string): RouteRateLimitConfig | null {
  // Check for exact matches first
  const exactMatch = ROUTE_BUDGETS.find(budget => budget.path === path);
  if (exactMatch) return exactMatch.config;
  
  // Check for pattern matches (routes with parameters like :id)
  for (const budget of ROUTE_BUDGETS) {
    if (budget.path.includes(':')) {
      // Simple pattern matching for route parameters
      const patternParts = budget.path.split('/');
      const pathParts = path.split('/');
      
      if (patternParts.length === pathParts.length) {
        let matches = true;
        for (let i = 0; i < patternParts.length; i++) {
          if (patternParts[i].startsWith(':')) continue; // Parameter matches anything
          if (patternParts[i] !== pathParts[i]) {
            matches = false;
            break;
          }
        }
        if (matches) return budget.config;
      }
    }
  }
  
  return null;
}

// ─── Runtime-mutable store ────────────────────────────────────────────────────

export interface RuntimeRateLimitConfig {
  ip: RateLimitConfig;
  apiKey: RateLimitConfig;
  admin: RateLimitConfig;
}

let runtimeConfig: RuntimeRateLimitConfig | null = null;

/** Returns the active runtime overrides, or null if none have been set. */
export function getRuntimeRateLimitConfig(): RuntimeRateLimitConfig | null {
  return runtimeConfig;
}

/** Merges partial overrides into the runtime config. */
export function setRuntimeRateLimitConfig(
  patch: Partial<RuntimeRateLimitConfig>,
): RuntimeRateLimitConfig {
  const base = runtimeConfig ?? { ip: { ...DEFAULT_IP_CONFIG }, apiKey: { ...DEFAULT_APIKEY_CONFIG }, admin: { ...DEFAULT_ADMIN_CONFIG } };
  runtimeConfig = {
    ip:     patch.ip     ? { ...base.ip,     ...patch.ip     } : base.ip,
    apiKey: patch.apiKey ? { ...base.apiKey, ...patch.apiKey } : base.apiKey,
    admin:  patch.admin  ? { ...base.admin,  ...patch.admin  } : base.admin,
  };
  return runtimeConfig;
}

/** Resets runtime overrides (used in tests and on startup). */
export function resetRuntimeRateLimitConfig(): void {
  runtimeConfig = null;
}
