/**
 * @module webhooks/pgStore
 *
 * Postgres-backed implementation of `IWebhookDeliveryStore`.
 *
 * Activated by setting `WEBHOOK_DELIVERY_STORE=postgres` in the environment.
 * See `src/webhooks/store.ts` for the full two-subsystem architecture
 * description and the relationship between this store and the
 * `WebhookDispatcher` / `webhook_outbox` path.
 *
 * ## Tables used
 *
 * | Table                  | Purpose                                          |
 * |------------------------|--------------------------------------------------|
 * | `webhook_deliveries`   | Delivery-status records (tracks attempts, status)|
 * | `webhook_outbox_items` | Outbound delivery queue (management /queue path) |
 * | `webhook_dlq`          | Dead-letter queue for permanently failed items   |
 *
 * These are separate from the `webhook_outbox` table used by
 * `WebhookDispatcher`, which is a transactional stream-event fanout path and
 * serves a different concern.
 *
 * ## Synchronous interface, async storage
 *
 * The `IWebhookDeliveryStore` interface is synchronous (returns plain values,
 * not Promises) to match the existing in-memory implementation and all call
 * sites.  `PgWebhookDeliveryStore` satisfies this contract by:
 *
 * 1. Writing to Postgres *fire-and-forget* with `void promise.catch(log)`.
 * 2. Maintaining a local in-memory mirror so reads are always fast and never
 *    block.  On startup, `hydrate()` loads existing rows from Postgres into
 *    the mirror.
 *
 * This design means that if a write fails (e.g. transient DB error), the
 * mirror still reflects the intended state, and the next cleanup/restart will
 * reconcile.  For the use cases here (operator inspection, DLQ triage) this
 * is an acceptable trade-off.
 */

import type { Pool } from 'pg';
import type { WebhookDelivery, WebhookDeliveryStatus, DLQReasonCode } from './types.js';
import {
  WebhookDeliveryStore,
  type IWebhookDeliveryStore,
  type OutboxItem,
  type ClaimOptions,
  type DeadLetterQueueItem,
} from './store.js';
import { logger } from '../lib/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// PgWebhookDeliveryStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Postgres-backed `IWebhookDeliveryStore`.
 *
 * Uses a write-through strategy: every mutation is applied to the in-memory
 * mirror synchronously (so callers never block), then persisted to Postgres
 * asynchronously.  On process startup, call `hydrate()` to load existing rows
 * from Postgres into the mirror.
 */
export class PgWebhookDeliveryStore implements IWebhookDeliveryStore {
  private readonly mirror: WebhookDeliveryStore;
  private readonly pool: Pool;
  private hydrated = false;

  constructor(pool: Pool) {
    this.pool = pool;
    this.mirror = new WebhookDeliveryStore();
  }

  // ── Hydration ──────────────────────────────────────────────────────────────

  /**
   * Load existing rows from Postgres into the in-memory mirror.
   *
   * Call once at startup (or after a restart) before the store is used.
   * Subsequent calls are no-ops.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;

    try {
      // Load outbox items
      const outboxResult = await this.pool.query<{
        id: string;
        delivery_id: string;
        event_id: string;
        event_type: string;
        endpoint_url: string;
        payload: string;
        secret: string;
        priority: string;
        created_at: Date;
        scheduled_for: Date;
        attempts: number;
        max_attempts: number;
        status: string;
        locked_at: Date | null;
        locked_by: string | null;
      }>(`
        SELECT id, delivery_id, event_id, event_type, endpoint_url, payload,
               secret, priority, created_at, scheduled_for, attempts,
               max_attempts, status, locked_at, locked_by
        FROM webhook_outbox_items
        WHERE status NOT IN ('delivered', 'failed')
        ORDER BY scheduled_for ASC
      `);

      for (const row of outboxResult.rows) {
        // Restore persisted row into mirror's internal state, preserving
        // its original id and status (which may be non-pending).
        this.mirror.hydrateOutboxItem({
          id: row.id,
          deliveryId: row.delivery_id,
          eventId: row.event_id,
          eventType: row.event_type as OutboxItem['eventType'],
          endpointUrl: row.endpoint_url,
          payload: row.payload,
          secret: row.secret,
          priority: row.priority as OutboxItem['priority'],
          createdAt: new Date(row.created_at).getTime(),
          scheduledFor: new Date(row.scheduled_for).getTime(),
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          status: row.status as OutboxItem['status'],
          lockedAt: row.locked_at ? new Date(row.locked_at).getTime() : undefined,
          lockedBy: row.locked_by ?? undefined,
        });
      }

      // Load DLQ items
      const dlqResult = await this.pool.query<{
        id: string;
        delivery_id: string;
        event_id: string;
        event_type: string;
        endpoint_url: string;
        payload: string;
        original_delivery: string;
        failure_reason: string;
        reason_code: string;
        created_at: Date;
        processed_at: Date | null;
      }>(`
        SELECT id, delivery_id, event_id, event_type, endpoint_url, payload,
               original_delivery, failure_reason, reason_code, created_at, processed_at
        FROM webhook_dlq
        WHERE processed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1000
      `);

      for (const row of dlqResult.rows) {
        let originalDelivery: WebhookDelivery;
        try {
          originalDelivery = JSON.parse(row.original_delivery) as WebhookDelivery;
        } catch {
          // Skip rows with corrupt original_delivery JSON
          continue;
        }

        this.mirror.addToDeadLetterQueue(
          originalDelivery,
          row.failure_reason,
          row.reason_code as DLQReasonCode
        );
      }

      this.hydrated = true;
      logger.info('PgWebhookDeliveryStore hydrated from Postgres', undefined, {
        outboxItems: outboxResult.rows.length,
        dlqItems: dlqResult.rows.length,
      });
    } catch (error) {
      logger.error('PgWebhookDeliveryStore hydration failed', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't set hydrated = true; allow retry on next call
      throw error;
    }
  }

  // ── Write-through helpers ──────────────────────────────────────────────────

  private persistAsync(promise: Promise<unknown>, context: string): void {
    promise.catch((error: unknown) => {
      logger.error(`PgWebhookDeliveryStore: failed to persist ${context}`, undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ── IWebhookDeliveryStore — delegating to mirror + persisting ──────────────

  store(delivery: WebhookDelivery): void {
    this.mirror.store(delivery);
    this.persistAsync(
      this.pool.query(
        `INSERT INTO webhook_deliveries
           (id, delivery_id, event_id, event_type, endpoint_url, status,
            attempts, created_at, updated_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, to_timestamp($8 / 1000.0),
                 to_timestamp($9 / 1000.0), $10)
         ON CONFLICT (id) DO UPDATE
           SET status     = EXCLUDED.status,
               attempts   = EXCLUDED.attempts,
               updated_at = EXCLUDED.updated_at`,
        [
          delivery.id,
          delivery.deliveryId,
          delivery.eventId,
          delivery.eventType,
          delivery.endpointUrl,
          delivery.status,
          JSON.stringify(delivery.attempts),
          delivery.createdAt,
          delivery.updatedAt,
          delivery.payload,
        ]
      ),
      'delivery'
    );
  }

  get(id: string): WebhookDelivery | undefined {
    return this.mirror.get(id);
  }

  getByDeliveryId(deliveryId: string): WebhookDelivery | undefined {
    return this.mirror.getByDeliveryId(deliveryId);
  }

  updateStatus(id: string, status: WebhookDeliveryStatus): void {
    this.mirror.updateStatus(id, status);
    this.persistAsync(
      this.pool.query(
        `UPDATE webhook_deliveries SET status = $1, updated_at = NOW() WHERE id = $2`,
        [status, id]
      ),
      'delivery status update'
    );
  }

  addToOutbox(item: Omit<OutboxItem, 'id' | 'status'>): string {
    const id = this.mirror.addToOutbox(item);
    this.persistAsync(
      this.pool.query(
        `INSERT INTO webhook_outbox_items
           (id, delivery_id, event_id, event_type, endpoint_url, payload,
            secret, priority, created_at, scheduled_for, attempts, max_attempts, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0),
                 $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          item.deliveryId,
          item.eventId,
          item.eventType,
          item.endpointUrl,
          item.payload,
          item.secret,
          item.priority,
          item.createdAt,
          item.scheduledFor,
          item.attempts,
          item.maxAttempts,
          'pending',
        ]
      ),
      'outbox insert'
    );
    return id;
  }

  getReadyOutboxItems(now?: number): OutboxItem[] {
    return this.mirror.getReadyOutboxItems(now);
  }

  removeFromOutbox(id: string): boolean {
    const removed = this.mirror.removeFromOutbox(id);
    if (removed) {
      this.persistAsync(
        this.pool.query(
          `UPDATE webhook_outbox_items SET status = 'delivered' WHERE id = $1`,
          [id]
        ),
        'outbox remove'
      );
    }
    return removed;
  }

  updateOutboxItemAttempt(id: string, attempts: number): void {
    this.mirror.updateOutboxItemAttempt(id, attempts);
    this.persistAsync(
      this.pool.query(
        `UPDATE webhook_outbox_items SET attempts = $1 WHERE id = $2`,
        [attempts, id]
      ),
      'outbox attempt update'
    );
  }

  claimReadyOutboxItems(opts?: ClaimOptions): OutboxItem[] {
    const claimed = this.mirror.claimReadyOutboxItems(opts);
    if (claimed.length > 0) {
      const ids = claimed.map((i) => i.id);
      const workerId = opts?.workerId ?? 'default-worker';
      this.persistAsync(
        this.pool.query(
          `UPDATE webhook_outbox_items
           SET status = 'in_flight', locked_by = $1, locked_at = NOW()
           WHERE id = ANY($2::text[])`,
          [workerId, ids]
        ),
        'outbox claim'
      );
    }
    return claimed;
  }

  reclaimStuckItems(opts?: ClaimOptions): OutboxItem[] {
    return this.mirror.reclaimStuckItems(opts);
  }

  releaseOutboxItem(id: string, workerId: string): boolean {
    const released = this.mirror.releaseOutboxItem(id, workerId);
    if (released) {
      this.persistAsync(
        this.pool.query(
          `UPDATE webhook_outbox_items
           SET status = 'pending', locked_by = NULL, locked_at = NULL
           WHERE id = $1`,
          [id]
        ),
        'outbox release'
      );
    }
    return released;
  }

  markOutboxItemDelivered(id: string, workerId: string): boolean {
    const delivered = this.mirror.markOutboxItemDelivered(id, workerId);
    if (delivered) {
      this.persistAsync(
        this.pool.query(
          `UPDATE webhook_outbox_items
           SET status = 'delivered', locked_by = NULL, locked_at = NULL
           WHERE id = $1`,
          [id]
        ),
        'outbox delivered'
      );
    }
    return delivered;
  }

  addToDeadLetterQueue(
    delivery: WebhookDelivery,
    failureReason: string,
    reasonCode: DLQReasonCode = 'other'
  ): string {
    const id = this.mirror.addToDeadLetterQueue(delivery, failureReason, reasonCode);
    this.persistAsync(
      this.pool.query(
        `INSERT INTO webhook_dlq
           (id, delivery_id, event_id, event_type, endpoint_url, payload,
            original_delivery, failure_reason, reason_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          delivery.deliveryId,
          delivery.eventId,
          delivery.eventType,
          delivery.endpointUrl,
          delivery.payload,
          JSON.stringify(delivery),
          failureReason,
          reasonCode,
        ]
      ),
      'dlq insert'
    );
    return id;
  }

  getDeadLetterQueueItems(limit?: number): DeadLetterQueueItem[] {
    return this.mirror.getDeadLetterQueueItems(limit);
  }

  processDeadLetterQueueItem(id: string, processedAt?: number): boolean {
    const processed = this.mirror.processDeadLetterQueueItem(id, processedAt);
    if (processed) {
      this.persistAsync(
        this.pool.query(
          `UPDATE webhook_dlq SET processed_at = NOW() WHERE id = $1`,
          [id]
        ),
        'dlq process'
      );
    }
    return processed;
  }

  getPendingRetries(now?: number): WebhookDelivery[] {
    return this.mirror.getPendingRetries(now);
  }

  getByEventId(eventId: string): WebhookDelivery[] {
    return this.mirror.getByEventId(eventId);
  }

  registerDeliveryId(deliveryId: string): void {
    this.mirror.registerDeliveryId(deliveryId);
  }

  isDuplicateDelivery(deliveryId: string): boolean {
    return this.mirror.isDuplicateDelivery(deliveryId);
  }

  getMetrics(): { totalDeliveries: number; successfulDeliveries: number; failedDeliveries: number; dlqItems: number; outboxItems: number } {
    return this.mirror.getMetrics();
  }

  cleanup(olderThanMs?: number): { cleaned: number; errors: string[] } {
    const result = this.mirror.cleanup(olderThanMs);
    // Also clean up Postgres rows older than the cutoff
    const cutoff = olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
    this.persistAsync(
      this.pool.query(
        `DELETE FROM webhook_deliveries
         WHERE status = 'delivered' AND updated_at < NOW() - ($1 || ' milliseconds')::interval`,
        [cutoff]
      ),
      'delivery cleanup'
    );
    this.persistAsync(
      this.pool.query(
        `DELETE FROM webhook_dlq
         WHERE processed_at IS NOT NULL AND created_at < NOW() - ($1 || ' milliseconds')::interval`,
        [cutoff]
      ),
      'dlq cleanup'
    );
    return result;
  }

  clear(): void {
    this.mirror.clear();
    // Truncate all rows — used in tests only
    this.persistAsync(
      Promise.all([
        this.pool.query('DELETE FROM webhook_deliveries'),
        this.pool.query('DELETE FROM webhook_outbox_items'),
        this.pool.query('DELETE FROM webhook_dlq'),
      ]),
      'clear all'
    );
  }

  getAll(): WebhookDelivery[] {
    return this.mirror.getAll();
  }

  getAllOutboxItems(): OutboxItem[] {
    return this.mirror.getAllOutboxItems();
  }
}
