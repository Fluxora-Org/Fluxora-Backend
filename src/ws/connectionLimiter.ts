import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import type { RedisClient } from '../redis/client.js';

// In-memory state
const connectionCounts = new Map<string, number>();
const rejectionHistory = new Map<string, number[]>(); // IP -> timestamps of rejections
const activeBans = new Map<string, number>(); // IP -> expiry timestamp
const banExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const BAN_REASON = 'IP banned due to abuse';
const BAN_REDIS_KEY_PREFIX = 'fluxora:ws:ban:';

let banRedisClient: RedisClient | null = null;

export interface LimiterResult {
  allowed: boolean;
  code?: number;
  reason?: string;
}

interface PersistedBan {
  expiresAt: number;
  reason: string;
  createdAt: string;
}

/**
 * Extracts the client IP address from the request, respecting X-Forwarded-For
 * only if the remote address is a trusted proxy.
 */
export function getClientIp(req: IncomingMessage): string {
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  const xForwardedFor = req.headers['x-forwarded-for'];
  const trustedProxies = new Set(
    (process.env.WS_TRUSTED_PROXIES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  if (xForwardedFor && trustedProxies.has(remoteAddress)) {
    const ips = (Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor)
      .split(',')
      .map((s) => s.trim());
    return ips[0] || remoteAddress;
  }

  return remoteAddress;
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashClientIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

function redisBanKey(ip: string): string {
  return `${BAN_REDIS_KEY_PREFIX}${hashClientIp(ip)}`;
}

function auditBan(
  action: 'WS_ABUSE_BAN_CREATED' | 'WS_ABUSE_BAN_EXPIRED',
  ip: string,
  meta: Record<string, unknown>,
): void {
  recordAuditEvent(action, 'websocket_ip_ban', hashClientIp(ip), undefined, {
    ipHash: hashClientIp(ip),
    ...meta,
  });
}

function clearExpiryTimer(ip: string): void {
  const timer = banExpiryTimers.get(ip);
  if (timer) {
    clearTimeout(timer);
    banExpiryTimers.delete(ip);
  }
}

function scheduleBanExpiryAudit(ip: string, expiresAt: number, source: 'local' | 'redis'): void {
  clearExpiryTimer(ip);
  const delayMs = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    if (activeBans.get(ip) !== expiresAt) return;
    activeBans.delete(ip);
    banExpiryTimers.delete(ip);
    auditBan('WS_ABUSE_BAN_EXPIRED', ip, {
      source,
      expiredAt: new Date(expiresAt).toISOString(),
    });
    logger.info('WebSocket abuse ban expired', undefined, {
      event: 'ws_abuse_ban_expired',
      ipHash: hashClientIp(ip),
      source,
    });
  }, delayMs);
  timer.unref?.();
  banExpiryTimers.set(ip, timer);
}

function setLocalBan(ip: string, expiresAt: number, source: 'local' | 'redis'): void {
  activeBans.set(ip, expiresAt);
  scheduleBanExpiryAudit(ip, expiresAt, source);
}

function getLocalBanExpiry(ip: string, now: number): number | null {
  const banExpiry = activeBans.get(ip);
  if (!banExpiry) return null;

  if (now < banExpiry) return banExpiry;

  activeBans.delete(ip);
  clearExpiryTimer(ip);
  auditBan('WS_ABUSE_BAN_EXPIRED', ip, {
    source: 'local',
    expiredAt: new Date(banExpiry).toISOString(),
  });
  return null;
}

async function getPersistedBanExpiry(ip: string, now: number): Promise<number | null> {
  if (!banRedisClient) return null;

  try {
    const raw = await banRedisClient.get(redisBanKey(ip));
    if (!raw) return null;

    let expiresAt: number;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedBan>;
      expiresAt = Number(parsed.expiresAt);
    } catch {
      expiresAt = Number(raw);
    }

    if (!Number.isFinite(expiresAt)) {
      await banRedisClient.del(redisBanKey(ip));
      return null;
    }

    if (now >= expiresAt) {
      await banRedisClient.del(redisBanKey(ip));
      auditBan('WS_ABUSE_BAN_EXPIRED', ip, {
        source: 'redis',
        expiredAt: new Date(expiresAt).toISOString(),
      });
      return null;
    }

    setLocalBan(ip, expiresAt, 'redis');
    return expiresAt;
  } catch (err) {
    logger.warn('Redis WebSocket ban lookup failed; using in-memory ban cache', undefined, {
      event: 'ws_ban_redis_unavailable',
      operation: 'get',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function persistBan(ip: string, expiresAt: number, ttlSeconds: number): Promise<void> {
  if (!banRedisClient) return;

  const payload: PersistedBan = {
    expiresAt,
    reason: BAN_REASON,
    createdAt: new Date().toISOString(),
  };

  try {
    await banRedisClient.set(redisBanKey(ip), JSON.stringify(payload), { ex: ttlSeconds });
  } catch (err) {
    logger.warn('Redis WebSocket ban write failed; ban remains in memory only', undefined, {
      event: 'ws_ban_redis_unavailable',
      operation: 'set',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Injects the Redis client used to persist WebSocket abuse bans.
 * Passing null keeps the limiter in local-memory mode.
 */
export function setWebSocketBanRedisClient(client: RedisClient | null): void {
  banRedisClient = client;
}

/**
 * Checks if a new connection from the given IP should be allowed.
 * Returns an object indicating if allowed, and if not, the close code and reason.
 */
export function checkLimiter(ip: string): LimiterResult {
  const now = Date.now();
  const maxConnections = parseIntegerEnv('WS_MAX_CONNECTIONS_PER_IP', 10);

  // 1. Check if IP is currently banned
  const banExpiry = getLocalBanExpiry(ip, now);
  if (banExpiry) {
    return { allowed: false, code: 4029, reason: BAN_REASON };
  }

  // 2. Check connection limit
  const currentCount = connectionCounts.get(ip) || 0;
  if (currentCount >= maxConnections) {
    void recordRejection(ip, now);
    return { allowed: false, code: 4029, reason: 'Too many connections' };
  }

  return { allowed: true };
}

/**
 * Async limiter path used during the WebSocket upgrade handshake.
 *
 * It checks the in-memory read-through cache first, then Redis, and falls back
 * to local state when Redis is unavailable.
 */
export async function checkLimiterForConnection(ip: string): Promise<LimiterResult> {
  const now = Date.now();
  const maxConnections = parseIntegerEnv('WS_MAX_CONNECTIONS_PER_IP', 10);

  const localBanExpiry = getLocalBanExpiry(ip, now);
  if (localBanExpiry) {
    return { allowed: false, code: 4029, reason: BAN_REASON };
  }

  const persistedBanExpiry = await getPersistedBanExpiry(ip, now);
  if (persistedBanExpiry) {
    return { allowed: false, code: 4029, reason: BAN_REASON };
  }

  const currentCount = connectionCounts.get(ip) || 0;
  if (currentCount >= maxConnections) {
    await recordRejection(ip, now);
    return { allowed: false, code: 4029, reason: 'Too many connections' };
  }

  return { allowed: true };
}

/**
 * Records a rejection and checks if the IP should be banned for abuse.
 */
async function recordRejection(ip: string, now: number): Promise<void> {
  const abuseThreshold = parseIntegerEnv('WS_ABUSE_THRESHOLD', 5);
  const banTtl = parseIntegerEnv('WS_BAN_TTL_S', 3600);
  const abuseWindowMs = 60_000; // 1 minute sliding window for abuse detection

  let rejections = rejectionHistory.get(ip) || [];
  // Sliding window: only keep rejections within the last abuseWindowMs
  rejections = rejections.filter((t) => now - t < abuseWindowMs);
  rejections.push(now);
  rejectionHistory.set(ip, rejections);

  if (rejections.length > abuseThreshold) {
    if (activeBans.has(ip)) return;

    const expiresAt = now + banTtl * 1000;
    setLocalBan(ip, expiresAt, 'local');
    rejectionHistory.delete(ip);
    auditBan('WS_ABUSE_BAN_CREATED', ip, {
      banTtl,
      expiresAt: new Date(expiresAt).toISOString(),
      source: banRedisClient ? 'redis' : 'local',
    });
    await persistBan(ip, expiresAt, banTtl);
    logger.warn('IP banned for WebSocket abuse', undefined, {
      event: 'ws_abuse_ban_created',
      ipHash: hashClientIp(ip),
      banTtl,
    });
  }
}

/**
 * Tracks a new active connection for an IP.
 */
export function trackConnection(ip: string): void {
  connectionCounts.set(ip, (connectionCounts.get(ip) || 0) + 1);
}

/**
 * Decrements the active connection count for an IP.
 */
export function untrackConnection(ip: string): void {
  const current = connectionCounts.get(ip) || 0;
  if (current <= 1) {
    connectionCounts.delete(ip);
  } else {
    connectionCounts.set(ip, current - 1);
  }
}

/**
 * Resets all internal state (useful for tests).
 */
export function _resetLimiter(options: { keepBanStore?: boolean } = {}): void {
  connectionCounts.clear();
  rejectionHistory.clear();
  activeBans.clear();
  for (const timer of banExpiryTimers.values()) {
    clearTimeout(timer);
  }
  banExpiryTimers.clear();
  if (!options.keepBanStore) {
    banRedisClient = null;
  }
}
