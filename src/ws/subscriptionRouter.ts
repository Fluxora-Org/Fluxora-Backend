/**
 * WebSocket subscription routing.
 *
 * Decides *who* should receive an event and *whether* a client is allowed to
 * subscribe in the first place:
 *
 *  - authorizes inbound and handshake subscription filters against the
 *    authenticated subject and the `streams` table,
 *  - resolves the recipient address an event targets (explicit field or
 *    payload field),
 *  - splits the resulting subscriber set into clients that opted into
 *    micro-batching and clients that receive one frame per event.
 *
 * The registry (see `connectionRegistry.ts`) owns the subscription indexes;
 * this module only decides what goes in and reads them back out.
 *
 * @module ws/subscriptionRouter
 */

import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { streamRepository } from '../db/repositories/streamRepository.js';
import {
  isValidStellarPublicKey,
  parseHandshakeSubscriptionFilter,
  type SubscriptionFilter,
} from './messageHandler.js';
import { subscriptionKey, type ConnectionRegistry } from './connectionRegistry.js';
import type { ClientState, StreamUpdateEvent } from './hubTypes.js';

/** Result of authorizing one subscription filter. */
export type SubscriptionAuthorization =
  | { ok: true; filter: SubscriptionFilter }
  | { ok: false; code: string; message: string };

/** A subscriber that opted into `stream_update_batch` frames. */
export interface BatchTarget {
  ws: WebSocket;
  state: ClientState;
}

/** Subscribers of one event, split by their batching preference. */
export interface FanoutTargets {
  /** Clients that receive a single `stream_update_batch` frame per flush. */
  batched: BatchTarget[];
  /** Clients that receive one `stream_update` frame per event. */
  immediate: WebSocket[];
}

/** Sends a protocol error frame; supplied by the hub (backpressure-aware). */
export type SendErrorFn = (ws: WebSocket, code: string, message: string) => void;

export class SubscriptionRouter {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly maxSubscriptionsPerConnection: number,
    private readonly sendError: SendErrorFn,
    private readonly onSubscriptionLimitExceeded: () => void
  ) {}

  // ── Authorization ────────────────────────────────────────────────────────

  /**
   * Authorize a subscription filter for a connection.
   *
   * Stream-scoped filters require an authenticated subject that is the
   * stream's sender or recipient. Recipient-scoped filters must match the
   * authenticated Stellar public key exactly, and an empty filter is narrowed
   * to the authenticated recipient.
   */
  async authorize(
    ws: WebSocket,
    filter: SubscriptionFilter
  ): Promise<SubscriptionAuthorization> {
    const state = this.registry.get(ws);
    if (!state) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'WebSocket client is not registered' };
    }

    if (filter.streamId !== undefined) {
      const stream = await streamRepository.getById(filter.streamId);
      if (!stream) {
        return { ok: false, code: 'NOT_FOUND', message: 'Stream not found' };
      }

      const subject = state.authenticatedSubject;
      if (!subject || (stream.sender_address !== subject && stream.recipient_address !== subject)) {
        return { ok: false, code: 'FORBIDDEN', message: 'Not authorized for this stream' };
      }

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

  private authenticatedRecipientSubject(state: ClientState): string | undefined {
    const subject = state.authenticatedSubject;
    if (subject === undefined || !isValidStellarPublicKey(subject)) return undefined;
    return subject;
  }

  // ── Subscription lifecycle ───────────────────────────────────────────────

  /**
   * Add a filter to a connection, enforcing the per-connection subscription
   * cap. A repeated subscribe for the same filter is a no-op; exceeding the cap
   * reports the limit and leaves the connection's filters untouched.
   */
  subscribe(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.registry.get(ws);
    if (!state) return;

    if (state.subscriptionFilters.has(subscriptionKey(filter))) return;
    if (state.subscriptionFilters.size >= this.maxSubscriptionsPerConnection) {
      this.onSubscriptionLimitExceeded();
      this.sendError(
        ws,
        'SUBSCRIPTION_LIMIT_EXCEEDED',
        `Connection is limited to ${this.maxSubscriptionsPerConnection} subscriptions`
      );
      return;
    }

    this.registry.addSubscription(ws, filter);
  }

  /** Remove a filter previously added for this connection. */
  unsubscribe(ws: WebSocket, filter: SubscriptionFilter): void {
    const state = this.registry.get(ws);
    if (!state) return;

    if (!state.subscriptionFilters.has(subscriptionKey(filter))) return;

    this.registry.removeSubscription(ws, filter);
  }

  /**
   * Apply a subscription filter supplied in the upgrade request's query
   * string, if any.
   *
   * Authorization is asynchronous, so the filter is applied once it resolves;
   * a failure or a throw is reported to the client as a protocol error.
   */
  applyHandshakeSubscription(ws: WebSocket, req: IncomingMessage): void {
    const result = parseHandshakeSubscriptionFilter(req.url ?? '/');
    if (!result.ok) {
      this.sendError(ws, 'INVALID_MESSAGE', result.message);
      return;
    }

    if (result.filter === null) return;

    this.authorize(ws, result.filter)
      .then((authorized) => {
        if (!authorized.ok) {
          this.sendError(ws, authorized.code, authorized.message);
          return;
        }
        this.subscribe(ws, authorized.filter);
      })
      .catch(() => {
        // Just send a generic error if the authorization check throws
        this.sendError(ws, 'INTERNAL_ERROR', 'Failed to authorize subscription filter');
      });
  }

  // ── Fanout target resolution ─────────────────────────────────────────────

  /**
   * Resolve the subscribers of an event and split them by batching preference.
   *
   * A client opts in to batching by including `batching: true` in any of its
   * subscription filters; clients that did not opt in keep the unchanged
   * one-frame-per-event path.
   */
  resolveTargets(event: StreamUpdateEvent): FanoutTargets {
    const batched: BatchTarget[] = [];
    const immediate: WebSocket[] = [];

    for (const ws of this.matchingSubscribers(event)) {
      const state = this.registry.get(ws);
      if (!state) continue;

      let wantsBatching = false;
      for (const filter of state.subscriptionFilters.values()) {
        if (filter.batchingEnabled) {
          wantsBatching = true;
          break;
        }
      }

      if (wantsBatching) {
        batched.push({ ws, state });
      } else {
        immediate.push(ws);
      }
    }

    return { batched, immediate };
  }

  /** Union of the stream-scoped and recipient-scoped subscriber sets. */
  private matchingSubscribers(event: StreamUpdateEvent): Set<WebSocket> {
    const targets = new Set<WebSocket>(this.registry.streamSubscribers(event.streamId));

    const recipientAddress = extractRecipientAddress(event);
    if (recipientAddress !== undefined) {
      for (const ws of this.registry.recipientSubscribers(recipientAddress)) {
        targets.add(ws);
      }
    }

    return targets;
  }
}

/**
 * Resolve the recipient an event targets.
 *
 * Prefers the explicit `recipientAddress` field and otherwise accepts the
 * three spellings the indexer emits in the payload.
 */
export function extractRecipientAddress(event: StreamUpdateEvent): string | undefined {
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
