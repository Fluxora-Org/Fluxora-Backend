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
