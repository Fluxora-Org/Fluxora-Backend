import { test, expect } from 'vitest';
import { WebhookDeliveryStore, DEFAULT_CLAIM_LOCK_TIMEOUT_MS, type OutboxItem } from './store.js';
import type { WebhookDelivery } from './types.js';

// Small assert-compat shim — these tests were originally written for
// `node:test` and call `assert.equal` / `assert.deepEqual` / etc.  Map them
// onto vitest's `expect` so we can run under a single test runner.
const assert = {
  equal: (actual: unknown, expected: unknown): void => {
    expect(actual).toEqual(expected);
  },
  notEqual: (actual: unknown, expected: unknown): void => {
    expect(actual).not.toEqual(expected);
  },
  deepEqual: (actual: unknown, expected: unknown): void => {
    expect(actual).toEqual(expected);
  },
  ok: (value: unknown, msg?: string): void => {
    expect(value, msg).toBeTruthy();
  },
  match: (value: string, pattern: RegExp): void => {
    expect(value).toMatch(pattern);
  },
};

function createMockDelivery(overrides?: Partial<WebhookDelivery>): WebhookDelivery {
  return {
    id: 'delivery_123',
    deliveryId: 'deliv_123',
    eventId: 'event_123',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/webhook',
    status: 'pending',
    attempts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: '{"test": true}',
    ...overrides,
  };
}

test('WebhookDeliveryStore: stores and retrieves deliveries', () => {
  const store = new WebhookDeliveryStore();
  const delivery = createMockDelivery();

  store.store(delivery);
  const retrieved = store.get(delivery.id);

  assert.deepEqual(retrieved, delivery);
});

test('WebhookDeliveryStore: retrieves by deliveryId', () => {
  const store = new WebhookDeliveryStore();
  const delivery = createMockDelivery();

  store.store(delivery);
  const retrieved = store.getByDeliveryId(delivery.deliveryId);

  assert.deepEqual(retrieved, delivery);
});

test('WebhookDeliveryStore: returns undefined for missing delivery', () => {
  const store = new WebhookDeliveryStore();

  assert.equal(store.get('nonexistent'), undefined);
  assert.equal(store.getByDeliveryId('nonexistent'), undefined);
});

test('WebhookDeliveryStore: updates delivery status', () => {
  const store = new WebhookDeliveryStore();
  const delivery = createMockDelivery();

  store.store(delivery);
  store.updateStatus(delivery.id, 'delivered');

  const updated = store.get(delivery.id);
  assert.equal(updated?.status, 'delivered');
  assert.ok(updated!.updatedAt >= delivery.updatedAt);
});

test('WebhookDeliveryStore: gets pending retries', () => {
  const store = new WebhookDeliveryStore();
  const now = Date.now();

  const delivery1 = createMockDelivery({
    id: 'delivery_1',
    deliveryId: 'deliv_1',
    status: 'pending',
    attempts: [
      {
        attemptNumber: 1,
        timestamp: now - 5000,
        statusCode: 503,
        nextRetryAt: now - 1000, // Ready for retry
      },
    ],
  });

  const delivery2 = createMockDelivery({
    id: 'delivery_2',
    deliveryId: 'deliv_2',
    status: 'pending',
    attempts: [
      {
        attemptNumber: 1,
        timestamp: now - 5000,
        statusCode: 503,
        nextRetryAt: now + 5000, // Not ready yet
      },
    ],
  });

  const delivery3 = createMockDelivery({
    id: 'delivery_3',
    deliveryId: 'deliv_3',
    status: 'delivered',
    attempts: [
      {
        attemptNumber: 1,
        timestamp: now - 5000,
        statusCode: 200,
      },
    ],
  });

  store.store(delivery1);
  store.store(delivery2);
  store.store(delivery3);

  const retries = store.getPendingRetries(now);

  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.id, 'delivery_1');
});

test('WebhookDeliveryStore: gets deliveries by event ID', () => {
  const store = new WebhookDeliveryStore();

  const delivery1 = createMockDelivery({
    id: 'delivery_1',
    deliveryId: 'deliv_1',
    eventId: 'event_123',
  });

  const delivery2 = createMockDelivery({
    id: 'delivery_2',
    deliveryId: 'deliv_2',
    eventId: 'event_123',
  });

  const delivery3 = createMockDelivery({
    id: 'delivery_3',
    deliveryId: 'deliv_3',
    eventId: 'event_456',
  });

  store.store(delivery1);
  store.store(delivery2);
  store.store(delivery3);

  const byEvent = store.getByEventId('event_123');

  assert.equal(byEvent.length, 2);
  assert.ok(byEvent.some(d => d.id === 'delivery_1'));
  assert.ok(byEvent.some(d => d.id === 'delivery_2'));
});

test('WebhookDeliveryStore: detects duplicate deliveries', () => {
  const store = new WebhookDeliveryStore();
  const delivery = createMockDelivery();

  assert.ok(!store.isDuplicateDelivery(delivery.deliveryId));

  store.store(delivery);

  assert.ok(store.isDuplicateDelivery(delivery.deliveryId));
});

test('WebhookDeliveryStore: clears all deliveries', () => {
  const store = new WebhookDeliveryStore();

  store.store(createMockDelivery({ id: 'delivery_1', deliveryId: 'deliv_1' }));
  store.store(createMockDelivery({ id: 'delivery_2', deliveryId: 'deliv_2' }));

  assert.equal(store.getAll().length, 2);

  store.clear();

  assert.equal(store.getAll().length, 0);
  assert.equal(store.get('delivery_1'), undefined);
});

test('WebhookDeliveryStore: gets all deliveries', () => {
  const store = new WebhookDeliveryStore();

  const delivery1 = createMockDelivery({ id: 'delivery_1', deliveryId: 'deliv_1' });
  const delivery2 = createMockDelivery({ id: 'delivery_2', deliveryId: 'deliv_2' });

  store.store(delivery1);
  store.store(delivery2);

  const all = store.getAll();

  assert.equal(all.length, 2);
  assert.ok(all.some(d => d.id === 'delivery_1'));
  assert.ok(all.some(d => d.id === 'delivery_2'));
});

test('WebhookDeliveryStore: getReadyOutboxItems orders by scheduledFor, ledger, eventId', () => {
  const store = new WebhookDeliveryStore();
  const now = Date.now();

  store.addToOutbox({
    deliveryId: 'deliv_1',
    eventId: 'event_C',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com',
    payload: JSON.stringify({ ledger: 100 }),
    secret: 'sec',
    priority: 'normal',
    createdAt: now,
    scheduledFor: now - 1000,
    attempts: 0,
    maxAttempts: 3,
  });

  store.addToOutbox({
    deliveryId: 'deliv_2',
    eventId: 'event_A',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com',
    payload: JSON.stringify({ data: { ledger: 100 } }),
    secret: 'sec',
    priority: 'normal',
    createdAt: now,
    scheduledFor: now - 1000,
    attempts: 0,
    maxAttempts: 3,
  });

  store.addToOutbox({
    deliveryId: 'deliv_3',
    eventId: 'event_B',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com',
    payload: JSON.stringify({ ledger: 50 }),
    secret: 'sec',
    priority: 'normal',
    createdAt: now,
    scheduledFor: now - 1000,
    attempts: 0,
    maxAttempts: 3,
  });

  store.addToOutbox({
    deliveryId: 'deliv_4',
    eventId: 'event_Z',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com',
    payload: '{}',
    secret: 'sec',
    priority: 'normal',
    createdAt: now,
    scheduledFor: now - 2000, // Should be first
    attempts: 0,
    maxAttempts: 3,
  });

  const ready = store.getReadyOutboxItems(now);
  
  assert.equal(ready.length, 4);
  assert.equal(ready[0]?.deliveryId, 'deliv_4'); // earliest scheduledFor
  // Remaining items have same scheduledFor, so insertion order is preserved
  assert.equal(ready[1]?.deliveryId, 'deliv_1');
  assert.equal(ready[2]?.deliveryId, 'deliv_2');
  assert.equal(ready[3]?.deliveryId, 'deliv_3');
});

function addReadyItem(
  store: WebhookDeliveryStore,
  overrides?: Partial<Omit<OutboxItem, 'id' | 'status'>>,
): string {
  return store.addToOutbox({
    deliveryId: 'deliv_test',
    eventId: 'event_test',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/webhook',
    payload: '{}',
    secret: 'sec',
    priority: 'normal',
    createdAt: 0,
    scheduledFor: 0,
    attempts: 0,
    maxAttempts: 5,
    ...overrides,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Concurrent-claim tests
// ────────────────────────────────────────────────────────────────────────────

test('claimReadyOutboxItems: two workers never claim the same item', () => {
  const store = new WebhookDeliveryStore();
  const now = 1000;

  addReadyItem(store, { deliveryId: 'item_1', scheduledFor: 0 });
  addReadyItem(store, { deliveryId: 'item_2', scheduledFor: 0 });
  addReadyItem(store, { deliveryId: 'item_3', scheduledFor: 0 });

  // Worker A claims first
  const claimedA = store.claimReadyOutboxItems({ workerId: 'worker-a', now });
  expect(claimedA).toHaveLength(3);
  for (const item of claimedA) {
    expect(item.status).toBe('in_flight');
    expect(item.lockedBy).toBe('worker-a');
    expect(item.lockedAt).toBe(now);
  }

  // Worker B claims second — no items left
  const claimedB = store.claimReadyOutboxItems({ workerId: 'worker-b', now });
  expect(claimedB).toHaveLength(0);
});

test('claimReadyOutboxItems: respects lock timeout — stuck items are reclaimable', () => {
  const store = new WebhookDeliveryStore();
  const lockTimeoutMs = 10_000;
  const claimTime = 1000;
  const farFuture = claimTime + lockTimeoutMs + 1;

  addReadyItem(store, { deliveryId: 'stuck_item' });

  // Worker A claims and then crashes (never releases)
  const claimedA = store.claimReadyOutboxItems({
    workerId: 'worker-a',
    now: claimTime,
    lockTimeoutMs,
  });
  expect(claimedA).toHaveLength(1);
  expect(claimedA[0].lockedBy).toBe('worker-a');

  // Worker B tries to claim before lock timeout — gets nothing
  const beforeTimeout = store.claimReadyOutboxItems({
    workerId: 'worker-b',
    now: claimTime + 5000,
    lockTimeoutMs,
  });
  expect(beforeTimeout).toHaveLength(0);

  // After lock timeout — Worker B reclaims the stuck item
  const afterTimeout = store.claimReadyOutboxItems({
    workerId: 'worker-b',
    now: farFuture,
    lockTimeoutMs,
  });
  expect(afterTimeout).toHaveLength(1);
  expect(afterTimeout[0].lockedBy).toBe('worker-b');
  expect(afterTimeout[0].lockedAt).toBe(farFuture);
  expect(afterTimeout[0].status).toBe('in_flight');
});

test('reclaimStuckItems: only returns stuck items', () => {
  const store = new WebhookDeliveryStore();
  const lockTimeoutMs = 10_000;
  const claimTime = 1000;
  const farFuture = claimTime + lockTimeoutMs + 1;

  addReadyItem(store, { deliveryId: 'stuck_1' });
  addReadyItem(store, { deliveryId: 'stuck_2' });
  addReadyItem(store, { deliveryId: 'pending_1' }); // will remain pending

  // Worker A claims all three
  store.claimReadyOutboxItems({ workerId: 'worker-a', now: claimTime, lockTimeoutMs });

  // Return pending_1 to pending (release it)
  const all = store.getAllOutboxItems();
  const pendingItem = all.find((i) => i.deliveryId === 'pending_1')!;
  store.releaseOutboxItem(pendingItem.id, 'worker-a');

  // Only the two still-locked items should be reclaimed
  const reclaimed = store.reclaimStuckItems({
    workerId: 'worker-b',
    now: farFuture,
    lockTimeoutMs,
  });
  expect(reclaimed).toHaveLength(2);
  expect(reclaimed.every((i) => i.lockedBy === 'worker-b')).toBe(true);

  // The pending item is not reclaimed
  const pendingReload = store.getAllOutboxItems().find((i) => i.deliveryId === 'pending_1')!;
  expect(pendingReload.status).toBe('pending');
});

test('releaseOutboxItem: only the locking worker can release', () => {
  const store = new WebhookDeliveryStore();

  const id = addReadyItem(store);
  store.claimReadyOutboxItems({ workerId: 'worker-a', now: 1000 });

  // Wrong worker cannot release
  expect(store.releaseOutboxItem(id, 'worker-b')).toBe(false);

  // Correct worker can release
  expect(store.releaseOutboxItem(id, 'worker-a')).toBe(true);

  const item = store.getAllOutboxItems().find((i) => i.id === id)!;
  expect(item.status).toBe('pending');
  expect(item.lockedBy).toBeUndefined();
});

test('markOutboxItemDelivered: claimed item is removed from queue', () => {
  const store = new WebhookDeliveryStore();

  const id = addReadyItem(store);
  store.claimReadyOutboxItems({ workerId: 'worker-a', now: 1000 });

  // Wrong worker cannot deliver
  expect(store.markOutboxItemDelivered(id, 'worker-b')).toBe(false);

  // Correct worker delivers
  expect(store.markOutboxItemDelivered(id, 'worker-a')).toBe(true);

  // Item removed from queue
  expect(store.getAllOutboxItems()).toHaveLength(0);
  expect(store.getReadyOutboxItems()).toHaveLength(0);
});

test('getReadyOutboxItems: excludes claimed (in_flight) items', () => {
  const store = new WebhookDeliveryStore();
  const now = 1000;

  addReadyItem(store, { deliveryId: 'claimed_item', scheduledFor: 0 });
  addReadyItem(store, { deliveryId: 'also_claimed', scheduledFor: 0 });
  addReadyItem(store, { deliveryId: 'free_item', scheduledFor: 0 });

  // Claim all three items
  store.claimReadyOutboxItems({ workerId: 'worker-a', now });

  // Release one item so it becomes pending again
  const allItems = store.getAllOutboxItems();
  const freeItem = allItems.find((i) => i.deliveryId === 'free_item')!;
  store.releaseOutboxItem(freeItem.id, 'worker-a');

  // Only the released item should appear in getReadyOutboxItems
  expect(store.getReadyOutboxItems(now)).toHaveLength(1);
  expect(store.getReadyOutboxItems(now)[0].deliveryId).toBe('free_item');
});

test('claimReadyOutboxItems: respects maxAttempts', () => {
  const store = new WebhookDeliveryStore();
  const now = 1000;

  addReadyItem(store, { deliveryId: 'exhausted', attempts: 5, maxAttempts: 5, scheduledFor: 0 });

  // No one should be able to claim an exhausted item
  const claimed = store.claimReadyOutboxItems({ workerId: 'worker-a', now });
  expect(claimed).toHaveLength(0);
});

test('addToOutbox always creates pending items regardless of input', () => {
  const store = new WebhookDeliveryStore();
  const now = Date.now();

  // Attempt to pass every non-pending status via the spread of an object.
  // The compile-time type should prevent `status` from being accepted, but
  // this test provides a runtime regression guarantee as well.
  const statuses = ['in_flight', 'delivered', 'failed'] as const;

  for (const status of statuses) {
    const baseItem = {
      deliveryId: `deliv_${status}`,
      eventId: 'event_test',
      eventType: 'stream.created' as const,
      endpointUrl: 'https://example.com',
      payload: '{}',
      secret: 'sec',
      priority: 'normal' as const,
      createdAt: now,
      scheduledFor: now,
      attempts: 0,
      maxAttempts: 5,
    };

    // Spread an object that includes `status` to simulate a caller accidentally
    // forwarding an existing item's fields.  The `addToOutbox` signature now
    // excludes `status`, so at compile-time this would be an error; the cast
    // below is intentional to test the runtime guard.
    const itemWithStatus = { ...baseItem, status } as unknown as Parameters<
      WebhookDeliveryStore['addToOutbox']
    >[0];

    const id = store.addToOutbox(itemWithStatus);
    const stored = store.getAllOutboxItems().find((i) => i.id === id)!;

    expect(stored.status).toBe('pending');
  }
});

test('addToOutbox creates pending items for a normal call', () => {
  const store = new WebhookDeliveryStore();
  const id = addReadyItem(store, { deliveryId: 'normal_item' });
  const item = store.getAllOutboxItems().find((i) => i.id === id)!;
  expect(item.status).toBe('pending');
});

test('hydrateOutboxItem preserves the provided status', () => {
  const store = new WebhookDeliveryStore();
  const item: OutboxItem = {
    id: 'hydrated_1',
    deliveryId: 'deliv_hydrated',
    eventId: 'event_hydrated',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com',
    payload: '{}',
    secret: 'sec',
    priority: 'normal',
    createdAt: 0,
    scheduledFor: 0,
    attempts: 1,
    maxAttempts: 5,
    status: 'in_flight',
  };

  store.hydrateOutboxItem(item);
  const stored = store.getAllOutboxItems().find((i) => i.id === 'hydrated_1')!;
  expect(stored.status).toBe('in_flight');
});
