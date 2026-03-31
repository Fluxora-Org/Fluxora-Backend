/**
 * WebSocket channel for real-time stream updates.
 *
 * Responsibilities:
 * - Attach a ws.Server to an existing http.Server (no extra port)
 * - Broadcast typed stream events to all live clients
 * - Enforce per-connection rate limiting and max payload size
 * - Heartbeat / ping-pong to prune dead connections
 * - Expose live connection count for /health
 *
 * Trust boundaries:
 * - Public clients: receive events; may send subscription messages (no auth yet — documented non-goal)
 * - Internal workers: call broadcast() after stream mutations
 * - Operators: observe wsConnections in GET /health
 *
 * Non-goals (follow-up):
 * - Authentication / authorization on the WS endpoint
 * - Message replay / durable event log
 * - Per-stream subscription filtering
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { info, warn, error as logError } from '../utils/logger.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum size (bytes) of any message sent by a client. */
const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024; // 4 KiB

/** Heartbeat interval — ping sent to every client on this cadence. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Max messages a single client may send per rate-limit window. */
const RATE_LIMIT_MAX_MESSAGES = 10;

/** Rate-limit window duration in ms. */
const RATE_LIMIT_WINDOW_MS = 10_000;

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

// ── Internal client state ────────────────────────────────────────────────────

interface TrackedClient {
  ws: WebSocket;
  connectionId: string;
  isAlive: boolean;
  /** Message count in the current rate-limit window. */
  messageCount: number;
  /** Timestamp when the current window started. */
  windowStart: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
const clients = new Map<string, TrackedClient>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let connectionCounter = 0;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Attach the WebSocket server to an existing HTTP server.
 * Safe to call once; subsequent calls are no-ops.
 */
export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer, path: '/ws/streams' });

  wss.on('connection', handleConnection);
  wss.on('error', (err) => logError('WebSocket server error', {}, err));

  heartbeatTimer = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);

  info('WebSocket server attached', { path: '/ws/streams' });
  return wss;
}

/**
 * Broadcast a stream event to all connected clients.
 * Silently drops if no clients are connected.
 */
export function broadcast(message: BroadcastMessage): void {
  if (clients.size === 0) return;

  const payload = JSON.stringify(message);

  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload, (err) => {
        if (err) {
          warn('Failed to send WS message', { connectionId: client.connectionId, error: err.message });
        }
      });
    }
  }
}

/** Number of currently connected WebSocket clients (for /health). */
export function getConnectionCount(): number {
  return clients.size;
}

/**
 * Gracefully close the WebSocket server and stop the heartbeat.
 * Called during process shutdown.
 */
export function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (!wss) {
      resolve();
      return;
    }

    for (const client of clients.values()) {
      client.ws.terminate();
    }
    clients.clear();

    wss.close(() => {
      wss = null;
      info('WebSocket server closed');
      resolve();
    });
  });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function handleConnection(ws: WebSocket, _req: IncomingMessage): void {
  const connectionId = `ws-${++connectionCounter}-${Date.now()}`;

  const client: TrackedClient = {
    ws,
    connectionId,
    isAlive: true,
    messageCount: 0,
    windowStart: Date.now(),
  };

  clients.set(connectionId, client);
  info('WebSocket client connected', { connectionId, total: clients.size });

  ws.on('pong', () => {
    client.isAlive = true;
  });

  ws.on('message', (data) => handleClientMessage(client, data));

  ws.on('close', () => {
    clients.delete(connectionId);
    info('WebSocket client disconnected', { connectionId, total: clients.size });
  });

  ws.on('error', (err) => {
    logError('WebSocket client error', { connectionId }, err);
    clients.delete(connectionId);
  });
}

function handleClientMessage(client: TrackedClient, data: unknown): void {
  // Enforce max payload size
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (raw.byteLength > MAX_CLIENT_MESSAGE_BYTES) {
    warn('WS client message too large — closing', {
      connectionId: client.connectionId,
      bytes: raw.byteLength,
      max: MAX_CLIENT_MESSAGE_BYTES,
    });
    client.ws.close(1009, 'Message too large');
    clients.delete(client.connectionId);
    return;
  }

  // Per-connection rate limiting
  const now = Date.now();
  if (now - client.windowStart > RATE_LIMIT_WINDOW_MS) {
    client.messageCount = 0;
    client.windowStart = now;
  }

  client.messageCount += 1;
  if (client.messageCount > RATE_LIMIT_MAX_MESSAGES) {
    warn('WS client rate limit exceeded — closing', {
      connectionId: client.connectionId,
      count: client.messageCount,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    client.ws.close(1008, 'Rate limit exceeded');
    clients.delete(client.connectionId);
    return;
  }
}

function runHeartbeat(): void {
  for (const [id, client] of clients.entries()) {
    if (!client.isAlive) {
      warn('WS client unresponsive — terminating', { connectionId: id });
      client.ws.terminate();
      clients.delete(id);
      continue;
    }
    client.isAlive = false;
    client.ws.ping();
  }
}
