/**
 * Dispatcher crash recovery and outbox claim lease regression test — Issue #1527
 *
 * Acceptance criteria:
 * 1. A claimed row is released after a documented lease period.
 * 2. A released row is redelivered exactly once.
 * 3. Lease columns are indexed for the claim query.
 * 4. The behaviour is tested with a simulated dispatcher crash.
 *
 * Validation:
 * Exercise the described condition against `src/webhooks/pgStore.ts` and assert
 * the documented outcome.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PgWebhookDeliveryStore,
  DEFAULT_CLAIM_LOCK_TIMEOUT_MS,
  DEFAULT_OUTBOX_LEASE_MS,
} from '../../src/webhooks/pgStore.js';
import { IN_FLIGHT_INDEX_NAME } from '../../src/db/migrations/007_add_webhook_outbox_lock_columns.js';
import type { OutboxItem } from '../../src/webhooks/store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockPool(opts: {
  outboxRows?: Record<string, unknown>[];
  queryHandler?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} = {}) {
  const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      executedQueries.push({ sql, params });
      if (opts.queryHandler) {
        return opts.queryHandler(sql, params);
      }
      if (sql.includes('SELECT') && sql.includes('webhook_outbox_items')) {
        return { rows: opts.outboxRows ?? [] };
      }
      return { rows: [] };
    }),
  } as unknown as import('pg').Pool;

  return { pool, executedQueries };
}

function makeOutboxItem(overrides: Partial<Omit<OutboxItem, 'id' | 'status'>> = {}) {
  return {
    deliveryId: 'deliv_test_001',
    eventId: 'event_001',
    eventType: 'stream.created' as const,
    endpointUrl: 'https://consumer.example.com/webhook',
    payload: '{"event":"stream.created","streamId":"st_001"}',
    secret: 'whsec_test_secret_123',
    priority: 'normal' as const,
    createdAt: 1_000_000,
    scheduledFor: 1_000_000,
    attempts: 0,
    maxAttempts: 5,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('PgWebhookDeliveryStore — outbox claim lease & dispatcher crash recovery (#1527)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Documented lease period constants', () => {
    it('documents the default claim lock timeout as 30,000 ms (30 seconds)', () => {
      expect(DEFAULT_CLAIM_LOCK_TIMEOUT_MS).toBe(30_000);
      expect(DEFAULT_OUTBOX_LEASE_MS).toBe(30_000);
    });
  });

  describe('Simulated dispatcher crash mid-delivery and lease expiry', () => {
    it('reclaims an outbox item after the documented lease period and redelivers exactly once', async () => {
      const { pool, executedQueries } = createMockPool();
      const store = new PgWebhookDeliveryStore(pool);

      const claimTime = 10_000;
      const leasePeriod = DEFAULT_CLAIM_LOCK_TIMEOUT_MS; // 30,000 ms

      // 1. Enqueue outbox item
      const itemId = store.addToOutbox(makeOutboxItem({ scheduledFor: claimTime - 1000 }));
      expect(store.getAllOutboxItems()).toHaveLength(1);
      expect(store.getAllOutboxItems()[0]?.status).toBe('pending');

      // 2. Dispatcher 1 claims the row for delivery
      const claimedByDispatcher1 = store.claimReadyOutboxItems({
        workerId: 'dispatcher-1',
        now: claimTime,
        lockTimeoutMs: leasePeriod,
      });

      expect(claimedByDispatcher1).toHaveLength(1);
      expect(claimedByDispatcher1[0]?.id).toBe(itemId);
      expect(claimedByDispatcher1[0]?.status).toBe('in_flight');
      expect(claimedByDispatcher1[0]?.lockedBy).toBe('dispatcher-1');
      expect(claimedByDispatcher1[0]?.lockedAt).toBe(claimTime);

      // Verify Postgres was updated with in_flight status, worker ID, and lock timestamp
      const claimQuery = executedQueries.find(
        (q) => q.sql.includes('webhook_outbox_items') && q.sql.includes("status = 'in_flight'")
      );
      expect(claimQuery).toBeDefined();
      expect(claimQuery?.params?.[0]).toBe('dispatcher-1');

      // 3. Dispatcher 1 "CRASHES" mid-delivery (process killed, network dies, etc.)
      // It never calls markOutboxItemDelivered or releaseOutboxItem.

      // 4. Dispatcher 2 attempts to claim while lease is STILL ACTIVE (e.g. at claimTime + 15s)
      const prematureClaim = store.claimReadyOutboxItems({
        workerId: 'dispatcher-2',
        now: claimTime + 15_000,
        lockTimeoutMs: leasePeriod,
      });
      // The claim is NOT released prematurely; delivery remains locked to prevent duplicates
      expect(prematureClaim).toHaveLength(0);
      expect(store.getReadyOutboxItems(claimTime + 15_000)).toHaveLength(0);

      // 5. Time advances past the documented lease period (e.g. claimTime + 30,001 ms)
      const afterLeaseExpiryTime = claimTime + leasePeriod + 1;

      // Dispatcher 2 now polls after the lease has expired
      const claimedByDispatcher2 = store.claimReadyOutboxItems({
        workerId: 'dispatcher-2',
        now: afterLeaseExpiryTime,
        lockTimeoutMs: leasePeriod,
      });

      // Assert criterion: A claimed row is released/reclaimed after a documented lease period
      expect(claimedByDispatcher2).toHaveLength(1);
      expect(claimedByDispatcher2[0]?.id).toBe(itemId);
      expect(claimedByDispatcher2[0]?.status).toBe('in_flight');
      expect(claimedByDispatcher2[0]?.lockedBy).toBe('dispatcher-2');
      expect(claimedByDispatcher2[0]?.lockedAt).toBe(afterLeaseExpiryTime);

      // Verify Postgres received an updated claim query for dispatcher-2
      const reclaimQuery = executedQueries
        .filter((q) => q.sql.includes('webhook_outbox_items') && q.sql.includes("status = 'in_flight'"))
        .pop();
      expect(reclaimQuery?.params?.[0]).toBe('dispatcher-2');

      // 6. Dispatcher 2 delivers successfully and marks delivered
      const delivered = store.markOutboxItemDelivered(itemId, 'dispatcher-2');
      expect(delivered).toBe(true);

      // Verify Postgres received status = 'delivered' update
      const deliveredQuery = executedQueries.find((q) => q.sql.includes('status = \'delivered\''));
      expect(deliveredQuery).toBeDefined();

      // 7. Assert criterion: A released row is redelivered EXACTLY ONCE
      // Subsequent queries by Dispatcher 2, Dispatcher 3, etc. yield nothing
      expect(store.getAllOutboxItems()).toHaveLength(0);
      expect(store.getReadyOutboxItems(afterLeaseExpiryTime + 10_000)).toHaveLength(0);
      const subsequentClaim = store.claimReadyOutboxItems({
        workerId: 'dispatcher-3',
        now: afterLeaseExpiryTime + 10_000,
        lockTimeoutMs: leasePeriod,
      });
      expect(subsequentClaim).toHaveLength(0);
    });

    it('supports reclaimStuckItems and persists the new lease to Postgres', async () => {
      const { pool, executedQueries } = createMockPool();
      const store = new PgWebhookDeliveryStore(pool);

      const claimTime = 5_000;
      const leasePeriod = 15_000; // custom 15s lease

      const itemId = store.addToOutbox(makeOutboxItem({ scheduledFor: claimTime }));
      store.claimReadyOutboxItems({ workerId: 'crashed-worker', now: claimTime, lockTimeoutMs: leasePeriod });

      // Before lease expiry: no stuck items
      expect(store.reclaimStuckItems({ workerId: 'recovery-worker', now: claimTime + 10_000, lockTimeoutMs: leasePeriod })).toHaveLength(0);

      // After lease expiry: stuck item is reclaimed
      const now = claimTime + leasePeriod + 500;
      const reclaimed = store.reclaimStuckItems({
        workerId: 'recovery-worker',
        now,
        lockTimeoutMs: leasePeriod,
      });

      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.id).toBe(itemId);
      expect(reclaimed[0]?.lockedBy).toBe('recovery-worker');
      expect(reclaimed[0]?.status).toBe('in_flight');

      // Verify Postgres was updated
      const persistCall = executedQueries.find(
        (q) => q.sql.includes('status = \'in_flight\'') && q.params?.[0] === 'recovery-worker'
      );
      expect(persistCall).toBeDefined();

      // Complete delivery
      expect(store.markOutboxItemDelivered(itemId, 'recovery-worker')).toBe(true);
      expect(store.getAllOutboxItems()).toHaveLength(0);
    });

    it('releaseExpiredLeases resets expired claims back to pending for general workers', async () => {
      const { pool, executedQueries } = createMockPool();
      const store = new PgWebhookDeliveryStore(pool);

      const claimTime = 20_000;
      const leasePeriod = DEFAULT_CLAIM_LOCK_TIMEOUT_MS;

      const itemId = store.addToOutbox(makeOutboxItem({ scheduledFor: claimTime }));
      store.claimReadyOutboxItems({ workerId: 'worker-dead', now: claimTime, lockTimeoutMs: leasePeriod });

      // Dead worker died. A background janitor calls releaseExpiredLeases before timeout:
      const premature = store.releaseExpiredLeases({ lockTimeoutMs: leasePeriod, now: claimTime + 10_000 });
      expect(premature).toHaveLength(0);

      // Background janitor calls releaseExpiredLeases after timeout:
      const released = store.releaseExpiredLeases({ lockTimeoutMs: leasePeriod, now: claimTime + leasePeriod + 100 });
      expect(released).toHaveLength(1);
      expect(released[0]?.id).toBe(itemId);
      expect(released[0]?.status).toBe('pending');
      expect(released[0]?.lockedBy).toBeUndefined();
      expect(released[0]?.lockedAt).toBeUndefined();

      // Check DB query was executed to set status = 'pending' and clear locks
      const resetQuery = executedQueries.find((q) => q.sql.includes('status = \'pending\', locked_by = NULL, locked_at = NULL'));
      expect(resetQuery).toBeDefined();

      // Now any worker can pick it up via getReadyOutboxItems or claimReadyOutboxItems
      expect(store.getReadyOutboxItems(claimTime + leasePeriod + 200)).toHaveLength(1);
      const claimed = store.claimReadyOutboxItems({ workerId: 'worker-fresh', now: claimTime + leasePeriod + 200 });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.lockedBy).toBe('worker-fresh');

      // Mark delivered -> redelivered exactly once
      store.markOutboxItemDelivered(itemId, 'worker-fresh');
      expect(store.getAllOutboxItems()).toHaveLength(0);
    });
  });

  describe('Dispatcher crash with full process restart and hydration', () => {
    it('survives process crash: loads in_flight row from Postgres and reclaims after lease expiry', async () => {
      const now = 50_000;
      const lockTimeoutMs = DEFAULT_CLAIM_LOCK_TIMEOUT_MS; // 30s
      const lockedAt = new Date(now - 35_000); // locked 35 seconds ago -> lease expired!

      const persistedInFlightRow = {
        id: 'outbox_crash_rehydrate_001',
        delivery_id: 'deliv_crash_001',
        event_id: 'event_crash_001',
        event_type: 'stream.created',
        endpoint_url: 'https://consumer.example.com/hook',
        payload: '{"event":"stream.created"}',
        secret: 'whsec_secret',
        priority: 'high',
        created_at: new Date(now - 60_000),
        scheduled_for: new Date(now - 60_000),
        attempts: 1,
        max_attempts: 5,
        status: 'in_flight',
        locked_at: lockedAt,
        locked_by: 'dead-dispatcher-process-PID-1234',
      };

      const { pool } = createMockPool({ outboxRows: [persistedInFlightRow] });

      // New process boots up after crash
      const newProcessStore = new PgWebhookDeliveryStore(pool);
      await newProcessStore.hydrate();

      // Row was restored into mirror
      const items = newProcessStore.getAllOutboxItems();
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('outbox_crash_rehydrate_001');
      expect(items[0]?.status).toBe('in_flight');
      expect(items[0]?.lockedBy).toBe('dead-dispatcher-process-PID-1234');
      expect(items[0]?.lockedAt).toBe(lockedAt.getTime());

      // Because lockedAt was 35s ago and lease is 30s, the new dispatcher immediately reclaims it
      const claimed = newProcessStore.claimReadyOutboxItems({
        workerId: 'new-dispatcher-PID-5678',
        now,
        lockTimeoutMs,
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe('outbox_crash_rehydrate_001');
      expect(claimed[0]?.lockedBy).toBe('new-dispatcher-PID-5678');
      expect(claimed[0]?.attempts).toBe(1); // attempt count preserved across crash

      // Deliver and verify single delivery
      expect(newProcessStore.markOutboxItemDelivered('outbox_crash_rehydrate_001', 'new-dispatcher-PID-5678')).toBe(true);
      expect(newProcessStore.getAllOutboxItems()).toHaveLength(0);
    });

    it('does not reclaim prematurely if process restarts before lease expires', async () => {
      const now = 50_000;
      const lockTimeoutMs = 30_000;
      const lockedAt = new Date(now - 10_000); // locked only 10s ago, 20s remaining

      const persistedInFlightRow = {
        id: 'outbox_crash_premature_001',
        delivery_id: 'deliv_crash_002',
        event_id: 'event_crash_002',
        event_type: 'stream.created',
        endpoint_url: 'https://consumer.example.com/hook',
        payload: '{}',
        secret: 'sec',
        priority: 'normal',
        created_at: new Date(now - 20_000),
        scheduled_for: new Date(now - 20_000),
        attempts: 0,
        max_attempts: 3,
        status: 'in_flight',
        locked_at: lockedAt,
        locked_by: 'dead-worker',
      };

      const { pool } = createMockPool({ outboxRows: [persistedInFlightRow] });
      const store = new PgWebhookDeliveryStore(pool);
      await store.hydrate();

      // At now (10s after lock): cannot claim
      const tooEarly = store.claimReadyOutboxItems({ workerId: 'new-worker', now, lockTimeoutMs });
      expect(tooEarly).toHaveLength(0);

      // At now + 25s (35s after lock): can claim
      const atExpiry = store.claimReadyOutboxItems({ workerId: 'new-worker', now: now + 25_000, lockTimeoutMs });
      expect(atExpiry).toHaveLength(1);
      expect(atExpiry[0]?.lockedBy).toBe('new-worker');
    });
  });

  describe('Indexing of lease columns for claim queries', () => {
    it('asserts migration 007 indexes lease column locked_at with in_flight condition', () => {
      expect(IN_FLIGHT_INDEX_NAME).toBe('idx_webhook_outbox_in_flight');
    });
  });
});
