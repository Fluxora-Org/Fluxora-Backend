/**
 * WebSocket Hub — stream update broadcast channel (#49).
 *
 * Responsibilities:
 *   - Track connected clients per stream subscription.
 *   - Rate-limit incoming messages per connection.
 *   - Reject oversized inbound payloads.
 *   - Deduplicate outbound events by (streamId, eventId).
 *   - Broadcast stream update events to all subscribed clients.
 *   - Apply backpressure to slow/stalled clients.
 *   - Optionally enforce JWT authentication on upgrade (WS_AUTH_REQUIRED).
 *
 * ## WebSocket JWT Auth (optional, backward-compatible)
 *
 * Controlled by two environment variables:
 *   WS_AUTH_REQUIRED=true   — reject unauthenticated upgrade requests (401)
 *   JWT_SECRET=<secret>     — secret used to verify HS256 tokens
 *
 * When WS_AUTH_REQUIRED is absent or false, all connections are accepted
 * regardless of whether a token is present. This allows a zero-downtime
 * rollout: deploy with auth disabled, issue tokens to clients, then flip
 * the flag.
 *
 * Token delivery (first match wins):
 *   1. Authorization: Bearer <token>  header on the upgrade request
 *   2. ?token=<jwt>                   query-string parameter
 *
 * On auth failure the server sends HTTP 401 before the WebSocket handshake
 * completes, so the client never enters the OPEN state.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { DedupCache as IDedupCache } from '../redis/dedup.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import type { ContractEventStore } from '../indexer/store.js';
import type { StreamEventReplayFilter } from '../db/types.js';
import { getTracer } from '../tracing/hooks.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_MESSAGE_BYTES = 4_096;
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 10_000;

export const BACKPRESSURE_DROP_BYTES = 1 * 1024 * 1024;
export const BACKPRESSURE_TERMINATE_BYTES = 4 * 1024 * 1024;
export const FANOUT_YIELD_BATCH = 256;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamUpdateEvent {
  streamId: string;
  eventId: string;
  payload: unknown;
  ledger?: number;
}

export interface BackpressureMetrics {
  droppedMessages: number;
  terminatedConnections: number;
  sentMessages: number;
}

interface ConnectionMetrics {
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
}

interface ClientState {
  id: string;
  connectedAt: number;
  ip: string;
  metrics: ConnectionMetrics;
  subscriptions: Set<string>;
  messageTimestamps: number[];
}

// ── Hub options ───────────────────────────────────────────────────────────────

export interface StreamHubOptions {
  dedupCache?: IDedupCache;
  /**
   * When true, upgrade requests without a valid JWT are rejected with 401.
   * Defaults to the WS_AUTH_REQUIRED environment variable.
   */
  wsAuthRequired?: boolean;
  /**
   * JWT secret used to verify tokens on upgrade.
   * Defaults to the JWT_SECRET environment variable.
   */
  jwtSecret?: string;
  /**
   * Event store used by replayFromCursor to fetch historical events.
   * When absent, replayFromCursor sends an empty result.
   */
  eventStore?: ContractEventStore;
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export class StreamHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly subscriptions = new Map<string, Set<WebSocket>>();
  private readonly dedup: IDedupCache;
  private readonly ownsDedup: boolean;
  private readonly wsAuthRequired: boolean;
  private readonly jwtSecret: string | undefined;
  private eventStore: ContractEventStore | undefined;

  private readonly metrics: BackpressureMetrics = {
    droppedMessages: 0,
    terminatedConnections: 0,
    sentMessages: 0,
  };

  private dropBytes: number = BACKPRESSURE_DROP_BYTES;
  private terminateBytes: number = BACKPRESSURE_TERMINATE_BYTES;

  constructor(server: Server, options?: StreamHubOptions) {
    if (options?.dedupCache) {
      this.dedup = options.dedupCache;
      this.ownsDedup = false;
    } else {
      this.dedup = new InMemoryDedupCache();
      this.ownsDedup = true;
    }

    this.wsAuthRequired =
      options?.wsAuthRequired ??
      (process.env.WS_AUTH_REQUIRED === 'true');

    this.jwtSecret =
      options?.jwtSecret ??
      process.env.JWT_SECRET;

    this.eventStore = options?.eventStore;

    if (this.wsAuthRequired) {
      // Use noServer mode so we fully control the upgrade handshake.
      this.wss = new WebSocketServer({ noServer: true });

      server.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'ws://localhost').pathname;
        if (pathname !== '/ws/streams') return;

        const result = verifyWsToken(req, this.jwtSecret);
        if (!result.ok) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
            'Content-Type: text/plain\r\n' +
            'Connection: close\r\n\r\n' +
            `Unauthorized: ${result.code}\r\n`,
          );
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      });
    } else {
      // Let the WebSocketServer handle upgrades automatically.
      this.wss = new WebSocketServer({ server, path: '/ws/streams' });
    }

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.onConnect(ws, req);
    });
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private onConnect(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = randomUUID();
    const ip = req.socket.remoteAddress ?? 'unknown';
    const connectedAt = Date.now();

    this.clients.set(ws, {
      id: connectionId,
      connectedAt,
      ip,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptions: new Set(),
      messageTimestamps: [],
    });

    console.info(
      JSON.stringify({ event: 'ws_connect', connectionId, ip, timestamp: new Date(connectedAt).toISOString() }),
    );

    ws.on('message', (data, isBinary) => {
      const state = this.clients.get(ws);

      if (isBinary) {
        this.sendError(ws, 'BINARY_NOT_SUPPORTED', 'Binary frames are not accepted');
        return;
      }

      const raw = data.toString('utf8');
      const byteLength = Buffer.byteLength(raw, 'utf8');

      if (state) {
        state.metrics.messagesReceived += 1;
        state.metrics.bytesReceived += byteLength;
      }

      if (byteLength > MAX_MESSAGE_BYTES) {
        this.sendError(ws, 'PAYLOAD_TOO_LARGE', `Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
        return;
      }

      if (!this.checkRateLimit(ws)) {
        this.sendError(ws, 'RATE_LIMIT_EXCEEDED', 'Too many messages; slow down');
        return;
      }

      this.handleMessage(ws, raw);
    });

    ws.on('close', (code, reason) => this.onDisconnect(ws, code, reason));
    ws.on('error', () => ws.close(1011, 'Internal Error'));
  }

  private onDisconnect(ws: WebSocket, code?: number, reason?: Buffer): void {
    const state = this.clients.get(ws);
    if (!state) return;

    for (const streamId of state.subscriptions) {
      this.subscriptions.get(streamId)?.delete(ws);
      if (this.subscriptions.get(streamId)?.size === 0) {
        this.subscriptions.delete(streamId);
      }
    }

    const durationMs = Date.now() - state.connectedAt;
    console.info(
      JSON.stringify({
        event: 'ws_disconnect',
        connectionId: state.id,
        durationMs,
        code: code ?? 0,
        reason: reason?.toString('utf8') ?? '',
        metrics: state.metrics,
      }),
    );

    this.clients.delete(ws);
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  private checkRateLimit(ws: WebSocket): boolean {
    const state = this.clients.get(ws);
    if (!state) return false;

    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    state.messageTimestamps = state.messageTimestamps.filter((t) => t >= cutoff);

    if (state.messageTimestamps.length >= RATE_LIMIT_MAX) return false;

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

    if (type === 'replay') {
      const { afterEventId, fromLedger, toledger, contractId, topic, limit } = msg as Record<string, unknown>;
      const replayFilter: StreamEventReplayFilter = {
        ...(typeof afterEventId === 'string' ? { afterEventId } : {}),
        ...(typeof fromLedger === 'number' ? { fromLedger } : {}),
        ...(typeof toledger === 'number' ? { toledger } : {}),
        ...(typeof contractId === 'string' ? { contractId } : {}),
        ...(typeof topic === 'string' ? { topic } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      };
      void this.replayFromCursor(ws, replayFilter);
      return;
    }

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
    if (!this.subscriptions.has(streamId)) this.subscriptions.set(streamId, new Set());
    this.subscriptions.get(streamId)!.add(ws);
  }

  private unsubscribe(ws: WebSocket, streamId: string): void {
    const state = this.clients.get(ws);
    if (!state) return;
    state.subscriptions.delete(streamId);
    this.subscriptions.get(streamId)?.delete(ws);
    if (this.subscriptions.get(streamId)?.size === 0) this.subscriptions.delete(streamId);
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────

  async broadcast(event: StreamUpdateEvent): Promise<void> {
    const { streamId, eventId, payload } = event;

    if (await this.dedup.has(streamId, eventId)) return;
    await this.dedup.add(streamId, eventId);

    const subscribers = this.subscriptions.get(streamId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({ type: 'stream_update', streamId, eventId, payload });
    const targets = Array.from(subscribers);

    if (targets.length <= FANOUT_YIELD_BATCH) {
      this.deliverBatch(targets, message, streamId, eventId);
      return;
    }

    const self = this;
    let i = 0;
    function next(): void {
      const end = Math.min(i + FANOUT_YIELD_BATCH, targets.length);
      self.deliverBatch(targets.slice(i, end), message, streamId, eventId);
      i = end;
      if (i < targets.length) setImmediate(next);
    }
    next();
  }

  private deliverBatch(batch: WebSocket[], message: string, streamId: string, eventId: string): number {
    let sent = 0;
    
    for (const ws of batch) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const buffered = ws.bufferedAmount;

      if (buffered > this.terminateBytes) {
        this.metrics.terminatedConnections++;
        this.metrics.droppedMessages++;
        try { ws.terminate(); } catch { /* ignore */ }
        this.onDisconnect(ws);
        continue;
      }

      if (buffered > this.dropBytes) {
        this.metrics.droppedMessages++;
        continue;
      }

      ws.send(message);
      this.metrics.sentMessages++;
      sent++;

      const state = this.clients.get(ws);
      if (state) {
        state.metrics.messagesSent += 1;
        state.metrics.bytesSent += Buffer.byteLength(message, 'utf8');
      }
    }

    // Record a span event for observability (fire-and-forget, no correlationId context here).
    const tracer = getTracer();
    const span = tracer.startSpan({
      traceId: eventId,
      serviceName: 'fluxora-ws',
      tags: { 'ws.stream_id': streamId, 'ws.event_id': eventId, 'ws.recipients': sent },
    });
    tracer.recordEvent(span, 'ws.broadcast', { streamId, eventId, recipients: sent });
    tracer.endSpan(span, 'ok');
    
    return sent;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code, message }));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getMetrics(): Readonly<BackpressureMetrics> {
    return { ...this.metrics };
  }

  setBackpressureThresholds(opts: { dropBytes?: number; terminateBytes?: number }): void {
    if (typeof opts.dropBytes === 'number' && opts.dropBytes >= 0) this.dropBytes = opts.dropBytes;
    if (typeof opts.terminateBytes === 'number' && opts.terminateBytes >= 0) this.terminateBytes = opts.terminateBytes;
  }

  /**
   * Attach (or replace) the event store used by replayFromCursor.
   * Called by the indexer route after the store is configured.
   */
  setEventStore(store: ContractEventStore): void {
    this.eventStore = store;
  }

  /**
   * Replay stored events to a single connected client starting after the
   * given cursor eventId.  Events are fetched from the attached event store
   * in ledger-ascending order and sent as `stream_replay` frames.
   *
   * The method is intentionally fire-and-forget from the caller's perspective:
   * it resolves once all pages have been sent (or the client disconnects).
   *
   * @param ws         Target WebSocket connection (must be OPEN).
   * @param filter     Replay filter forwarded to the event store.
   *                   `afterEventId` acts as the exclusive cursor.
   */
  async replayFromCursor(ws: WebSocket, filter: StreamEventReplayFilter = {}): Promise<void> {
    if (!this.eventStore) {
      this.sendError(ws, 'REPLAY_UNAVAILABLE', 'Event store is not configured');
      return;
    }

    let cursor = filter.afterEventId;
    const pageSize = Math.min(filter.limit ?? 100, 1000);

    do {
      if (ws.readyState !== WebSocket.OPEN) return;

      const pageFilter: StreamEventReplayFilter = {
        ...filter,
        ...(cursor !== undefined ? { afterEventId: cursor } : {}),
        limit: pageSize,
      };
      const result = await this.eventStore.getEvents(pageFilter);

      for (const event of result.events) {
        if (ws.readyState !== WebSocket.OPEN) return;

        const message = JSON.stringify({
          type: 'stream_replay',
          eventId: event.eventId,
          ledger: event.ledger,
          topic: event.topic,
          payload: event.payload,
          happenedAt: event.happenedAt,
        });

        ws.send(message);

        const state = this.clients.get(ws);
        if (state) {
          state.metrics.messagesSent += 1;
          state.metrics.bytesSent += Buffer.byteLength(message, 'utf8');
        }
        this.metrics.sentMessages++;
      }

      cursor = result.nextCursor;
    } while (cursor !== undefined);

    // Signal end of replay stream
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stream_replay_complete', cursor: cursor ?? null }));
    }
  }

  async close(cb?: () => void): Promise<void> {
    if (this.ownsDedup) await this.dedup.close();
    this.wss.close(cb);
  }

  async _resetDedup(): Promise<void> {
    await this.dedup.clear();
  }

  _resetMetrics(): void {
    this.metrics.droppedMessages = 0;
    this.metrics.terminatedConnections = 0;
    this.metrics.sentMessages = 0;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _hub: StreamHub | null = null;

export function createStreamHub(server: Server, options?: StreamHubOptions): StreamHub {
  _hub = new StreamHub(server, options);
  return _hub;
}

export function getStreamHub(): StreamHub | null {
  return _hub;
}

export function resetStreamHub(): void {
  _hub = null;
}
