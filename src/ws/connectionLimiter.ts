import type { IncomingMessage } from 'node:http';
import { logger } from '../lib/logger.js';
import type { BanStore, BanCheckResult } from '../redis/banStore.js';
import { createBanStore } from '../redis/banStore.js';
import type { RedisClient } from '../redis/client.js';

// In-memory state (non-ban state)
const connectionCounts = new Map<string, number>();
const rejectionHistory = new Map<string, number[]>(); // IP -> timestamps of rejections

// Ban store (Redis-backed with local fallback)
let banStore: BanStore = createBanStore();

/**
 * Configure the ban store (called during app bootstrap when Redis is available).
 * Allows wiring Redis-backed HybridBanStore for durable/cluster-wide bans.
 */
export function setBanStore(store: BanStore): void {
  banStore = store;
}

/**
 * Get the current ban store (primarily for tests).
 */
export function getBanStore(): BanStore {
  return banStore;
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

/**
 * Checks if a new connection from the given IP should be allowed.
 * Returns an object indicating if allowed, and if not, the close code and reason.
 * 
 * Checks Redis-backed ban store first (with local cache), falls back to local enforcement.
 */
export async function checkLimiter(ip: string): Promise<{ allowed: boolean; code?: number; reason?: string }> {
  const now = Date.now();
  const maxConnections = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '10', 10);

  // 1. Check if IP is currently banned (Redis + local cache)
  try {
    const banResult: BanCheckResult = await banStore.isBanned(ip);
    if (banResult.banned) {
      return { allowed: false, code: 4029, reason: 'IP banned due to abuse' };
    }
  } catch {
    // Redis failure — banStore falls back internally to local enforcement.
    // We still proceed with connection count check below.
  }

  // 2. Check connection limit
  const currentCount = connectionCounts.get(ip) || 0;
  if (currentCount >= maxConnections) {
    recordRejection(ip, now);
    return { allowed: false, code: 4029, reason: 'Too many connections' };
  }

  return { allowed: true };
}

/**
 * Records a rejection and checks if the IP should be banned for abuse.
 * Now delegates ban creation to the configured BanStore (Redis + local).
 */
function recordRejection(ip: string, now: number): void {
  const abuseThreshold = parseInt(process.env.WS_ABUSE_THRESHOLD || '5', 10);
  const banTtl = parseInt(process.env.WS_BAN_TTL_S || '3600', 10);
  const abuseWindowMs = 60_000; // 1 minute sliding window for abuse detection

  let rejections = rejectionHistory.get(ip) || [];
  // Sliding window: only keep rejections within the last abuseWindowMs
  rejections = rejections.filter((t) => now - t < abuseWindowMs);
  rejections.push(now);
  rejectionHistory.set(ip, rejections);

  if (rejections.length > abuseThreshold) {
    // Delegate to banStore (Redis-backed with TTL + local cache)
    void banStore.ban({ ip, ttlSeconds: banTtl }).catch((err) => {
      logger.error('Failed to persist ban to store', undefined, {
        ip,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    rejectionHistory.delete(ip);
    // Note: actual audit log emitted inside BanStore implementations
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
 * Also resets the ban store.
 */
export function _resetLimiter(): void {
  connectionCounts.clear();
  rejectionHistory.clear();
  // Reset ban store state
  if (banStore && typeof (banStore as any).close === 'function') {
    void (banStore as any).close();
  }
  banStore = createBanStore();
}

/**
 * Wire a Redis client into the ban store (called from app bootstrap).
 * Creates a HybridBanStore wrapping RedisBanStore + InMemory fallback.
 */
export function wireRedisBanStore(redisClient: RedisClient): void {
  const store = createBanStore(redisClient, (err, op) => {
    logger.warn(`Redis ban store error on ${op}`, undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  setBanStore(store);
}
