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
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, IncomingHttpHeaders } from 'http';
import type { Server } from 'http';
import type { DedupCache as IDedupCache } from '../redis/dedup.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import type { ContractEventStore } from '../indexer/store.js';
import { SSE_STREAM_UPDATE_EVENT, sseEventBus } from '../streams/sseEmitter.js';
import type { StreamEventReplayFilter } from '../db/types.js';
import { getTracer } from '../tracing/hooks.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { logger } from '../lib/logger.js';
import { CORRELATION_ID_HEADER, isValidCorrelationId } from '../middleware/correlationId.js';
import {
  isValidStellarPublicKey,
  parseHandshakeSubscriptionFilter,
  parseWsClientMessage,
  type SubscriptionFilter,
} from './messageHandler.js';
import {
  getClientIp,
  checkLimiter,
  trackConnection,
  untrackConnection,
} from './connectionLimiter.js';

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
  correlationId?: string;
  ledger?: number;
  recipientAddress?: string;
}

export interface BackpressureMetrics {
  droppedMessages: number;
  terminatedConnections: number;
  sentMessages: number;
}

export type BackpressureAction = 'drop' | 'terminate';

export interface StreamHubBackpressureEvent {
  action: BackpressureAction;
  streamId: string;
  eventId: string;
  connectionId: string;
  bufferedAmount: number;
  thresholdBytes: number;
  timestamp: string;
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
  correlationId?: string;
  authenticatedSubject?: string;
  metrics: ConnectionMetrics;
  subscriptionFilters: Map<string, SubscriptionFilter>;
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

export class StreamHub extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly streamSubscriptions = new Map<string, Set<WebSocket>>();
  private readonly recipientSubscriptions = new Map<string, Set<WebSocket>>();
  private readonly dedup: IDedupCache;
  private readonly ownsDedup: boolean;
  private readonly wsAuthRequired: boolean;
  private readonly jwtSecret: string | undefined;
  private eventStore: ContractEventStore | undefined;

  public getEventStore(): ContractEventStore | undefined {
    return this.eventStore;
  }

  private readonly metrics: BackpressureMetrics = {
    droppedMessages: 0,
    terminatedConnections: 0,
    sentMessages: 0,
  };

  private dropBytes: number = BACKPRESSURE_DROP_BYTES;
  private terminateBytes: number = BACKPRESSURE_TERMINATE_BYTES;

  constructor(server: Server, options?: StreamHubOptions) {
    super();

    if (options?.dedupCache) {
      this.dedup = options.dedupCache;
      this.ownsDedup = false;
    } else {
      this.dedup = new InMemoryDedupCache();
      this.ownsDedup = true;
    }

    this.wsAuthRequired = options?.wsAuthRequired ?? process.env.WS_AUTH_REQUIRED === 'true';

    this.jwtSecret = options?.jwtSecret ?? process.env.JWT_SECRET;

    this.eventStore = options?.eventStore;

    // Use noServer mode so we fully control the upgrade handshake.
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'ws://localhost').pathname;
      if (pathname !== '/ws/streams') return;

      // 1. Connection Limiter Check
      const ip = getClientIp(req);
      const limitResult = checkLimiter(ip);
      if (!limitResult.allowed) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.close(limitResult.code || 4029, limitResult.reason);
        });
        return;
      }

      // 2. Auth Check (if required)
      if (this.wsAuthRequired) {
        const result = verifyWsToken(req, this.jwtSecret);
        if (!result.ok) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Content-Type: text/plain\r\n' +
              'Connection: close\r\n\r\n' +
              `Unauthorized: ${result.code}\r\n`
          );
          socket.destroy();
          return;
        }
      }

      // 3. Accept Upgrade
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.onConnect(ws, req);
    });
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private onConnect(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = randomUUID();
    const ip = getClientIp(req);
    trackConnection(ip);
    const connectedAt = Date.now();
    const correlationId = this.extractCorrelationId(req.headers);
    const authenticatedSubject = this.extractAuthenticatedSubject(req);

    const state: ClientState = {
      id: connectionId,
      connectedAt,
      ip,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    };
    if (correlationId !== undefined) {
      state.correlationId = correlationId;
    }
    if (authenticatedSubject !== undefined) {
      state.authenticatedSubject = authenticatedSubject;
    }
    this.clients.set(ws, state);

    logger.info('WebSocket connected', correlationId, {
      event: 'ws_connect',
      connectionId,
      ip,
      timestamp: new Date(connectedAt).toISOString(),
    });

    this.applyHandshakeSubscription(ws, req);

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

    untrackConnection(state.ip);

    for (const filter of state.subscriptionFilters.values()) {
      this.removeSubscriptionFromIndexes(ws, filter);
    }

    const durationMs = Date.now() - state.connectedAt;
    logger.info('WebSocket disconnected', state.correlationId, {
      event: 'ws_disconnect',
      connectionId: state.id,
      durationMs,
      code: code ?? 0,
      reason: reason?.toString('utf8') ?? '',
      metrics: state.metrics,
    });

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(ws, 'INVALID_JSON', 'Message is not valid JSON');
      return;
    }

    const result = parseWsClientMessage(parsed);
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }

    if (result.message.type === 'replay') {
      void this.replayFromCursor(ws, result.message.filter);
      return;
    }

    const authorized = this.authorizeSubscriptionFilter(ws, result.message.filter);
    if (!authorized.ok) {
      this.sendError(ws, authorized.code, authorized.message);
      return;
    }

    if (result.message.type === 'subscribe') {
      this.subscribe(ws, authorized.filter);
    } else {
      this.unsubscribe(ws, authorized.filter);
    }
  }

  private subscribe(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const key = this.subscriptionKey(filter);
    if (state.subscriptionFilters.has(key)) return;

    state.subscriptionFilters.set(key, filter);
    this.addSubscriptionToIndexes(ws, filter);
  }

  private unsubscribe(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const key = this.subscriptionKey(filter);
    const existing = state.subscriptionFilters.get(key);
    if (!existing) return;

    state.subscriptionFilters.delete(key);
    this.removeSubscriptionFromIndexes(ws, existing);
  }

  private authorizeSubscriptionFilter(
    ws: WebSocket,
    filter: SubscriptionFilter
  ): { ok: true; filter: SubscriptionFilter } | { ok: false; code: string; message: string } {
    const state = this.clients.get(ws);
    if (!state) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'WebSocket client is not registered' };
    }

    if (filter.streamId !== undefined) {
      return { ok: true, filter };
    }

    const authenticatedRecipient = this.authenticatedRecipientSubject(state);

    if (filter.recipientAddress !== undefined) {
      if (authenticatedRecipient === undefined) {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          message:
            'recipient_address subscriptions require an authenticated Stellar public key subject',
        };
      }

      if (filter.recipientAddress !== authenticatedRecipient) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'recipient_address subscriptions must match the authenticated subject',
        };
      }
      return { ok: true, filter };
    }

    if (authenticatedRecipient === undefined) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'empty subscription filters require an authenticated Stellar public key subject',
      };
    }

    return { ok: true, filter: { recipientAddress: authenticatedRecipient } };
  }

  private subscriptionKey(filter: SubscriptionFilter): string {
    if (filter.streamId !== undefined) return `stream:${filter.streamId}`;
    if (filter.recipientAddress !== undefined) return `recipient:${filter.recipientAddress}`;
    return 'recipient:';
  }

  private addSubscriptionToIndexes(ws: WebSocket, filter: SubscriptionFilter): void {
    if (filter.streamId !== undefined) {
      if (!this.streamSubscriptions.has(filter.streamId)) {
        this.streamSubscriptions.set(filter.streamId, new Set());
      }
      this.streamSubscriptions.get(filter.streamId)!.add(ws);
      return;
    }

    if (filter.recipientAddress !== undefined) {
      if (!this.recipientSubscriptions.has(filter.recipientAddress)) {
        this.recipientSubscriptions.set(filter.recipientAddress, new Set());
      }
      this.recipientSubscriptions.get(filter.recipientAddress)!.add(ws);
    }
  }

  private removeSubscriptionFromIndexes(ws: WebSocket, filter: SubscriptionFilter): void {
    if (filter.streamId !== undefined) {
      this.streamSubscriptions.get(filter.streamId)?.delete(ws);
      if (this.streamSubscriptions.get(filter.streamId)?.size === 0) {
        this.streamSubscriptions.delete(filter.streamId);
      }
      return;
    }

    if (filter.recipientAddress !== undefined) {
      this.recipientSubscriptions.get(filter.recipientAddress)?.delete(ws);
      if (this.recipientSubscriptions.get(filter.recipientAddress)?.size === 0) {
        this.recipientSubscriptions.delete(filter.recipientAddress);
      }
    }
  }

  /**
   * Force-close every socket currently subscribed to a stream ID.
   * Returns the number of sockets targeted before the disconnect completes.
   */
  disconnectByStreamId(streamId: string): number {
    const subscribers = this.streamSubscriptions.get(streamId);
    if (!subscribers || subscribers.size === 0) {
      return 0;
    }

    const targets = Array.from(subscribers);
    this.streamSubscriptions.delete(streamId);

    for (const ws of targets) {
      try {
        ws.close(4000, 'admin-forced-disconnect');
      } catch {
        try {
          ws.terminate();
        } catch {
          // no-op
        }
      }
    }

    return targets.length;
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────

  async broadcast(event: StreamUpdateEvent): Promise<void> {
    const { streamId, eventId, payload } = event;

    if (await this.dedup.has(streamId, eventId)) return;
    await this.dedup.add(streamId, eventId);

    // Emit to Server-Sent Events bus
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, event);

    const subscribers = this.matchingSubscribers(event);
    if (subscribers.size === 0) return;

    const correlationId = getCorrelationId();
    const message = JSON.stringify({
      type: 'stream_update',
      streamId,
      eventId,
      payload,
      correlationId,
    });
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

  private matchingSubscribers(event: StreamUpdateEvent): Set<WebSocket> {
    const targets = new Set<WebSocket>();
    const streamMatches = this.streamSubscriptions.get(event.streamId);
    if (streamMatches) {
      for (const ws of streamMatches) targets.add(ws);
    }

    const recipientAddress = this.extractRecipientAddress(event);
    if (recipientAddress !== undefined) {
      const recipientMatches = this.recipientSubscriptions.get(recipientAddress);
      if (recipientMatches) {
        for (const ws of recipientMatches) targets.add(ws);
      }
    }

    return targets;
  }

  private deliverBatch(
    batch: WebSocket[],
    message: string,
    streamId: string,
    eventId: string
  ): number {
    let sent = 0;

    for (const ws of batch) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const buffered = ws.bufferedAmount;

      if (buffered > this.terminateBytes) {
        this.metrics.terminatedConnections++;
        this.metrics.droppedMessages++;
        this.emitBackpressure(ws, 'terminate', buffered, this.terminateBytes, streamId, eventId);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        this.onDisconnect(ws);
        continue;
      }

      if (buffered > this.dropBytes) {
        this.metrics.droppedMessages++;
        this.emitBackpressure(ws, 'drop', buffered, this.dropBytes, streamId, eventId);
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
    const correlationId = getCorrelationId();
    const tracer = getTracer();
    const span = tracer.startSpan({
      traceId: correlationId,
      serviceName: 'fluxora-ws',
      tags: {
        'ws.stream_id': streamId,
        'ws.event_id': eventId,
        'ws.recipients': sent,
        'ws.correlation_id': correlationId,
      },
    });
    tracer.recordEvent(span, 'ws.broadcast', {
      streamId,
      eventId,
      recipients: sent,
      correlationId,
    });
    tracer.endSpan(span, 'ok');

    return sent;
  }

  private emitBackpressure(
    ws: WebSocket,
    action: BackpressureAction,
    bufferedAmount: number,
    thresholdBytes: number,
    streamId: string,
    eventId: string
  ): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const event: StreamHubBackpressureEvent = {
      action,
      streamId,
      eventId,
      connectionId: state.id,
      bufferedAmount,
      thresholdBytes,
      timestamp: new Date().toISOString(),
    };

    this.emit('backpressure', event);
    logger.warn('WebSocket backpressure applied', state.correlationId, {
      event: 'ws_backpressure',
      ...event,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractAuthenticatedSubject(req: IncomingMessage): string | undefined {
    const result = verifyWsToken(req, this.jwtSecret);
    if (!result.ok) return undefined;

    const subject = result.payload.sub?.trim();
    return subject ? subject : undefined;
  }

  private authenticatedRecipientSubject(state: ClientState): string | undefined {
    const subject = state.authenticatedSubject;
    if (subject === undefined || !isValidStellarPublicKey(subject)) return undefined;
    return subject;
  }

  private applyHandshakeSubscription(ws: WebSocket, req: IncomingMessage): void {
    const result = parseHandshakeSubscriptionFilter(req.url ?? '/');
    if (!result.ok) {
      this.sendError(ws, 'INVALID_MESSAGE', result.message);
      return;
    }

    if (result.filter === null) return;

    const authorized = this.authorizeSubscriptionFilter(ws, result.filter);
    if (!authorized.ok) {
      this.sendError(ws, authorized.code, authorized.message);
      return;
    }

    this.subscribe(ws, authorized.filter);
  }

  private extractCorrelationId(headers: IncomingHttpHeaders): string | undefined {
    const incoming = headers[CORRELATION_ID_HEADER];
    if (typeof incoming === 'string') {
      const trimmed = incoming.trim();
      if (trimmed.length > 0 && isValidCorrelationId(trimmed)) {
        return trimmed;
      }
    }
    return undefined;
  }

  private extractRecipientAddress(event: StreamUpdateEvent): string | undefined {
    if (event.recipientAddress !== undefined && event.recipientAddress.trim() !== '') {
      return event.recipientAddress.trim();
    }

    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return undefined;
    }

    const candidate =
      (payload as Record<string, unknown>)['recipient_address'] ??
      (payload as Record<string, unknown>)['recipientAddress'] ??
      (payload as Record<string, unknown>)['recipient'];

    if (typeof candidate !== 'string') return undefined;

    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

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
    if (typeof opts.terminateBytes === 'number' && opts.terminateBytes >= 0)
      this.terminateBytes = opts.terminateBytes;
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
