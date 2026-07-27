import { logger } from '../lib/logger.js';
import type { BanStore, BanCheckResult } from '../redis/banStore.js';
import { createBanStore } from '../redis/banStore.js';
import type { RedisClient } from '../redis/client.js';
import { getClientIp } from '../lib/ipExtraction.js';
import { Gauge } from 'prom-client';
import { registry } from '../metrics.js';

export { getClientIp };

// In-memory state (non-ban state)
const connectionCounts = new Map<string, number>();
const rejectionHistory = new Map<string, number[]>(); // IP -> timestamps of rejections

// Graceful shutdown state
let shuttingDown = false;
let activeConnections = 0;

// Prometheus metrics
const activeConnectionsGauge = new Gauge({
  name: 'websocket_connections_active',
  help: 'Current number of active WebSocket connections',
  registers: [registry],
});

const maxConnectionsGauge = new Gauge({
  name: 'websocket_connections_max',
  help: 'Maximum allowed WebSocket connections per IP',
  registers: [registry],
});

// Update max connections gauge on startup
function updateMaxConnectionsMetric() {
  const maxPerIp = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '10', 10);
  maxConnectionsGauge.set(maxPerIp);
}
updateMaxConnectionsMetric();

function updateActiveConnectionsMetric() {
  activeConnectionsGauge.set(activeConnections);
}

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
 * Atomically checks and reserves a connection slot for an IP.
 *
 * SECURITY: This function prevents TOCTOU (time-of-check/time-of-use) race conditions
 * by reserving the slot BEFORE any async operations. The upgrade handler must ensure
 * the reservation is released exactly once, either:
 *   - On upgrade success: in onConnect when the WebSocket is established
 *   - On upgrade failure: via explicit cleanup before returning (auth failure, socket close)
 *
 * ATOMIC OPERATION: Critical for preventing bypass of the per-IP connection cap.
 *   1. Check limit synchronously (before increment) — prevent TOCTOU
 *   2. Reserve slot (increment counter) — commit the reservation
 *   3. Check ban status (async, after reservation) — check if IP is banned
 *   4. Rollback reservation if banned (call untrackConnection) — release if banned
 *
 * INVARIANT: If the function returns { allowed: true }, the caller MUST eventually call
 * untrackConnection exactly once (either in onConnect on success, or in cleanup on failure).
 *
 * COUNTER LIFECYCLE:
 *   - checkAndReserve: Increments counter (and may rollback if banned)
 *   - onConnect: Takes ownership of the reservation (connection established)
 *   - onDisconnect: Decrements counter (connection closed)
 *
 * This ordering ensures that concurrent upgrade requests cannot both pass the check
 * before the first is counted, even under burst load from attackers or misbehaving clients.
 *
 * @param ip Client IP address
 * @returns { allowed: true } if slot reserved (caller must call untrackConnection exactly once)
 *          { allowed: false, code, reason } if rejected (caller should NOT call untrackConnection)
 *
 * @example
 * ```ts
 * const result = await checkAndReserve(clientIp);
 * if (!result.allowed) {
 *   // Reject: close socket with result.code
 *   return;
 * }
 * // Reservation successful. Must cleanup on failure:
 * let cleaned = false;
 * socket.on('close', () => {
 *   if (!cleaned) {
 *     cleaned = true;
 *     untrackConnection(clientIp);
 *   }
 * });
 * // ... continue with auth and upgrade ...
 * // On successful upgrade, mark cleaned=true to prevent double-cleanup
 * ```
 */
export async function checkAndReserve(ip: string): Promise<{ allowed: boolean; code?: number; reason?: string }> {
  // Reject new connections during graceful shutdown
  if (shuttingDown) {
    return { allowed: false, code: 4029, reason: 'Server shutting down' };
  }

  const now = Date.now();
  const maxConnections = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '10', 10);

  // 1. Check connection limit FIRST (synchronously) to avoid TOCTOU
  const currentCount = connectionCounts.get(ip) || 0;
  if (currentCount >= maxConnections) {
    recordRejection(ip, now);
    return { allowed: false, code: 4029, reason: 'Too many connections' };
  }

  // Atomically reserve the connection slot before any async operations
  connectionCounts.set(ip, currentCount + 1);
  activeConnections++;
  updateActiveConnectionsMetric();

  // 2. Check if IP is currently banned (Redis + local cache)
  try {
    const banResult: BanCheckResult = await banStore.isBanned(ip);
    if (banResult.banned) {
      untrackConnection(ip); // rollback reservation
      return { allowed: false, code: 4029, reason: 'IP banned due to abuse' };
    }
  } catch {
    // Redis failure — banStore falls back internally to local enforcement.
    // We still proceed.
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
 * Safe against double-decrement (won't go negative; clamps at 0).
 *
 * SECURITY NOTE: MUST be called exactly once per successful checkAndReserve.
 * - If called twice, it will still not underflow (safe), but the counter will be inaccurate.
 * - The upgrade handler uses a 'cleaned' flag to prevent accidental double-decrement.
 * - Called in two scenarios:
 *   1. Upgrade failure cleanup (if checkAndReserve returned { allowed: true } but upgrade failed)
 *   2. onDisconnect (when a successfully established WebSocket closes)
 *
 * INVARIANT: counter never goes negative (min 0).
 */
export function untrackConnection(ip: string): void {
  const current = connectionCounts.get(ip) || 0;
  if (current <= 1) {
    connectionCounts.delete(ip);
  } else {
    connectionCounts.set(ip, current - 1);
  }

  // Decrement global active connections
  if (activeConnections > 0) {
    activeConnections--;
    updateActiveConnectionsMetric();
  }
}

/**
 * Returns the current number of active WebSocket connections.
 * Used for metrics and health checks.
 */
export function getActiveConnectionCount(): number {
  return activeConnections;
}

/**
 * Returns whether the server is in graceful shutdown mode.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Initiates graceful shutdown of WebSocket connections.
 *
 * - Sets shuttingDown flag to reject new connections
 * - Sends close frame (code 1001, reason "Server restarting") to all active connections
 * - Waits up to gracePeriodMs for connections to close naturally
 * - Returns when all connections are closed or grace period expires
 *
 * @param wss WebSocketServer instance to close connections on
 * @param gracePeriodMs Maximum time to wait for graceful drain (default 5000ms)
 */
export async function gracefulDrain(
  wss: any, // WebSocketServer type from 'ws' package
  gracePeriodMs: number = 5000
): Promise<void> {
  if (shuttingDown) {
    logger.info('Graceful drain already in progress');
    return;
  }

  shuttingDown = true;
  logger.info(`Starting graceful shutdown with ${gracePeriodMs}ms grace period`, undefined, {
    activeConnections,
  });

  // Send close frame to all active connections
  if (wss && wss.clients) {
    const closePayload = JSON.stringify({ reason: 'Server restarting' });
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
          client.close(1001, closePayload);
        } catch (err) {
          logger.warn('Failed to send close frame to client', undefined, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // Wait for connections to close or grace period to expire
  const startTime = Date.now();
  while (activeConnections > 0 && Date.now() - startTime < gracePeriodMs) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (activeConnections > 0) {
    logger.warn(`Grace period expired with ${activeConnections} connections still active`, undefined, {
      remainingConnections: activeConnections,
    });
  } else {
    logger.info('All connections drained gracefully');
  }
}

/**
 * Resets all internal state (useful for tests).
 * Also resets the ban store.
 */
export function _resetLimiter(): void {
  connectionCounts.clear();
  rejectionHistory.clear();
  shuttingDown = false;
  activeConnections = 0;
  updateActiveConnectionsMetric();
  // Reset ban store state
  if (banStore) {
    void banStore.close();
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
