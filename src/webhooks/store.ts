/**
 * @module webhooks/store
 *
 * ## Two webhook storage subsystems — relationship and rationale
 *
 * This codebase contains **two distinct webhook-related storage paths**:
 *
 * ### 1. `WebhookDeliveryStore` (this file)
 *
 * Backs the *management/inspection HTTP routes* in `src/routes/webhooks.ts`:
 * - `GET /internal/webhooks/deliveries` — delivery tracking records
 * - `GET /internal/webhooks/outbox`     — outbound items queued via `/queue`
 * - `GET /internal/webhooks/dlq`        — dead-letter queue for failed deliveries
 * - `POST /internal/webhooks/queue`     — enqueue a new delivery for HTTP push
 *
 * The **default implementation** (`WebhookDeliveryStore`) is fully in-memory
 * and is intentionally kept for **development / test environments** where
 * zero infrastructure dependencies is more valuable than durability.
 *
 * In production, set `WEBHOOK_DELIVERY_STORE=postgres` to activate
 * `PgWebhookDeliveryStore` (see `src/webhooks/pgStore.ts`), which persists
 * outbox items and DLQ entries in Postgres so they survive restarts and are
 * visible across all replicas.  A startup warning is emitted when the
 * process boots with `NODE_ENV=production` and this flag is absent or set to
 * `"memory"`.
 *
 * ### 2. `WebhookDispatcher` / `webhook_outbox` Postgres table
 *
 * Lives in `src/webhooks/service.ts` (`WebhookDispatcher` class) and is a
 * completely separate subsystem.  It implements a transactional outbox pattern
 * for **stream-event fanout**: when a stream event is written to Postgres, a
 * corresponding row is inserted into `webhook_outbox` in the *same
 * transaction*.  The dispatcher polls that table and pushes the events to
 * registered consumer endpoints via HTTPS.
 *
 * This path is durable by design — it was the DB-backed outbox all along.
 * `WebhookDeliveryStore` is *not* a replacement for it; it handles a
 * different, higher-level concern (delivery status tracking and the operator
 * DLQ/inspection surface).
 *
 * ### Summary
 *
 * | Path                   | Backed by               | Durable? | Purpose                          |
 * |------------------------|-------------------------|----------|----------------------------------|
 * | `WebhookDeliveryStore` | In-memory Maps (default)| ❌ / ✅*  | Mgmt routes: track, DLQ, queue   |
 * | `PgWebhookDeliveryStore`| Postgres tables        | ✅        | Same, but durable across restarts|
 * | `WebhookDispatcher`    | `webhook_outbox` table  | ✅        | Stream-event fanout via Postgres  |
 *
 * *Set `WEBHOOK_DELIVERY_STORE=postgres` to switch to the durable path.
 *
 * ### Idempotency and Crash Recovery (The Send/Ack Window)
 *
 * Both outbox implementations (management routes and stream dispatcher) are 
 * subject to a "send/ack crash window". If the process crashes after sending the 
 * HTTP network request but before committing the acknowledgement to the database:
 * 
 * 1. **Delivery Identity**: The `x-fluxora-delivery-id` header (and the `deliveryId` field) 
 *    serves as the primary idempotency key.
 * 2. **Receiver Deduplication**: Receivers *must* deduplicate based on this identity. 
 *    Duplicate sends are an expected byproduct of at-least-once delivery guarantees.
 * 3. **Retryability**: 
 *    - In `WebhookDeliveryStore` / `PgWebhookDeliveryStore`: an in-flight row becomes 
 *      retryable when its lock expires (`lockedAt + lockTimeoutMs < now`).
 *    - In `WebhookDispatcher`: an outbox row becomes retryable immediately upon 
 *      transaction rollback (the `FOR UPDATE SKIP LOCKED` is released).
 * 4. **Signature Reuse Policy**: A crashed attempt is not recorded. The subsequent 
 *    retry will be treated as the same attempt number as the crashed one, but will 
 *    feature a *fresh* timestamp and a newly computed signature. Signatures are 
 *    never cached or reused across attempts.
 */

import type { WebhookDelivery, WebhookDeliveryStatus, DLQReasonCode } from './types.js';
import { logger } from '../lib/logger.js';

export interface DeadLetterQueueItem {
  id: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  endpointUrl: string;
  payload: string;
  originalDelivery: WebhookDelivery;
  failureReason: string;
  reasonCode: DLQReasonCode;
  createdAt: number;
  processedAt?: number;
}

export type OutboxItemStatus = 'pending' | 'in_flight' | 'delivered' | 'failed';

export interface ClaimOptions {
  workerId?: string;
  lockTimeoutMs?: number;
  now?: number;
}

export interface OutboxItem {
  id: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  endpointUrl: string;
  payload: string;
  secret: string;
  priority: 'high' | 'normal' | 'low';
  createdAt: number;
  scheduledFor: number;
  attempts: number;
  maxAttempts: number;
  /** Defaults to `'pending'` when not provided to `addToOutbox`. */
  status?: OutboxItemStatus;
  lockedAt?: number;
  lockedBy?: string;
}

export const DEFAULT_CLAIM_LOCK_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// IWebhookDeliveryStore — shared interface implemented by both the in-memory
// store (development) and the Postgres-backed store (production).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contract for webhook delivery storage.  Both `WebhookDeliveryStore`
 * (in-memory) and `PgWebhookDeliveryStore` (Postgres) implement this
 * interface, allowing callers (service.ts, routes/webhooks.ts) to be
 * storage-agnostic.
 */
export interface IWebhookDeliveryStore {
  store(delivery: WebhookDelivery): void;
  get(id: string): WebhookDelivery | undefined;
  getByDeliveryId(deliveryId: string): WebhookDelivery | undefined;
  updateStatus(id: string, status: WebhookDeliveryStatus): void;
  addToOutbox(item: Omit<OutboxItem, 'id' | 'status'>): string;
  getReadyOutboxItems(now?: number): OutboxItem[];
  removeFromOutbox(id: string): boolean;
  updateOutboxItemAttempt(id: string, attempts: number): void;
  claimReadyOutboxItems(opts?: ClaimOptions): OutboxItem[];
  reclaimStuckItems(opts?: ClaimOptions): OutboxItem[];
  releaseOutboxItem(id: string, workerId: string): boolean;
  markOutboxItemDelivered(id: string, workerId: string): boolean;
  addToDeadLetterQueue(delivery: WebhookDelivery, failureReason: string, reasonCode?: DLQReasonCode): string;
  getDeadLetterQueueItems(limit?: number): DeadLetterQueueItem[];
  processDeadLetterQueueItem(id: string, processedAt?: number): boolean;
  getPendingRetries(now?: number): WebhookDelivery[];
  getByEventId(eventId: string): WebhookDelivery[];
  registerDeliveryId(deliveryId: string): void;
  isDuplicateDelivery(deliveryId: string): boolean;
  getMetrics(): { totalDeliveries: number; successfulDeliveries: number; failedDeliveries: number; dlqItems: number; outboxItems: number };
  cleanup(olderThanMs?: number): { cleaned: number; errors: string[] };
  clear(): void;
  getAll(): WebhookDelivery[];
  getAllOutboxItems(): OutboxItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation (development / test default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory implementation of `IWebhookDeliveryStore`.
 *
 * Suitable for **development and testing** where infrastructure dependencies
 * should be minimal.  All state is lost on process restart.
 *
 * **Do not use in production** — set `WEBHOOK_DELIVERY_STORE=postgres` to
 * activate the durable Postgres-backed implementation instead.  A startup
 * warning is logged automatically when this implementation is active in a
 * production environment.
 */
export class WebhookDeliveryStore implements IWebhookDeliveryStore {
  // Main delivery storage
  private deliveries: Map<string, WebhookDelivery> = new Map();
  private deliveryIdIndex: Map<string, string> = new Map();

  // Outbox pattern for reliable delivery
  private outbox: Map<string, OutboxItem> = new Map();
  private outboxPriorityQueue: Map<string, OutboxItem[]> = new Map();

  // Dead-letter queue for failed deliveries
  private deadLetterQueue: Map<string, DeadLetterQueueItem> = new Map();

  // Metrics
  private metrics = {
    totalDeliveries: 0,
    successfulDeliveries: 0,
    failedDeliveries: 0,
    dlqItems: 0,
    outboxItems: 0,
  };

  /**
   * Store a webhook delivery record
   */
  store(delivery: WebhookDelivery): void {
    this.deliveries.set(delivery.id, delivery);
    this.deliveryIdIndex.set(delivery.deliveryId, delivery.id);
    this.metrics.totalDeliveries++;

    logger.debug('Webhook delivery stored', undefined, {
      deliveryId: delivery.deliveryId,
      status: delivery.status,
    });
  }

  /**
   * Get a delivery by its ID
   */
  get(id: string): WebhookDelivery | undefined {
    return this.deliveries.get(id);
  }

  /**
   * Get a delivery by its deliveryId (for deduplication)
   */
  getByDeliveryId(deliveryId: string): WebhookDelivery | undefined {
    const id = this.deliveryIdIndex.get(deliveryId);
    return id ? this.deliveries.get(id) : undefined;
  }

  /**
   * Update delivery status and track metrics
   */
  updateStatus(id: string, status: WebhookDeliveryStatus): void {
    const delivery = this.deliveries.get(id);
    if (delivery) {
      const oldStatus = delivery.status;
      delivery.status = status;
      delivery.updatedAt = Date.now();

      // Update metrics
      if (oldStatus !== 'delivered' && status === 'delivered') {
        this.metrics.successfulDeliveries++;
      } else if (oldStatus !== 'permanent_failure' && status === 'permanent_failure') {
        this.metrics.failedDeliveries++;
      }

      logger.debug('Webhook delivery status updated', undefined, {
        deliveryId: delivery.deliveryId,
        oldStatus,
        newStatus: status,
      });
    }
  }

  /**
   * Add item to outbox for reliable delivery
   */
  addToOutbox(item: Omit<OutboxItem, 'id' | 'status'>): string {
    const id = `outbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const outboxItem: OutboxItem = { ...item, id, status: 'pending' };

    this.outbox.set(id, outboxItem);

    // Add to priority queue
    const priority = outboxItem.priority;
    if (!this.outboxPriorityQueue.has(priority)) {
      this.outboxPriorityQueue.set(priority, []);
    }
    this.outboxPriorityQueue.get(priority)!.push(outboxItem);

    this.metrics.outboxItems++;

    logger.info('Item added to webhook outbox', undefined, {
      outboxId: id,
      deliveryId: item.deliveryId,
      priority,
      scheduledFor: new Date(item.scheduledFor).toISOString(),
    });

    return id;
  }

  /**
   * Hydrate a full outbox item (with pre-existing id and status) into the
   * in-memory mirror.  Used by `PgWebhookDeliveryStore.hydrate()` to
   * restore persisted rows on startup.
   *
   * This method intentionally accepts the complete `OutboxItem` including
   * `id` and `status` — it is **not** a general-purpose enqueue and
   * should only be called during hydration.
   */
  hydrateOutboxItem(item: OutboxItem): string {
    this.outbox.set(item.id, item);

    const priority = item.priority;
    if (!this.outboxPriorityQueue.has(priority)) {
      this.outboxPriorityQueue.set(priority, []);
    }
    this.outboxPriorityQueue.get(priority)!.push(item);

    this.metrics.outboxItems++;

    return item.id;
  }

  /**
   * Get items from outbox that are ready for processing (pending status only).
   * Items claimed by a worker (in_flight) are excluded.
   */
  getReadyOutboxItems(now: number = Date.now()): OutboxItem[] {
    const readyItems: OutboxItem[] = [];

    // Process by priority: high -> normal -> low
    const priorities = ['high', 'normal', 'low'];

    for (const priority of priorities) {
      const items = this.outboxPriorityQueue.get(priority) || [];
      const ready = items
        .filter((item) =>
          item.status === 'pending' &&
          item.scheduledFor <= now &&
          item.attempts < item.maxAttempts
        )
        .sort((a, b) => a.scheduledFor - b.scheduledFor);
      readyItems.push(...ready);
    }

    return readyItems;
  }

  /**
   * Remove item from outbox
   */
  removeFromOutbox(id: string): boolean {
    const item = this.outbox.get(id);
    if (!item) return false;

    this.outbox.delete(id);

    // Remove from priority queue
    const priorityItems = this.outboxPriorityQueue.get(item.priority);
    if (priorityItems) {
      const index = priorityItems.findIndex((i) => i.id === id);
      if (index !== -1) {
        priorityItems.splice(index, 1);
      }
    }

    this.metrics.outboxItems--;
    return true;
  }

  /**
   * Update outbox item attempt count
   */
  updateOutboxItemAttempt(id: string, attempts: number): void {
    const item = this.outbox.get(id);
    if (item) {
      item.attempts = attempts;
    }
  }

  /**
   * Atomically claim ready outbox items for a specific worker.
   *
   * Finds items with `status = 'pending'` that are due (scheduledFor ≤ now
   * and attempts < maxAttempts), then marks them `in_flight` with the
   * given `workerId` and a `lockedAt` timestamp.  Multiple workers calling
   * this method on the same store will never both claim the same row
   * because the `pending` → `in_flight` transition is synchronous — once
   * the first caller mutates the status, subsequent callers skip the row.
   *
   * @returns  The list of items successfully claimed by this worker.
   */
  claimReadyOutboxItems(opts: ClaimOptions = { workerId: 'default-worker' }): OutboxItem[] {
    const workerId = opts.workerId ?? 'default-worker';
    const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_CLAIM_LOCK_TIMEOUT_MS;
    const now = opts.now ?? Date.now();

    const reclaimWindow = now - lockTimeoutMs;
    const claimed: OutboxItem[] = [];

    const priorities: ('high' | 'normal' | 'low')[] = ['high', 'normal', 'low'];

    for (const priority of priorities) {
      const items = this.outboxPriorityQueue.get(priority) || [];
      for (const item of items) {
        if (item.attempts >= item.maxAttempts) continue;

        // Claim eligible items: pending or stuck in_flight with expired lock
        const isPending = item.status === 'pending' && item.scheduledFor <= now;
        const isStuck = item.status === 'in_flight' &&
          item.lockedAt != null &&
          item.lockedAt < reclaimWindow;

        if (!isPending && !isStuck) continue;

        item.status = 'in_flight';
        item.lockedAt = now;
        item.lockedBy = workerId;
        claimed.push(item);
      }
    }

    return claimed;
  }

  /**
   * Reclaim stuck in-flight items whose lock has expired.
   *
   * Finds items with `status = 'in_flight'` where
   * `lockedAt + lockTimeoutMs < now` and reassigns the lock to the
   * requesting worker.  This is a subset of what {@link claimReadyOutboxItems}
   * does (which also handles `pending` items), but is exposed as a
   * separate method for observability and targeted use cases.
   */
  reclaimStuckItems(opts: ClaimOptions = { workerId: 'default-worker' }): OutboxItem[] {
    const workerId = opts.workerId ?? 'default-worker';
    const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_CLAIM_LOCK_TIMEOUT_MS;
    const now = opts.now ?? Date.now();

    const reclaimWindow = now - lockTimeoutMs;
    const reclaimed: OutboxItem[] = [];

    for (const item of this.outbox.values()) {
      if (
        item.status === 'in_flight' &&
        item.lockedAt != null &&
        item.lockedAt < reclaimWindow
      ) {
        item.status = 'in_flight';
        item.lockedAt = now;
        item.lockedBy = workerId;
        reclaimed.push(item);
      }
    }

    return reclaimed;
  }

  /**
   * Release a claimed outbox item so it can be claimed by another worker.
   *
   * Only the worker that currently holds the lock can release it (verified
   * via `lockedBy`).  Resets status to `pending` and clears lock fields.
   *
   * @returns `true` if the item was released, `false` if not found or
   *          the caller does not hold the lock.
   */
  releaseOutboxItem(id: string, workerId: string): boolean {
    const item = this.outbox.get(id);
    if (!item) return false;
    if (item.lockedBy !== workerId) return false;

    item.status = 'pending';
    item.lockedAt = undefined;
    item.lockedBy = undefined;
    return true;
  }

  /**
   * Mark a claimed outbox item as delivered and remove it from the queue.
   *
   * Only the locking worker may mark the item as delivered.
   *
   * @returns `true` if the item was delivered, `false` if not found or
   *          the caller does not hold the lock.
   */
  markOutboxItemDelivered(id: string, workerId: string): boolean {
    const item = this.outbox.get(id);
    if (!item) return false;
    if (item.lockedBy !== workerId) return false;

    item.status = 'delivered';
    item.lockedAt = undefined;
    item.lockedBy = undefined;

    // Remove from outbox Map
    this.outbox.delete(id);

    // Remove from priority queue so it won't appear in future queries
    const priorityItems = this.outboxPriorityQueue.get(item.priority);
    if (priorityItems) {
      const index = priorityItems.findIndex((i) => i.id === id);
      if (index !== -1) {
        priorityItems.splice(index, 1);
      }
    }

    this.metrics.outboxItems--;
    return true;
  }

  /**
   * Add failed delivery to dead-letter queue
   */
  addToDeadLetterQueue(
    delivery: WebhookDelivery,
    failureReason: string,
    reasonCode: DLQReasonCode = 'other'
  ): string {
    const id = `dlq_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const dlqItem: DeadLetterQueueItem = {
      id,
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      endpointUrl: delivery.endpointUrl,
      payload: delivery.payload,
      originalDelivery: delivery,
      failureReason,
      reasonCode,
      createdAt: Date.now(),
    };

    this.deadLetterQueue.set(id, dlqItem);
    this.metrics.dlqItems++;

    logger.error('Webhook delivery moved to dead-letter queue', undefined, {
      dlqId: id,
      deliveryId: delivery.deliveryId,
      failureReason,
      reasonCode,
      attemptCount: delivery.attempts.length,
    });

    return id;
  }

  /**
   * Get items from dead-letter queue
   */
  getDeadLetterQueueItems(limit?: number): DeadLetterQueueItem[] {
    const items = Array.from(this.deadLetterQueue.values());
    return limit ? items.slice(0, limit) : items;
  }

  /**
   * Process dead-letter queue item (retry or manual handling)
   */
  processDeadLetterQueueItem(id: string, processedAt: number = Date.now()): boolean {
    const item = this.deadLetterQueue.get(id);
    if (!item) return false;

    item.processedAt = processedAt;
    this.deadLetterQueue.delete(id);
    this.metrics.dlqItems--;

    logger.info('Dead-letter queue item processed', undefined, {
      dlqId: id,
      deliveryId: item.deliveryId,
      processedAt: new Date(processedAt).toISOString(),
    });

    return true;
  }

  /**
   * Get all pending deliveries that are ready for retry.
   * Circuit-breaker gating is applied by {@link WebhookService.processPendingRetries}.
   */
  getPendingRetries(now: number = Date.now()): WebhookDelivery[] {
    const retries: WebhookDelivery[] = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.status === 'pending') {
        const lastAttempt = delivery.attempts[delivery.attempts.length - 1];
        if (lastAttempt?.nextRetryAt && lastAttempt.nextRetryAt <= now) {
          retries.push(delivery);
        }
      }
    }
    return retries;
  }

  /**
   * Get all deliveries for an event
   */
  getByEventId(eventId: string): WebhookDelivery[] {
    const results: WebhookDelivery[] = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.eventId === eventId) {
        results.push(delivery);
      }
    }
    return results;
  }

  /**
   * Register a delivery ID for deduplication without a full delivery record.
   * Used by the /receive endpoint for inbound webhook verification.
   */
  registerDeliveryId(deliveryId: string): void {
    this.deliveryIdIndex.set(deliveryId, deliveryId);
  }

  /**
   * Check if a delivery ID has been seen before (for deduplication)
   */
  isDuplicateDelivery(deliveryId: string): boolean {
    return this.deliveryIdIndex.has(deliveryId);
  }

  /**
   * Get store metrics
   */
  getMetrics(): {
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    dlqItems: number;
    outboxItems: number;
  } {
    return { ...this.metrics };
  }

  /**
   * Clean up old data (for maintenance)
   */
  cleanup(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): { cleaned: number; errors: string[] } {
    const now = Date.now();
    const cutoff = now - olderThanMs;
    let cleaned = 0;
    const errors: string[] = [];

    try {
      // Clean up old successful deliveries
      for (const [id, delivery] of this.deliveries.entries()) {
        if (delivery.status === 'delivered' && delivery.updatedAt < cutoff) {
          this.deliveries.delete(id);
          this.deliveryIdIndex.delete(delivery.deliveryId);
          cleaned++;
        }
      }

      // Clean up old DLQ items
      for (const [id, item] of this.deadLetterQueue.entries()) {
        if (item.createdAt < cutoff) {
          this.deadLetterQueue.delete(id);
          cleaned++;
        }
      }

      logger.info('Webhook store cleanup completed', undefined, { cleaned, olderThanMs });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return { cleaned, errors };
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.deliveries.clear();
    this.deliveryIdIndex.clear();
    this.outbox.clear();
    this.outboxPriorityQueue.clear();
    this.deadLetterQueue.clear();

    this.metrics = {
      totalDeliveries: 0,
      successfulDeliveries: 0,
      failedDeliveries: 0,
      dlqItems: 0,
      outboxItems: 0,
    };
  }

  /**
   * Get all deliveries (for testing/monitoring)
   */
  getAll(): WebhookDelivery[] {
    return Array.from(this.deliveries.values());
  }

  /**
   * Get all outbox items (for testing/monitoring)
   */
  getAllOutboxItems(): OutboxItem[] {
    return Array.from(this.outbox.values());
  }
}
