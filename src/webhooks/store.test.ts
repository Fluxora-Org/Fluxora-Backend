import assert from 'node:assert/strict';
import test from 'node:test';
import { WebhookDeliveryStore } from './store.js';
import type { WebhookDelivery } from './types.js';

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
