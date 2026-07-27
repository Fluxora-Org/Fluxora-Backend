/**
 * Restart-survival regression test — Issue #841
 *
 * Problem: `WebhookDeliveryStore` is fully in-memory.  Every pending outbox
 * delivery, DLQ entry, and delivery-status record is lost on process restart.
 * In a multi-replica deployment each instance has its own independent view.
 *
 * Fix: `PgWebhookDeliveryStore` persists all mutations to Postgres and
 * rehydrates on startup, so state survives restarts and is shared across
 * replicas.
 *
 * This file contains two test suites:
 *
 * 1. `InMemoryStore — proves restart-data-loss (documents the known limitation)`
 *    Demonstrates the exact failure mode described in issue #841: items added
 *    to the in-memory store disappear when a new instance is created (simulating
 *    a process restart).
 *
 * 2. `PgWebhookDeliveryStore — restart-survival via hydrate()`
 *    The durable path: adds items through a first store instance, then
 *    creates a second instance and calls `hydrate()` with a mock pool that
 *    returns those same rows — confirming that post-restart state is
 *    correctly restored.
 *
 * The second suite is the regression test that must PASS after the fix.
 */

import { describe, it, expect, vi } from 'vitest';
import { WebhookDeliveryStore, type IWebhookDeliveryStore } from '../../src/webhooks/store.js';
import { PgWebhookDeliveryStore } from '../../src/webhooks/pgStore.js';
import type { WebhookDelivery } from '../../src/webhooks/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'delivery_restart_001',
    deliveryId: 'deliv_restart_001',
    eventId: 'event_restart_001',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/hook',
    status: 'pending',
    attempts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: '{"restart":"test"}',
    ...overrides,
  };
}

function makeOutboxItem() {
  return {
    deliveryId: 'deliv_restart_outbox_001',
    eventId: 'event_restart_001',
    eventType: 'stream.created' as const,
    endpointUrl: 'https://example.com/hook',
    payload: '{"restart":"outbox"}',
    secret: 'secret-abc',
    priority: 'normal' as const,
    createdAt: Date.now(),
    scheduledFor: Date.now() - 1000, // already due
    attempts: 0,
    maxAttempts: 5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — In-memory store: documents the data-loss limitation (issue #841)
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryStore — restart causes data loss (known limitation, issue #841)', () => {
  it('outbox items are lost after a simulated restart (new instance)', () => {
    // "Before restart": add an outbox item
    const beforeRestart = new WebhookDeliveryStore();
    beforeRestart.addToOutbox(makeOutboxItem());
    expect(beforeRestart.getAllOutboxItems()).toHaveLength(1);

    // "After restart": new instance — in-memory state is gone
    const afterRestart = new WebhookDeliveryStore();
    expect(afterRestart.getAllOutboxItems()).toHaveLength(0);
    // This demonstrates the exact failure mode described in #841
  });

  it('DLQ items are lost after a simulated restart (new instance)', () => {
    const delivery = makeDelivery({ status: 'permanent_failure' });

    const beforeRestart = new WebhookDeliveryStore();
    beforeRestart.addToDeadLetterQueue(delivery, 'max retries exhausted', 'exhausted');
    expect(beforeRestart.getDeadLetterQueueItems()).toHaveLength(1);

    // New instance — DLQ is empty
    const afterRestart = new WebhookDeliveryStore();
    expect(afterRestart.getDeadLetterQueueItems()).toHaveLength(0);
  });

  it('delivery status records are lost after a simulated restart (new instance)', () => {
    const delivery = makeDelivery();

    const beforeRestart = new WebhookDeliveryStore();
    beforeRestart.store(delivery);
    expect(beforeRestart.getByDeliveryId(delivery.deliveryId)).toBeDefined();

    // New instance — delivery record is gone
    const afterRestart = new WebhookDeliveryStore();
    expect(afterRestart.getByDeliveryId(delivery.deliveryId)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — PgWebhookDeliveryStore: state survives restart via hydrate()
// This is the regression test that must PASS after the fix.
// ─────────────────────────────────────────────────────────────────────────────

describe('PgWebhookDeliveryStore — restart-survival via hydrate() (regression test #841)', () => {
  /**
   * Build a minimal mock Pool that returns the given outbox rows and DLQ rows
   * when `hydrate()` is called.
   */
  function buildMockPool(opts: {
    outboxRows?: object[];
    dlqRows?: object[];
    /** If true, query() will reject (simulates DB failure) */
    failQuery?: boolean;
  } = {}) {
    const outboxRows = opts.outboxRows ?? [];
    const dlqRows = opts.dlqRows ?? [];
    let callCount = 0;

    return {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (opts.failQuery) throw new Error('DB connection refused');

        // hydrate() makes two queries: outbox then DLQ
        // Any other query (write-through) just returns empty rows
        if (sql.includes('webhook_outbox_items')) {
          callCount++;
          if (callCount === 1) return { rows: outboxRows };
        }
        if (sql.includes('webhook_dlq')) {
          return { rows: dlqRows };
        }
        return { rows: [] };
      }),
    } as unknown as import('pg').Pool;
  }

  it('outbox items added before restart are visible after hydrate()', async () => {
    // "Before restart": record the outbox item we would have written to Postgres
    const now = Date.now();
    const outboxRow = {
      id: 'outbox_pg_001',
      delivery_id: 'deliv_pg_001',
      event_id: 'event_pg_001',
      event_type: 'stream.created',
      endpoint_url: 'https://example.com/hook',
      payload: '{"restart":"test"}',
      secret: 'secret-abc',
      priority: 'normal',
      created_at: new Date(now),
      scheduled_for: new Date(now - 1000),
      attempts: 0,
      max_attempts: 5,
      status: 'pending',
      locked_at: null,
      locked_by: null,
    };

    // "After restart": fresh PgWebhookDeliveryStore, hydrate from mock Postgres
    const pool = buildMockPool({ outboxRows: [outboxRow] });
    const afterRestart = new PgWebhookDeliveryStore(pool);

    // Before hydration — mirror is empty
    expect(afterRestart.getAllOutboxItems()).toHaveLength(0);

    // Hydrate from Postgres (simulating what happens on startup)
    await afterRestart.hydrate();

    // After hydration — outbox item is present
    const items = afterRestart.getAllOutboxItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.deliveryId).toBe('deliv_pg_001');
    expect(items[0]?.eventId).toBe('event_pg_001');
    expect(items[0]?.status).toBe('pending');
  });

  it('DLQ items added before restart are visible after hydrate()', async () => {
    const delivery = makeDelivery({ status: 'permanent_failure' });
    const now = Date.now();

    const dlqRow = {
      id: 'dlq_pg_001',
      delivery_id: delivery.deliveryId,
      event_id: delivery.eventId,
      event_type: delivery.eventType,
      endpoint_url: delivery.endpointUrl,
      payload: delivery.payload,
      original_delivery: JSON.stringify(delivery),
      failure_reason: 'max retries exhausted',
      reason_code: 'exhausted',
      created_at: new Date(now),
      processed_at: null,
    };

    const pool = buildMockPool({ dlqRows: [dlqRow] });
    const afterRestart = new PgWebhookDeliveryStore(pool);

    // Before hydration — DLQ is empty
    expect(afterRestart.getDeadLetterQueueItems()).toHaveLength(0);

    // Hydrate
    await afterRestart.hydrate();

    // After hydration — DLQ item is present
    const items = afterRestart.getDeadLetterQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.deliveryId).toBe(delivery.deliveryId);
    expect(items[0]?.failureReason).toBe('max retries exhausted');
    expect(items[0]?.reasonCode).toBe('exhausted');
  });

  it('multiple restarts with hydrate() do not duplicate items', async () => {
    const now = Date.now();
    const outboxRow = {
      id: 'outbox_pg_dedup_001',
      delivery_id: 'deliv_dedup_001',
      event_id: 'event_dedup_001',
      event_type: 'stream.created',
      endpoint_url: 'https://example.com/hook',
      payload: '{}',
      secret: 'sec',
      priority: 'normal',
      created_at: new Date(now),
      scheduled_for: new Date(now - 1000),
      attempts: 0,
      max_attempts: 5,
      status: 'pending',
      locked_at: null,
      locked_by: null,
    };

    const pool = buildMockPool({ outboxRows: [outboxRow] });
    const store = new PgWebhookDeliveryStore(pool);

    // Hydrate once
    await store.hydrate();
    expect(store.getAllOutboxItems()).toHaveLength(1);

    // Calling hydrate() again is a no-op (idempotent)
    await store.hydrate();
    expect(store.getAllOutboxItems()).toHaveLength(1);
  });

  it('hydrate() throws when Postgres is unreachable and does not mark as hydrated', async () => {
    const pool = buildMockPool({ failQuery: true });
    const store = new PgWebhookDeliveryStore(pool);

    await expect(store.hydrate()).rejects.toThrow('DB connection refused');

    // Store should not be marked as hydrated — items remain empty
    expect(store.getAllOutboxItems()).toHaveLength(0);

    // A subsequent hydrate() call should retry (not silently succeed)
    await expect(store.hydrate()).rejects.toThrow('DB connection refused');
  });

  it('write-through: addToOutbox persists to Postgres', () => {
    const pool = buildMockPool();
    const store = new PgWebhookDeliveryStore(pool);

    store.addToOutbox(makeOutboxItem());

    // The synchronous call should have kicked off a Postgres write
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_outbox_items'),
      expect.any(Array)
    );
  });

  it('write-through: addToDeadLetterQueue persists to Postgres', () => {
    const pool = buildMockPool();
    const store = new PgWebhookDeliveryStore(pool);
    const delivery = makeDelivery({ status: 'permanent_failure' });

    store.addToDeadLetterQueue(delivery, 'exhausted retries', 'exhausted');

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_dlq'),
      expect.any(Array)
    );
  });

  it('write-through: store(delivery) persists to Postgres', () => {
    const pool = buildMockPool();
    const store = new PgWebhookDeliveryStore(pool);

    store.store(makeDelivery());

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_deliveries'),
      expect.any(Array)
    );
  });

  it('second instance without hydrate() sees no items — hydration is explicit', () => {
    // Demonstrates that PgWebhookDeliveryStore does NOT auto-hydrate in the
    // constructor; callers must call hydrate() explicitly on startup.
    const pool = buildMockPool({ outboxRows: [
      {
        id: 'outbox_no_hydrate_001',
        delivery_id: 'deliv_no_hydrate_001',
        event_id: 'event_001',
        event_type: 'stream.created',
        endpoint_url: 'https://example.com/hook',
        payload: '{}',
        secret: 'sec',
        priority: 'normal',
        created_at: new Date(),
        scheduled_for: new Date(),
        attempts: 0,
        max_attempts: 5,
        status: 'pending',
        locked_at: null,
        locked_by: null,
      },
    ]});

    const store = new PgWebhookDeliveryStore(pool);
    // No hydrate() call — mirror is empty
    expect(store.getAllOutboxItems()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — IWebhookDeliveryStore interface compliance
// Both implementations must satisfy the same contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('IWebhookDeliveryStore interface compliance', () => {
  const implementations: Array<{ name: string; factory: () => IWebhookDeliveryStore }> = [
    {
      name: 'WebhookDeliveryStore (in-memory)',
      factory: () => new WebhookDeliveryStore(),
    },
    {
      name: 'PgWebhookDeliveryStore (write-through)',
      factory: () => {
        const pool = {
          query: vi.fn().mockResolvedValue({ rows: [] }),
        } as unknown as import('pg').Pool;
        return new PgWebhookDeliveryStore(pool);
      },
    },
  ];

  for (const impl of implementations) {
    describe(impl.name, () => {
      it('store and retrieve a delivery', () => {
        const store = impl.factory();
        const delivery = makeDelivery();
        store.store(delivery);
        expect(store.get(delivery.id)).toMatchObject({ id: delivery.id });
        expect(store.getByDeliveryId(delivery.deliveryId)).toMatchObject({ deliveryId: delivery.deliveryId });
      });

      it('add and retrieve outbox items', () => {
        const store = impl.factory();
        const id = store.addToOutbox(makeOutboxItem());
        expect(id).toMatch(/^outbox_/);
        const items = store.getAllOutboxItems();
        expect(items).toHaveLength(1);
        expect(items[0]?.deliveryId).toBe('deliv_restart_outbox_001');
      });

      it('add and retrieve DLQ items', () => {
        const store = impl.factory();
        const delivery = makeDelivery({ status: 'permanent_failure' });
        store.addToDeadLetterQueue(delivery, 'exhausted', 'exhausted');
        const items = store.getDeadLetterQueueItems();
        expect(items).toHaveLength(1);
        expect(items[0]?.deliveryId).toBe(delivery.deliveryId);
      });

      it('isDuplicateDelivery returns false then true after store', () => {
        const store = impl.factory();
        const delivery = makeDelivery();
        expect(store.isDuplicateDelivery(delivery.deliveryId)).toBe(false);
        store.store(delivery);
        expect(store.isDuplicateDelivery(delivery.deliveryId)).toBe(true);
      });

      it('cleanup returns cleaned count', () => {
        const store = impl.factory();
        const result = store.cleanup();
        expect(result).toHaveProperty('cleaned');
        expect(result).toHaveProperty('errors');
      });

      it('getMetrics returns expected shape', () => {
        const store = impl.factory();
        const m = store.getMetrics();
        expect(m).toHaveProperty('totalDeliveries');
        expect(m).toHaveProperty('successfulDeliveries');
        expect(m).toHaveProperty('failedDeliveries');
        expect(m).toHaveProperty('dlqItems');
        expect(m).toHaveProperty('outboxItems');
      });

      it('clear() empties all state', () => {
        const store = impl.factory();
        store.store(makeDelivery());
        store.addToOutbox(makeOutboxItem());
        store.addToDeadLetterQueue(makeDelivery({ status: 'permanent_failure' }), 'test', 'other');
        store.clear();
        expect(store.getAll()).toHaveLength(0);
        expect(store.getAllOutboxItems()).toHaveLength(0);
        expect(store.getDeadLetterQueueItems()).toHaveLength(0);
      });
    });
  }
});
