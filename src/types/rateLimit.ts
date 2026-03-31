export interface RateLimitConfig {
  windowMs: number;
  max: number;
  enabled: boolean;
}

export interface RateLimitStatus {
  identifier: string;
  identifierType: 'ip' | 'apiKey';
  limit: number;
  remaining: number;
  resetsAt: string;
  window: string;
}

export interface RateLimitErrorBody {
  error: {
    code: string;
    message: string;
    retryAfter: number;
    limit: number;
    window: string;
    identifier: string;
  };
}

export interface AdminKeySet {
  adminKeys: Set<string>;
}

export interface RateLimitCounters {
  ip: Map<string, { count: number; resetAt: number }>;
  apiKey: Map<string, { count: number; resetAt: number }>;
}
