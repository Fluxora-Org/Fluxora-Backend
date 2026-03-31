/**
 * WebSocket Hub — stream update broadcast channel (#49).
 *
 * Responsibilities:
 *   - Track connected clients per stream subscription.
 *   - Rate-limit incoming messages per connection.
 *   - Reject oversized inbound payloads.
 *   - Deduplicate outbound events by (streamId, eventId) to prevent
 *     duplicate delivery on reconnect or RPC retry.
 *   - Broadcast stream update events to all subscribed clients.
 *
 * Protocol (JSON over WebSocket):
 *   Client → Server:  { type: "subscribe",   streamId: string }
 *   Client → Server:  { type: "unsubscribe", streamId: string }
 *   Server → Client:  { type: "stream_update", streamId: string, eventId: string, payload: unknown }
 *   Server → Client:  { type: "error", code: string, message: string }
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum inbound message size in bytes. Payloads larger than this are rejected. */
export const MAX_MESSAGE_BYTES = 4_096;

/** Maximum inbound messages per client per rate-limit window. */
export const RATE_LIMIT_MAX = 30;

/** Rate-limit window duration in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 10_000;

/** Maximum number of (streamId, eventId) pairs kept in the dedup cache. */
const DEDUP_CACHE_MAX = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamUpdateEvent {
  streamId: string;
  /** Unique event identifier used for deduplication. */
  eventId: string;
  payload: unknown;
}

interface ClientState {
  subscriptions: Set<string>;
  /** Timestamps of recent inbound messages for rate limiting. */
  messageTimestamps: number[];
}

// ── Dedup cache ───────────────────────────────────────────────────────────────

/**
 * LRU-style dedup cache: tracks (streamId:eventId) pairs that have already
 * been broadcast. Evicts oldest entries when the cache exceeds DEDUP_CACHE_MAX.
 */
class DedupCache {
  private readonly seen = new Map<string, true>();

  has(streamId: string, eventId: string): boolean {
    return this.seen.has(`${streamId}:${eventId}`);
  }

  add(streamId: string, eventId: string): void {
    const key = `${streamId}:${eventId}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= DEDUP_CACHE_MAX) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, true);
  }

  /** Clear all entries (for testing). */
  clear(): void {
    this.seen.clear();
  }
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export class StreamHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  /** streamId → set of subscribed clients */
  private readonly subscriptions = new Map<string, Set<WebSocket>>();
  private readonly dedup = new DedupCache();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws/streams' });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      this.onConnect(ws);
    });
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private onConnect(ws: WebSocket): void {
    this.clients.set(ws, { subscriptions: new Set(), messageTimestamps: [] });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendError(ws, 'BINARY_NOT_SUPPORTED', 'Binary frames are not accepted');
        return;
      }

      const raw = data.toString('utf8');

      // Oversized payload guard.
      if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
        this.sendError(ws, 'PAYLOAD_TOO_LARGE', `Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
        return;
      }

      // Rate limit guard.
      if (!this.checkRateLimit(ws)) {
        this.sendError(ws, 'RATE_LIMIT_EXCEEDED', 'Too many messages; slow down');
        return;
      }

      this.handleMessage(ws, raw);
    });

    ws.on('close', () => this.onDisconnect(ws));
    ws.on('error', () => this.onDisconnect(ws));
  }

  private onDisconnect(ws: WebSocket): void {
    const state = this.clients.get(ws);
    if (!state) return;

    for (const streamId of state.subscriptions) {
      this.subscriptions.get(streamId)?.delete(ws);
      if (this.subscriptions.get(streamId)?.size === 0) {
        this.subscriptions.delete(streamId);
      }
    }

    this.clients.delete(ws);
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  private checkRateLimit(ws: WebSocket): boolean {
    const state = this.clients.get(ws);
    if (!state) return false;

    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    state.messageTimestamps = state.messageTimestamps.filter((t) => t >= cutoff);

    if (state.messageTimestamps.length >= RATE_LIMIT_MAX) {
      return false;
    }

    state.messageTimestamps.push(now);
    return true;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(ws, 'INVALID_JSON', 'Message is not valid JSON');
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      this.sendError(ws, 'INVALID_MESSAGE', 'Message must be a JSON object');
      return;
    }

    const { type, streamId } = msg as Record<string, unknown>;

    if (typeof streamId !== 'string' || streamId.trim() === '') {
      this.sendError(ws, 'INVALID_MESSAGE', 'streamId must be a non-empty string');
      return;
    }

    if (type === 'subscribe') {
      this.subscribe(ws, streamId);
    } else if (type === 'unsubscribe') {
      this.unsubscribe(ws, streamId);
    } else {
      this.sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${String(type)}`);
    }
  }

  private subscribe(ws: WebSocket, streamId: string): void {
    const state = this.clients.get(ws);
    if (!state) return;

    state.subscriptions.add(streamId);

    if (!this.subscriptions.has(streamId)) {
      this.subscriptions.set(streamId, new Set());
    }
    this.subscriptions.get(streamId)!.add(ws);
  }

  private unsubscribe(ws: WebSocket, streamId: string): void {
    const state = this.clients.get(ws);
    if (!state) return;

    state.subscriptions.delete(streamId);
    this.subscriptions.get(streamId)?.delete(ws);
    if (this.subscriptions.get(streamId)?.size === 0) {
      this.subscriptions.delete(streamId);
    }
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────

  /**
   * Broadcast a stream update to all clients subscribed to `event.streamId`.
   *
   * Deduplication: if (streamId, eventId) has already been broadcast, the call
   * is a no-op. This prevents duplicate delivery when the indexer retries or
   * the RPC layer replays events.
   */
  broadcast(event: StreamUpdateEvent): void {
    const { streamId, eventId, payload } = event;

    if (this.dedup.has(streamId, eventId)) {
      return; // already delivered
    }
    this.dedup.add(streamId, eventId);

    const subscribers = this.subscriptions.get(streamId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({ type: 'stream_update', streamId, eventId, payload });

    for (const ws of subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', code, message }));
    }
  }

  /** Number of currently connected clients (for health/metrics). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Close the underlying WebSocket server (for graceful shutdown). */
  close(cb?: () => void): void {
    this.wss.close(cb);
  }

  /** Reset dedup cache (for testing). */
  _resetDedup(): void {
    this.dedup.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _hub: StreamHub | null = null;

export function createStreamHub(server: Server): StreamHub {
  _hub = new StreamHub(server);
  return _hub;
}

export function getStreamHub(): StreamHub | null {
  return _hub;
}

/** Reset singleton (for testing). */
export function resetStreamHub(): void {
  _hub = null;
}
