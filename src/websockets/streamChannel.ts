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
  
  hub.broadcast({
    streamId: message.streamId,
    eventId,
    payload: {
      ...message.payload,
      event: message.event,
      timestamp: message.timestamp
    }
  }).catch(err => {
    warn('Failed to broadcast event', { 
      streamId: message.streamId, 
      eventId, 
      error: err.message 
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
  });
}
