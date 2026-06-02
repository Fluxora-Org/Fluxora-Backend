import type { IncomingMessage } from 'node:http';
import { logger } from '../lib/logger.js';

// Configuration from environment variables
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '10', 10);
const ABUSE_THRESHOLD = parseInt(process.env.WS_ABUSE_THRESHOLD || '5', 10);
const BAN_TTL_S = parseInt(process.env.WS_BAN_TTL_S || '3600', 10);
const ABUSE_WINDOW_MS = 60_000; // 1 minute sliding window for abuse detection

// Trusted proxy list for X-Forwarded-For
const TRUSTED_PROXIES = new Set(
  (process.env.WS_TRUSTED_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// In-memory state
const connectionCounts = new Map<string, number>();
const rejectionHistory = new Map<string, number[]>(); // IP -> timestamps of rejections
const activeBans = new Map<string, number>(); // IP -> expiry timestamp

/**
 * Extracts the client IP address from the request, respecting X-Forwarded-For
 * only if the remote address is a trusted proxy.
 */
export function getClientIp(req: IncomingMessage): string {
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  const xForwardedFor = req.headers['x-forwarded-for'];

  if (xForwardedFor && TRUSTED_PROXIES.has(remoteAddress)) {
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
 */
export function checkLimiter(ip: string): { allowed: boolean; code?: number; reason?: string } {
  const now = Date.now();

  // 1. Check if IP is currently banned
  const banExpiry = activeBans.get(ip);
  if (banExpiry) {
    if (now < banExpiry) {
      return { allowed: false, code: 4029, reason: 'IP banned due to abuse' };
    }
    activeBans.delete(ip);
  }

  // 2. Check connection limit
  const currentCount = connectionCounts.get(ip) || 0;
  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    recordRejection(ip, now);
    return { allowed: false, code: 4029, reason: 'Too many connections' };
  }

  return { allowed: true };
}

/**
 * Records a rejection and checks if the IP should be banned for abuse.
 */
function recordRejection(ip: string, now: number): void {
  let rejections = rejectionHistory.get(ip) || [];
  // Sliding window: only keep rejections within the last ABUSE_WINDOW_MS
  rejections = rejections.filter((t) => now - t < ABUSE_WINDOW_MS);
  rejections.push(now);
  rejectionHistory.set(ip, rejections);

  if (rejections.length > ABUSE_THRESHOLD) {
    activeBans.set(ip, now + BAN_TTL_S * 1000);
    rejectionHistory.delete(ip);
    logger.warn('IP banned for WebSocket abuse', undefined, { ip, banTtl: BAN_TTL_S });
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
export function _resetLimiter(): void {
  connectionCounts.clear();
  rejectionHistory.clear();
  activeBans.clear();
}
