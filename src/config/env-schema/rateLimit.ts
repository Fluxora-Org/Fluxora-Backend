/**
 * HTTP rate-limiting environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { booleanEnv, integerEnv, optionalString } from './parsers.js';

export const rateLimitEnvSchema = {
  /** Master switch for HTTP rate limiting. @default true */
  RATE_LIMIT_ENABLED: booleanEnv().default(true),
  /** Sliding window for per-IP limits, in ms. @default 60000 */
  RATE_LIMIT_IP_WINDOW_MS: integerEnv('RATE_LIMIT_IP_WINDOW_MS', 1).optional(),
  /** Max requests per IP per window. @default 100 */
  RATE_LIMIT_IP_MAX: integerEnv('RATE_LIMIT_IP_MAX', 1).optional(),
  /** Sliding window for per-API-key limits, in ms. @default 60000 */
  RATE_LIMIT_APIKEY_WINDOW_MS: integerEnv('RATE_LIMIT_APIKEY_WINDOW_MS', 1).optional(),
  /** Max requests per API key per window. @default 600 */
  RATE_LIMIT_APIKEY_MAX: integerEnv('RATE_LIMIT_APIKEY_MAX', 1).optional(),
  /** Sliding window for admin-endpoint limits, in ms. @default 60000 */
  RATE_LIMIT_ADMIN_WINDOW_MS: integerEnv('RATE_LIMIT_ADMIN_WINDOW_MS', 1).optional(),
  /** Max admin requests per window. @default 30 */
  RATE_LIMIT_ADMIN_MAX: integerEnv('RATE_LIMIT_ADMIN_MAX', 1).optional(),
  /** Honor X-Forwarded-For from reverse proxies. @default true */
  RATE_LIMIT_TRUST_PROXY: booleanEnv().default(true),
  /** Comma-separated IPs exempt from rate limiting. */
  RATE_LIMIT_ALLOWLIST_IPS: optionalString('RATE_LIMIT_ALLOWLIST_IPS'),
  /** Number of trusted proxies in front of the service (0 = direct). @default 0 */
  TRUSTED_PROXY_COUNT: integerEnv('TRUSTED_PROXY_COUNT', 0, 100).default(0),
  /** Comma-separated list of trusted proxy IPs/CIDRs (global fallback). */
  TRUSTED_PROXIES: optionalString('TRUSTED_PROXIES'),
  /** Comma-separated list of trusted proxies for WebSocket client-IP resolution. */
  WS_TRUSTED_PROXIES: optionalString('WS_TRUSTED_PROXIES'),
  /** Comma-separated list of trusted proxies for rate-limit keying. */
  RATE_LIMIT_TRUSTED_PROXIES: optionalString('RATE_LIMIT_TRUSTED_PROXIES'),
};
