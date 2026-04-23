import type { RateLimitConfig } from '../types/rateLimit.js';

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

export function getRateLimitConfig(env: Record<string, string | undefined>): {
  ip: RateLimitConfig;
  apiKey: RateLimitConfig;
  admin: RateLimitConfig;
  trustProxy: boolean;
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

  return { ip, apiKey, admin, trustProxy };
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
