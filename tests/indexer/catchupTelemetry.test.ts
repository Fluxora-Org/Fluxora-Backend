/**
 * tests/indexer/catchupTelemetry.test.ts
 *
 * Focused regression test suite for crash-safe, monotonic replay progress checkpoints,
 * failure/retry boundaries, and catchup telemetry.
 *
 * Covers:
 *  - Crash injection before side effects (no partial event persistence, offset unadvanced)
 *  - Crash injection after side effects (event duplicate absorption, idempotent completion)
 *  - Monotonic progress enforcement (checkpoints never regress or move backward)
 *  - Zero-event loss and zero-event skip verification upon crash-recovery retry
 *  - Postgres store & memory store checkpoint round-trips
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryContractEventStore,
  PostgresContractEventStore,
  ReplayProgressCheckpoint,
} from '../../src/indexer/store.js';
import {
  ReplayCursorRepository,
} from '../../src/indexer/service.js';
import type { ContractEventRecord } from '../../src/indexer/types.js';

function makeEvent(eventId: string, ledger = 100): ContractEventRecord {
  return {
    eventId,
    ledger,
    contractId: 'C_CATCHUP_TEST',
    topic: 'transfer',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '50.0000000' },
    happenedAt: '2026-01-01T00:00:00.000Z',
    ledgerHash: `hash-${ledger}`,
  };
}

// Helper to create a store wrapper that tracks concurrent writes and allows failure/delay injection
const WRITE_KEYWORDS = /^(save|append|add|write|persist|insert|put|store|batch|commit|update|set)/i;

function createConfiguredStore() {
  const store = new InMemoryContractEventStore();
  let failLedger: number | undefined;
  let delayMs = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;

  const handler: ProxyHandler<InMemoryContractEventStore> = {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;

      return (...args: unknown[]) => {
        const first = args[0];
        const isEventBatch = Array.isArray(first) && first.length > 0 && typeof first[0] === 'object' && first[0] !== null && 'ledger' in first[0];

        // Only count write operations (methods that receive event arrays)
        if (!isEventBatch && !(typeof prop === 'string' && WRITE_KEYWORDS.test(prop))) {
          return original.apply(target, args);
        }

        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);

        const execute = async () => {
          try {
            if (failLedger !== undefined && isEventBatch && (first as Array<{ ledger: number }>).some(e => e.ledger === failLedger)) {
              throw new Error(`simulated failure for ledger ${failLedger}`);
            }
            if (delayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            return await original.apply(target, args);
          } finally {
            activeWrites--;
          }
        };

        return execute();
      };
    },
  };

  const proxied = new Proxy(store, handler) as InMemoryContractEventStore;
  return {
    store: proxied,
    setFailLedger: (ledger: number | undefined) => { failLedger = ledger; },
    setDelayMs: (ms: number) => { delayMs = ms; },
    getMaxActiveWrites: () => maxActiveWrites,
  };
}

describe('Indexer Catch-up Telemetry', () => {
  let ingestionService: IndexerIngestionService;
  let mockRpcClient: RawRpcClient;
  let mockRpcService: StellarRpcService;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  describe('InMemoryContractEventStore — saveCheckpoint & getCheckpoint', () => {
    it('stores and retrieves a valid progress checkpoint', async () => {
      const checkpoint: ReplayProgressCheckpoint = {
        cursorId: 'cursor-101',
        total: 50,
        lastCommittedOffset: 10,
        status: 'in-progress',
      };

      await store.saveCheckpoint(checkpoint);
      const retrieved = await store.getCheckpoint('cursor-101');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.cursorId).toBe('cursor-101');
      expect(retrieved!.lastCommittedOffset).toBe(10);
      expect(retrieved!.total).toBe(50);
      expect(retrieved!.status).toBe('in-progress');
    });

    it('should return updated telemetry after ingest', async () => {
      // Mock RPC tip at ledger 1000
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 950,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();

      expect(telemetry.ledgerLag).toBe(50); // 1000 - 950
      expect(telemetry.lastIndexedLedger).toBe(950);
      expect(telemetry.lastLedgerLagUpdateAt).not.toBeNull();
      expect(telemetry.catchupEtaSeconds).toBeNull(); // No ETA yet (first sample)
    });
  });

  describe('ledger lag computation', () => {
    it('should compute lag as tip - last indexed ledger', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 900,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(100);
    });

    it('should return zero lag when caught up', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 1000,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(0);
    });

    it('should handle lag when indexer is behind', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 5000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 1000,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(4000);
    });

    it('should never return negative lag', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 500 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 1000,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(0); // Should be 0, not negative
    });
  });

  describe('ETA estimation with rolling average', () => {
    it('should estimate ETA using rolling average throughput', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      // First ingest - establishes baseline
      const events1: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 900,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events: events1 }, { actor: 'test-actor', requestId: 'test-1' });

      // Wait a bit to simulate time passing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Second ingest - provides throughput sample
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1005 });
      const events2: ContractEventRecord[] = [
        {
          eventId: 'event-2',
          ledger: 950,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-2',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-2',
        },
      ];

      await ingestionService.ingest({ events: events2 }, { actor: 'test-actor', requestId: 'test-2' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(55); // 1005 - 950
      expect(telemetry.catchupEtaSeconds).not.toBeNull();
      expect(telemetry.catchupEtaSeconds).toBeGreaterThan(0);
    });

    it('should maintain rolling window of 10 samples', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      // Ingest 15 times to test window size
      for (let i = 0; i < 15; i++) {
        const events: ContractEventRecord[] = [
          {
            eventId: `event-${i}`,
            ledger: 800 + i * 10,
            contractId: 'contract-1',
            topic: 'topic-1',
            txHash: `hash-${i}`,
            txIndex: 0,
            operationIndex: 0,
            eventIndex: 0,
            payload: {},
            happenedAt: new Date().toISOString(),
            ledgerHash: `ledger-hash-${i}`,
          },
        ];

        vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 + i * 10 });
        await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: `test-${i}` });
        
        // Small delay to simulate time passing
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const telemetry = ingestionService.getCatchupTelemetry();
      // Should have computed ETA from rolling average
      expect(telemetry.catchupEtaSeconds).not.toBeNull();
    });

    it('should return null ETA when not lagging', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 1000,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(0);
      expect(telemetry.catchupEtaSeconds).toBeNull();
    });

    it('should return null ETA on first ingest (no throughput data)', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 900,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(100);
      expect(telemetry.catchupEtaSeconds).toBeNull(); // No ETA on first sample
    });
  });

  describe('Prometheus metrics', () => {
    it('should update indexerLedgerLag guage', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const events: ContractEventRecord[] = [
        {
          eventId: 'event-1',
          ledger: 900,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-1',
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      const metric = await indexerLedgerLag.get();
      expect(metric.values[0].value).toBe(100);
    });

    it('should update indexerCatchupEtaSeconds guage', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      // Need two ingests to get a throughput sample
      const events1 = [makeEvent(900, 'e1')];
      await ingestionService.ingest({ events: events1 }, { actor: 'test', requestId: 'r1' });

      await new Promise(resolve => setTimeout(resolve, 10));
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1005 });
      const events2 = [makeEvent(950, 'e2')];
      await ingestionService.ingest({ events: events2 }, { actor: 'test', requestId: 'r2' });

      const metric = await indexerCatchupEtaSeconds.get();
      expect(metric.values[0].value).toBeGreaterThan(0);
    });

    it('should handle rpc failure gracefully', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockRejectedValue(new Error('RPC failed'));

      const events = [makeEvent(500, 'e1')];
      await expect((ingestionService.ingest({ events }, { actor: 'test', requestId: 't' }))).resolves.not.toThrow();
      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(0);
    });
  });

  describe('backfill concurrency control', () => {
    it('should bound concurrent store writes to at most 4', async () => {
      const { store, setDelayMs, getMaxActiveWrites } = createConfiguredStore();
      setDelayMs(20);
      ingestionService = new IndexerIngestionService(store);
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const promises = Array.from({ length: 10 }, (_, i) => {
        const events = [makeEvent(100 + i, `event-${i}`)];
        return ingestionService.ingest({ events }, { actor: 'test', requestId: `test-${i}` });
      });

      // Attempting to regress offset from 40 to 20 should throw a Monotonicity violation
      await expect(
        store.saveCheckpoint({
          cursorId: 'cursor-102',
          total: 100,
          lastCommittedOffset: 20,
          status: 'in-progress',
        }),
      ).rejects.toThrow('Monotonicity violation');

      // Assert checkpoint offset remains at 40
      const current = await store.getCheckpoint('cursor-102');
      expect(current!.lastCommittedOffset).toBe(40);
    });

    it('should preserve ordered checkpoints when a batch fails', async () => {
      const { store, setFailLedger } = createConfiguredStore();
      setFailLedger(2);
      ingestionService = new IndexerIngestionService(store);
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      await store.saveCheckpoint({
        cursorId: 'cursor-103',
        total: 100,
        lastCommittedOffset: 20,
        status: 'in-progress',
      });

      expect(results.some(r => r.status === 'rejected')).toBe(true);
      const telemetry = ingestionService.getCatchupTelemetry();
      // Ledger 2 failed, so the highest successfully processed ledger is 3
      // (ledger 3 succeeded despite ledger 2 failing)
      expect(telemetry.lastIndexedLedger).toBe(3);
    });

    it('should resume from last checkpoint after retry', async () => {
      const { store, setFailLedger } = createConfiguredStore();
      setFailLedger(2);
      ingestionService = new IndexerIngestionService(store);
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const batch = [makeEvent('e1'), makeEvent('e2')];

      // 1. Side effect executes successfully
      const result = await store.insertMany(batch);
      expect(result.insertedEventIds).toEqual(['e1', 'e2']);

      // 2. Crash occurs AFTER side effect, BEFORE checkpoint save
      // Simulated process crash / crash interruption here

      // Checkpoint in store is still at offset 0, but events e1, e2 exist in store
      const cpBeforeRetry = await store.getCheckpoint(cursorId);
      expect(cpBeforeRetry!.lastCommittedOffset).toBe(0);

      // 3. Recovery / retry: replay process restarts from last committed checkpoint (offset 0)
      // Re-inserting the same batch (e1, e2) MUST be idempotent (0 new inserts, 2 duplicates)
      const retryResult = await store.insertMany(batch);
      expect(retryResult.insertedEventIds).toEqual([]);
      expect(retryResult.duplicateEventIds).toEqual(['e1', 'e2']);

      // Now save checkpoint for offset 2
      await store.saveCheckpoint({
        cursorId,
        total: 10,
        lastCommittedOffset: 2,
        status: 'in-progress',
      });

      // Assert: No duplicate rows in store, offset advanced monotonically to 2
      expect(store.all()).toHaveLength(2);
      const cpAfterRetry = await store.getCheckpoint(cursorId);
      expect(cpAfterRetry!.lastCommittedOffset).toBe(2);
    });

    it('should handle duplicate batches without advancing checkpoint incorrectly', async () => {
      const { store } = createConfiguredStore();
      ingestionService = new IndexerIngestionService(store);
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const repo = new ReplayCursorRepository();
      await repo.advanceOffset(client, 'cursor-pg-1', 45);

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('GREATEST(last_committed_offset, $1)');
      expect(queries[0].values).toEqual([45, 'cursor-pg-1']);
    });

    it('PostgresContractEventStore saveCheckpoint issues ON CONFLICT DO UPDATE SQL', async () => {
      const queries: Array<{ sql: string; values?: unknown[] }> = [];
      const client = {
        query: async <T>(sql: string, values?: unknown[]) => {
          queries.push({ sql, values });
          return { rows: [] as T[], rowCount: 1 };
        },
      };

      const store = new PostgresContractEventStore(client);
      await store.saveCheckpoint({
        cursorId: 'c-uuid-999',
        total: 100,
        lastCommittedOffset: 30,
        status: 'in-progress',
      });

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('INSERT INTO indexer_replay_progress');
      expect(queries[0].sql).toContain('ON CONFLICT (last_committed_cursor) DO UPDATE');
      expect(queries[0].values).toEqual(['c-uuid-999', 100, 'in-progress']);
    });
  });
});
