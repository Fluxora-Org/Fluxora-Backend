/**
 * WebSocket channel for real-time stream updates.
 *
 * This module provides backward compatibility for the old broadcast API.
 * It now delegates to the StreamHub which implements proper subscription semantics.
 *
 * @deprecated Use StreamHub directly for new code
 */

import { createStreamHub, getStreamHub } from '../ws/hub.js';
import type { Server } from 'http';
import { info, warn } from '../utils/logger.js';
import { loadConfig } from '../config/env.js';
import { createRedisClient, type RedisClient } from '../redis/client.js';
import { setWebSocketBanRedisClient } from '../ws/connectionLimiter.js';
import { addShutdownHook } from '../shutdown.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type StreamEventType = 'stream.created' | 'stream.updated' | 'stream.cancelled';

export interface StreamBroadcastEvent {
  event: StreamEventType;
  streamId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface DegradedBroadcastEvent {
  event: 'service.degraded';
  reason: string;
  timestamp: string;
}

export type BroadcastMessage = StreamBroadcastEvent | DegradedBroadcastEvent;

// ── Module state ─────────────────────────────────────────────────────────────

let hubInitialized = false;
let limiterRedisClient: RedisClient | null = null;
let limiterRedisShutdownHookRegistered = false;

async function wireWebSocketBanStore(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    setWebSocketBanRedisClient(null);
    warn('Configuration unavailable for WebSocket abuse ban Redis store; using in-process fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!config.redisEnabled) {
    setWebSocketBanRedisClient(null);
    warn('Redis disabled - WebSocket abuse bans will use in-process memory only');
    return;
  }

  try {
    limiterRedisClient = await createRedisClient({
      url: config.redisUrl,
      enabled: config.redisEnabled,
      mode: config.redisMode,
      sentinelHosts: config.redisSentinelHosts,
      sentinelName: config.redisSentinelName,
      clusterNodes: config.redisClusterNodes,
    });
    setWebSocketBanRedisClient(limiterRedisClient);
    info('Redis WebSocket abuse ban store wired');
  } catch (err) {
    setWebSocketBanRedisClient(null);
    warn('Redis WebSocket abuse ban store unavailable; using in-process fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Attach the WebSocket server to an existing HTTP server.
 * Safe to call once; subsequent calls are no-ops.
 * 
 * @deprecated Use StreamHub directly for new code
 */
export function attachWebSocketServer(httpServer: Server): void {
  if (hubInitialized) return;
  
  // Always create a new hub for the given server
  createStreamHub(httpServer);
  void wireWebSocketBanStore();
  if (!limiterRedisShutdownHookRegistered) {
    addShutdownHook(async () => {
      if (limiterRedisClient) {
        await limiterRedisClient.close();
        limiterRedisClient = null;
        setWebSocketBanRedisClient(null);
      }
    });
    limiterRedisShutdownHookRegistered = true;
  }
  hubInitialized = true;
  
  warn('attachWebSocketServer is deprecated - use StreamHub directly for new code');
}

/**
 * Broadcast a stream event to all connected clients.
 * Silently drops if no clients are connected.
 * 
 * Note: This now delegates to StreamHub which only broadcasts to subscribed clients.
 */
export function broadcast(message: BroadcastMessage): void {
  const hub = getStreamHub();
  if (!hub) {
    warn('Cannot broadcast: StreamHub not initialized. Call attachWebSocketServer first.');
    return;
  }

  // Convert BroadcastMessage to StreamUpdateEvent
  const eventId = `event-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // DegradedBroadcastEvent has no streamId or payload — it is system-wide.
  // Surface a synthetic streamId so consumers can still dispatch it.
  const streamId = message.event === 'service.degraded' ? '_system_' : message.streamId;
  const basePayload =
    message.event === 'service.degraded'
      ? { reason: message.reason }
      : message.payload;

  hub.broadcast({
    streamId,
    eventId,
    payload: {
      ...basePayload,
      event: message.event,
      timestamp: message.timestamp,
    },
  }).catch((err: Error) => {
    warn('Failed to broadcast event', {
      streamId,
      eventId,
      error: err.message,
    });
  });
}

/** Number of currently connected WebSocket clients (for /health). */
export function getConnectionCount(): number {
  const hub = getStreamHub();
  return hub ? hub.clientCount : 0;
}

/**
 * Gracefully close the WebSocket server and stop the heartbeat.
 * Called during process shutdown.
 */
export function closeWebSocketServer(): Promise<void> {
  const hub = getStreamHub();
  if (!hub) {
    return Promise.resolve();
  }
  
  return new Promise((resolve) => {
    hub.close(() => {
      info('WebSocket server closed');
      hubInitialized = false;
      resolve();
    });
  }).then(async () => {
    if (limiterRedisClient) {
      await limiterRedisClient.close();
      limiterRedisClient = null;
      setWebSocketBanRedisClient(null);
    }
  });
}
