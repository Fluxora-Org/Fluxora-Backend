/**
 * WebSocket connection registry.
 *
 * Owns every piece of per-connection state the hub keeps: the socket → state
 * map, the inbound rate-limit window, and the two subscription indexes
 * (stream-scoped and recipient-scoped) used for fanout. It deliberately knows
 * nothing about sockets' wire behaviour — sending, backpressure, and batching
 * live in their own modules — so the registry stays a plain, testable
 * collection of connections and subscriptions.
 *
 * @module ws/connectionRegistry
 */

import { WebSocket } from 'ws';
import type { SubscriptionFilter } from './messageHandler.js';
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from './hubConfig.js';
import type { ClientState, ConnectionMetrics } from './hubTypes.js';

/** Create the mutable per-connection state for a freshly accepted socket. */
export function createClientState(init: {
  id: string;
  connectedAt: number;
  ip: string;
  correlationId?: string;
  authenticatedSubject?: string;
}): ClientState {
  const metrics: ConnectionMetrics = {
    messagesReceived: 0,
    messagesSent: 0,
    bytesReceived: 0,
    bytesSent: 0,
  };

  const state: ClientState = {
    id: init.id,
    connectedAt: init.connectedAt,
    ip: init.ip,
    metrics,
    subscriptionFilters: new Map(),
    messageTimestamps: [],
    missedPongs: 0,
  };
  if (init.correlationId !== undefined) {
    state.correlationId = init.correlationId;
  }
  if (init.authenticatedSubject !== undefined) {
    state.authenticatedSubject = init.authenticatedSubject;
  }
  return state;
}

/**
 * Stable key for a subscription filter.
 *
 * An empty filter is stored under the bare `recipient:` key: by the time a
 * filter reaches the registry it has already been narrowed to the
 * authenticated recipient by the router.
 */
export function subscriptionKey(filter: SubscriptionFilter): string {
  if (filter.streamId !== undefined) return `stream:${filter.streamId}`;
  if (filter.recipientAddress !== undefined) return `recipient:${filter.recipientAddress}`;
  return 'recipient:';
}

/** Connected sockets and their subscription indexes. */
export class ConnectionRegistry {
  /** Live connections, keyed by socket. */
  readonly clients = new Map<WebSocket, ClientState>();
  /** Subscribers per stream ID. */
  private readonly streamSubscriptions = new Map<string, Set<WebSocket>>();
  /** Subscribers per authenticated recipient address. */
  private readonly recipientSubscriptions = new Map<string, Set<WebSocket>>();

  register(ws: WebSocket, state: ClientState): void {
    this.clients.set(ws, state);
  }

  get(ws: WebSocket): ClientState | undefined {
    return this.clients.get(ws);
  }

  has(ws: WebSocket): boolean {
    return this.clients.has(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  entries(): IterableIterator<[WebSocket, ClientState]> {
    return this.clients.entries();
  }

  keys(): IterableIterator<WebSocket> {
    return this.clients.keys();
  }

  /** Forget a connection. Subscription indexes are cleaned up separately. */
  unregister(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  // ── Inbound rate limiting ────────────────────────────────────────────────

  /**
   * Sliding-window rate limit for a single connection.
   *
   * Timestamps older than one window are discarded, and the current message is
   * only admitted while the window holds fewer than `RATE_LIMIT_MAX` entries.
   */
  checkRateLimit(ws: WebSocket): boolean {
    const state = this.clients.get(ws);
    if (!state) return false;

    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    state.messageTimestamps = state.messageTimestamps.filter((t) => t >= cutoff);

    if (state.messageTimestamps.length >= RATE_LIMIT_MAX) return false;

    state.messageTimestamps.push(now);
    return true;
  }

  // ── Subscription indexes ─────────────────────────────────────────────────

  /**
   * Record a filter on the connection and index the socket for fanout.
   *
   * Returns `false` without touching the indexes when the connection already
   * holds this exact filter, so a repeated subscribe is a no-op.
   */
  addSubscription(ws: WebSocket, filter: SubscriptionFilter): boolean {
    const state = this.clients.get(ws);
    if (!state) return false;

    const key = subscriptionKey(filter);
    if (state.subscriptionFilters.has(key)) return false;

    state.subscriptionFilters.set(key, filter);

    if (filter.streamId !== undefined) {
      let subscribers = this.streamSubscriptions.get(filter.streamId);
      if (!subscribers) {
        subscribers = new Set();
        this.streamSubscriptions.set(filter.streamId, subscribers);
      }
      subscribers.add(ws);
      return true;
    }

    if (filter.recipientAddress !== undefined) {
      let subscribers = this.recipientSubscriptions.get(filter.recipientAddress);
      if (!subscribers) {
        subscribers = new Set();
        this.recipientSubscriptions.set(filter.recipientAddress, subscribers);
      }
      subscribers.add(ws);
    }
    return true;
  }

  /**
   * Drop a filter from the connection and from the matching index, pruning
   * the index entry once its last subscriber is gone.
   */
  removeSubscription(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.clients.get(ws);
    if (!state) return;

    state.subscriptionFilters.delete(subscriptionKey(filter));

    if (filter.streamId !== undefined) {
      const subscribers = this.streamSubscriptions.get(filter.streamId);
      subscribers?.delete(ws);
      if (subscribers?.size === 0) {
        this.streamSubscriptions.delete(filter.streamId);
      }
      return;
    }

    if (filter.recipientAddress !== undefined) {
      const subscribers = this.recipientSubscriptions.get(filter.recipientAddress);
      subscribers?.delete(ws);
      if (subscribers?.size === 0) {
        this.recipientSubscriptions.delete(filter.recipientAddress);
      }
    }
  }

  /** Remove every filter held by a connection (used on disconnect). */
  removeAllSubscriptions(ws: WebSocket): void {
    const state = this.clients.get(ws);
    if (!state) return;
    for (const filter of state.subscriptionFilters.values()) {
      this.removeSubscription(ws, filter);
    }
  }

  /** Number of sockets currently subscribed to a stream ID. */
  streamSubscriberCount(streamId: string): number {
    return this.streamSubscriptions.get(streamId)?.size ?? 0;
  }

  /** Subscribers of a stream ID, or an empty set when nobody listens. */
  streamSubscribers(streamId: string): ReadonlySet<WebSocket> {
    return this.streamSubscriptions.get(streamId) ?? new Set<WebSocket>();
  }

  /** Subscribers of a recipient address, or an empty set when nobody listens. */
  recipientSubscribers(recipientAddress: string): ReadonlySet<WebSocket> {
    return this.recipientSubscriptions.get(recipientAddress) ?? new Set<WebSocket>();
  }

  /**
   * Read-only view of the stream index, for the subscription-cardinality
   * collector.
   *
   * @security Exposes only streamId keys and subscriber Set sizes; no
   *           WebSocket references or client state is leaked.
   */
  streamSubscriptionIndex(): ReadonlyMap<string, Set<WebSocket>> {
    return this.streamSubscriptions;
  }

  /**
   * Read-only view of the recipient index, for diagnostics and tests.
   *
   * @security Exposes only recipientAddress keys and subscriber Set sizes;
   *           raw WebSocket references are still opaque and must not be
   *           mutated by callers.
   */
  recipientSubscriptionIndex(): ReadonlyMap<string, Set<WebSocket>> {
    return this.recipientSubscriptions;
  }

  /**
   * Detach a stream's subscriber set so the caller can close those sockets.
   *
   * The index entry is removed before the sockets are closed, so a broadcast
   * racing the disconnect cannot target an already-closed socket.
   *
   * @returns The sockets that were subscribed, or an empty array.
   */
  takeStreamSubscribers(streamId: string): WebSocket[] {
    const subscribers = this.streamSubscriptions.get(streamId);
    if (!subscribers || subscribers.size === 0) {
      return [];
    }
    const targets = Array.from(subscribers);
    this.streamSubscriptions.delete(streamId);
    return targets;
  }
}
