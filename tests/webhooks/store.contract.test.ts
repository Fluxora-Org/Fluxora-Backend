/**
 * Shared `IWebhookDeliveryStore` contract test.
 *
 * This is the *single* contract suite for the two webhook delivery store
 * implementations behind `src/webhooks/storeFactory.ts`:
 *
 *   - `WebhookDeliveryStore`     — in-memory (development / test default)
 *   - `PgWebhookDeliveryStore`   — Postgres write-through (production)
 *
 * The suite is parameterised over both implementations, so every assertion runs
 * against each store. `runObservableScenario()` additionally drives an identical
 * sequence of operations through both stores and asserts their observable
 * results are deeply equal — the regression guard for "switching stores does not
 * change observable behaviour".
 *
 * The Postgres-backed store is constructed with a mock pool: its durable reads
 * are served from an in-memory mirror, so the observable behaviour exercised
 * here is pool-independent and runs without a live database.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WebhookDeliveryStore,
  type IWebhookDeliveryStore,
  type OutboxItem,
  type DeadLetterQueueItem,
} from '../../src/webhooks/store.js';
import { PgWebhookDeliveryStore } from '../../src/webhooks/pgStore.js';
import type { WebhookDelivery } from '../../src/webhooks/types.js';

const FIXED_NOW = 1_700_000_000_000;

/** A pool whose write-through queries resolve without a live database. */
function makePool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as import('pg').Pool;
}

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'd1',
    deliveryId: 'deliv1',
    eventId: 'evt1',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/hook',
    status: 'pending',
    attempts: [],
    createdAt: FIXED_NOW - 10_000,
    updatedAt: FIXED_NOW - 10_000,
    payload: '{"contract":true}',
    ...overrides,
  };
}

function makeOutboxItem(
  overrides: Partial<Omit<OutboxItem, 'id' | 'status'>> = {}
): Omit<OutboxItem, 'id' | 'status'> {
  return {
    deliveryId: 'deliv1',
    eventId: 'evt1',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/hook',
    payload: '{"outbox":true}',
    secret: 'secret-abc',
    priority: 'normal',
    createdAt: FIXED_NOW,
    scheduledFor: FIXED_NOW - 1000,
    attempts: 0,
    maxAttempts: 5,
    ...overrides,
  };
}

/** Stable projection of an outbox item — drops the randomly generated id. */
function normalizeOutboxItem(item: OutboxItem) {
  return {
    deliveryId: item.deliveryId,
    eventId: item.eventId,
    eventType: item.eventType,
    priority: item.priority,
    scheduledFor: item.scheduledFor,
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    status: item.status,
    lockedBy: item.lockedBy,
  };
}

/** Stable projection of a DLQ item — drops the randomly generated id and the
 * internally-generated `createdAt`, which is not deterministic across runs. */
function normalizeDlqItem(item: DeadLetterQueueItem) {
  return {
    deliveryId: item.deliveryId,
    eventId: item.eventId,
    eventType: item.eventType,
    failureReason: item.failureReason,
    reasonCode: item.reasonCode,
  };
}

/**
 * Drive an identical, deterministic sequence through a store and return a
 * normalised snapshot of everything observable. Timestamps that the store
 * generates internally (`updateStatus` refreshes `updatedAt`) are excluded so
 * the snapshot is stable across runs.
 */
function runObservableScenario(store: IWebhookDeliveryStore) {
  const now = FIXED_NOW;

  const ready = makeDelivery({
    id: 'd1',
    deliveryId: 'deliv1',
    eventId: 'evt1',
    status: 'pending',
    attempts: [
      { attemptNumber: 1, timestamp: now - 5000, statusCode: 503, nextRetryAt: now - 1000 },
    ],
  });
  const delivered = makeDelivery({ id: 'd2', deliveryId: 'deliv2', eventId: 'evt1', status: 'delivered' });
  const later = makeDelivery({
    id: 'd3',
    deliveryId: 'deliv3',
    eventId: 'evt2',
    status: 'pending',
    attempts: [
      { attemptNumber: 1, timestamp: now - 5000, statusCode: 503, nextRetryAt: now + 60_000 },
    ],
  });

  store.store(ready);
  store.store(delivered);
  store.store(later);
  store.updateStatus('d2', 'permanent_failure');

  store.addToDeadLetterQueue(ready, 'exhausted retries', 'exhausted');

  store.addToOutbox(makeOutboxItem({ deliveryId: 'deliv1', priority: 'high', scheduledFor: now - 2000 }));
  store.addToOutbox(makeOutboxItem({ deliveryId: 'deliv2', priority: 'normal', scheduledFor: now - 1000 }));
  store.addToOutbox(makeOutboxItem({ deliveryId: 'deliv3', priority: 'normal', scheduledFor: now + 60_000 }));

  // Claim the two due items (high priority first), release one, deliver the other.
  const claimed = store.claimReadyOutboxItems({ workerId: 'w1', now, lockTimeoutMs: 30_000 });
  store.releaseOutboxItem(claimed[0].id, 'w1');
  store.markOutboxItemDelivered(claimed[1].id, 'w1');

  const snapshot = {
    deliveries: store
      .getAll()
      .map((d) => ({ id: d.id, deliveryId: d.deliveryId, eventId: d.eventId, status: d.status })),
    byDeliveryId: store.getByDeliveryId('deliv2')?.id,
    byDeliveryIdMissing: store.getByDeliveryId('nope') ?? null,
    byEventId: store.getByEventId('evt1').map((d) => d.id),
    pendingRetries: store.getPendingRetries(now).map((d) => d.id),
    duplicateKnown: store.isDuplicateDelivery('deliv1'),
    duplicateUnknown: store.isDuplicateDelivery('never-seen'),
    outbox: store.getAllOutboxItems().map(normalizeOutboxItem),
    readyOutbox: store.getReadyOutboxItems(now).map(normalizeOutboxItem),
    dlq: store.getDeadLetterQueueItems().map(normalizeDlqItem),
    metrics: store.getMetrics(),
    cleanup: store.cleanup(),
  };

  store.clear();

  return {
    ...snapshot,
    afterClear: {
      deliveries: store.getAll().length,
      outbox: store.getAllOutboxItems().length,
      dlq: store.getDeadLetterQueueItems().length,
    },
  };
}

const implementations: Array<{ name: string; makeStore: () => IWebhookDeliveryStore }> = [
  { name: 'WebhookDeliveryStore (in-memory)', makeStore: () => new WebhookDeliveryStore() },
  { name: 'PgWebhookDeliveryStore (Postgres-backed)', makeStore: () => new PgWebhookDeliveryStore(makePool()) },
];

describe.each(implementations)(
  '$name satisfies the shared IWebhookDeliveryStore contract',
  ({ makeStore }) => {
    it('round-trips delivery records and status updates', () => {
      const store = makeStore();
      const delivery = makeDelivery();
      store.store(delivery);

      expect(store.get(delivery.id)).toMatchObject({ id: delivery.id, deliveryId: delivery.deliveryId });
      expect(store.getByDeliveryId(delivery.deliveryId)).toMatchObject({ id: delivery.id });

      store.updateStatus(delivery.id, 'delivered');
      expect(store.get(delivery.id)?.status).toBe('delivered');
    });

    it('returns undefined for unknown delivery ids', () => {
      const store = makeStore();
      expect(store.get('missing')).toBeUndefined();
      expect(store.getByDeliveryId('missing')).toBeUndefined();
    });

    it('detects duplicate delivery ids', () => {
      const store = makeStore();
      const delivery = makeDelivery();
      expect(store.isDuplicateDelivery(delivery.deliveryId)).toBe(false);
      store.store(delivery);
      expect(store.isDuplicateDelivery(delivery.deliveryId)).toBe(true);
    });

    it('enqueues outbox items as pending with generated ids', () => {
      const store = makeStore();
      const id = store.addToOutbox(makeOutboxItem());
      expect(id).toMatch(/^outbox_/);

      const items = store.getAllOutboxItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id, status: 'pending', deliveryId: 'deliv1' });
    });

    it('claims outbox items exclusively and honours lock ownership', () => {
      const store = makeStore();
      store.addToOutbox(makeOutboxItem({ scheduledFor: FIXED_NOW - 1000 }));

      const first = store.claimReadyOutboxItems({ workerId: 'worker-a', now: FIXED_NOW, lockTimeoutMs: 30_000 });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ status: 'in_flight', lockedBy: 'worker-a' });

      // A second worker cannot claim the same item.
      const second = store.claimReadyOutboxItems({ workerId: 'worker-b', now: FIXED_NOW, lockTimeoutMs: 30_000 });
      expect(second).toHaveLength(0);

      // Only the locking worker may release or deliver.
      expect(store.releaseOutboxItem(first[0].id, 'worker-b')).toBe(false);
      expect(store.markOutboxItemDelivered(first[0].id, 'worker-b')).toBe(false);
      expect(store.releaseOutboxItem(first[0].id, 'worker-a')).toBe(true);
      expect(store.getAllOutboxItems()[0]).toMatchObject({ status: 'pending' });
    });

    it('reclaims outbox items whose lock has expired', () => {
      const store = makeStore();
      store.addToOutbox(makeOutboxItem({ scheduledFor: FIXED_NOW - 1000 }));

      store.claimReadyOutboxItems({ workerId: 'worker-a', now: FIXED_NOW, lockTimeoutMs: 10_000 });

      const tooSoon = store.claimReadyOutboxItems({ workerId: 'worker-b', now: FIXED_NOW + 5000, lockTimeoutMs: 10_000 });
      expect(tooSoon).toHaveLength(0);

      const afterExpiry = store.claimReadyOutboxItems({
        workerId: 'worker-b',
        now: FIXED_NOW + 10_001,
        lockTimeoutMs: 10_000,
      });
      expect(afterExpiry).toHaveLength(1);
      expect(afterExpiry[0]).toMatchObject({ lockedBy: 'worker-b', status: 'in_flight' });

      const reclaimed = store.reclaimStuckItems({
        workerId: 'worker-c',
        now: FIXED_NOW + 20_002,
        lockTimeoutMs: 10_000,
      });
      expect(reclaimed.map((i) => i.lockedBy)).toEqual(['worker-c']);
    });

    it('moves fully claimed items out of the ready queue when delivered', () => {
      const store = makeStore();
      const id = store.addToOutbox(makeOutboxItem({ scheduledFor: FIXED_NOW - 1000 }));
      store.claimReadyOutboxItems({ workerId: 'worker-a', now: FIXED_NOW });
      expect(store.markOutboxItemDelivered(id, 'worker-a')).toBe(true);
      expect(store.getAllOutboxItems()).toHaveLength(0);
      expect(store.getReadyOutboxItems(FIXED_NOW)).toHaveLength(0);
    });

    it('queues, lists, and processes dead-letter items', () => {
      const store = makeStore();
      const delivery = makeDelivery({ status: 'permanent_failure' });

      const id = store.addToDeadLetterQueue(delivery, 'max attempts exhausted', 'exhausted');
      expect(id).toMatch(/^dlq_/);

      const items = store.getDeadLetterQueueItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id,
        deliveryId: delivery.deliveryId,
        failureReason: 'max attempts exhausted',
        reasonCode: 'exhausted',
      });

      expect(store.processDeadLetterQueueItem(id)).toBe(true);
      expect(store.getDeadLetterQueueItems()).toHaveLength(0);
    });

    it('reports pending retries and deliveries by event id', () => {
      const store = makeStore();
      const retryable = makeDelivery({
        id: 'd1',
        deliveryId: 'deliv1',
        eventId: 'evt1',
        attempts: [{ attemptNumber: 1, timestamp: FIXED_NOW - 5000, nextRetryAt: FIXED_NOW - 1000 }],
      });
      const later = makeDelivery({
        id: 'd2',
        deliveryId: 'deliv2',
        eventId: 'evt1',
        attempts: [{ attemptNumber: 1, timestamp: FIXED_NOW - 5000, nextRetryAt: FIXED_NOW + 60_000 }],
      });

      store.store(retryable);
      store.store(later);

      expect(store.getPendingRetries(FIXED_NOW).map((d) => d.id)).toEqual(['d1']);
      expect(store.getByEventId('evt1').map((d) => d.id)).toEqual(['d1', 'd2']);
    });

    it('exposes metrics with a stable shape', () => {
      const store = makeStore();
      expect(store.getMetrics()).toEqual({
        totalDeliveries: 0,
        successfulDeliveries: 0,
        failedDeliveries: 0,
        dlqItems: 0,
        outboxItems: 0,
      });
    });

    it('cleanup() returns a result object and clear() empties all state', () => {
      const store = makeStore();
      store.store(makeDelivery());
      store.addToOutbox(makeOutboxItem());
      store.addToDeadLetterQueue(makeDelivery({ status: 'permanent_failure' }), 'reason', 'other');

      const result = store.cleanup();
      expect(result).toHaveProperty('cleaned');
      expect(Array.isArray(result.errors)).toBe(true);

      store.clear();
      expect(store.getAll()).toHaveLength(0);
      expect(store.getAllOutboxItems()).toHaveLength(0);
      expect(store.getDeadLetterQueueItems()).toHaveLength(0);
    });
  }
);

describe('switching stores does not change observable behaviour', () => {
  it('produces identical observable snapshots for both implementations', () => {
    const inMemory = runObservableScenario(new WebhookDeliveryStore());
    const postgres = runObservableScenario(new PgWebhookDeliveryStore(makePool()));

    expect(postgres).toEqual(inMemory);
  });
});
