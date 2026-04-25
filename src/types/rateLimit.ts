export interface RateLimitConfig {
  windowMs: number;
  max: number;
  enabled: boolean;
}

export interface RouteRateLimitConfig {
  /** Base limit for this route (applies to all HTTP methods) */
  baseLimit: number;
  /** Stricter limit for write methods (POST, PUT, PATCH, DELETE) */
  writeLimit: number;
  /** Whether this route is exempt from rate limiting */
  exempt: boolean;
}

export interface RateLimitStatus {
  identifier: string;
  identifierType: 'ip' | 'apiKey';
  limit: number;
  remaining: number;
  resetsAt: string;
  window: string;
  route?: string;
  method?: string;
}

export interface RateLimitErrorBody {
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
}

export interface AdminKeySet {
  adminKeys: Set<string>;
}

export interface RateLimitCounters {
  ip: Map<string, { count: number; resetAt: number }>;
  apiKey: Map<string, { count: number; resetAt: number }>;
}

export interface RouteBudget {
  path: string;
  config: RouteRateLimitConfig;
}
