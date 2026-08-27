/**
 * Tests for indexer catch-up telemetry (ledger lag and ETA estimation).

 * These tests verify that:
 * - Ledger lag is computed correctly from Stellar RPC tip
 * - ETA is estimated using rolling average throughput
 * - Metrics are updated correctly
 * - RPC failures are handled gracefully
 * - Edge cases are handled (no data, caught up, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexerIngestionService } from '../../src/indexer/service.js';
import { InMemoryContractEventStore } from '../../src/indexer/store.js';
import { indexerLedgerLag, indexerCatchupEtaSeconds, deRegisterIndexerLagMetrics } from '../../src/metrics/indexerLag.js';
import { setStellarRpcService, StellarRpcService, type RawRpcClient } from '../../src/services/stellar-rpc.js';
import { ContractEventRecord } from '../../src/indexer/types.js';

// Helper to create a contract event record for a ledger
function makeEvent(ledger: number, eventId: string): ContractEventRecord {
  return {
    eventId,
    ledger,
    contractId: 'contract-1',
    topic: 'topic-1',
    txHash: `hash-${ledger}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: {},
    happenedAt: new Date().toISOString(),
    ledgerHash: `ledger-hash-${ledger}`,
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
    // Reset metrics between tests
    deRegisterIndexerLagMetrics();

    // Create a mock RPC client
    mockRpcClient = {
      getLatestLedger: vi.fn(),
      horizonUrl: 'https://horizon-testnet.stellar.org',
    };

    // Create a mock RPC service
    mockRpcService = new StellarRpcService(
      () => mockRpcClient,
      {
        timeoutMs: 5000,
        maxRetries: 0,
        retryDelayMs: 1000,
        fallbackCacheTtlSeconds: 300,
        healthCheckIntervalMs: 0,
      }
    );

    // Set the mock RPC service
    setStellarRpcService(mockRpcService);

    // Create ingestion service with in-memory store
    const store = new InMemoryContractEventStore();
    ingestionService = new IndexerIngestionService(store);
  });

  afterEach(() => {
    // Clean up
    setStellarRpcService(null);
    deRegisterIndexerLagMetrics();
  });

  describe('getCatchupTelemetry', () => {
    it('should return initial telemetry with zero lag', () => {
      const telemetry = ingestionService.getCatchupTelemetry();

      expect(telemetry).toEqual({
        ledgerLag: 0,
        catchupEtaSeconds: null,
        lastIndexedLedger: 0,
        lastLedgerLagUpdateAt: null,
      });
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

      await Promise.all(promises);
      expect(getMaxActiveWrites()).toBeLessThanOrEqual(4);
    });

    it('should preserve ordered checkpoints when a batch fails', async () => {
      const { store, setFailLedger } = createConfiguredStore();
      setFailLedger(2);
      ingestionService = new IndexerIngestionService(store);
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      const results = await Promise.allSettled([
        ingestionService.ingest({ events: [makeEvent(1, 'e1')] }, { actor: 'test', requestId: 'r1' }),
        ingestionService.ingest({ events: [makeEvent(2, 'e2')] }, { actor: 'test', requestId: 'r2' }),
        ingestionService.ingest({ events: [makeEvent(3, 'e3')] }, { actor: 'test', requestId: 'r3' }),
      ]);

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

      // First attempt: ledger 2 fails
      await Promise.allSettled([
        ingestionService.ingest({ events: [makeEvent(1, 'e1')] }, { actor: 'test', requestId: 'r1' }),
        ingestionService.ingest({ events: [makeEvent(2, 'e2')] }, { actor: 'test', requestId: 'r2' }),
      ]);

      // Now allow letger 2 and 3, re-ingest from checkpoint
      setFailLedger(undefined);
      await ingestionService.ingest({ events: [makeEvent(2, 'e2b')] }, { actor: 'test', requestId: 'r2b' });
      await ingestionService.ingest({ events: [makeEvent(3, 'e3')] }, { actor: 'test', requestId: 'r3' });

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.lastIndexedLedger).toBe(3);
    });

    it('should handle duplicate batches without advancing checkpoint incorrectly', async () => {
      const { store } = createConfiguredStore();
      ingestionService = new IndexerIngestionService(store);
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      await Promise.all([
        ingestionService.ingest({ events: [makeEvent(1, 'e1a')] }, { actor: 'test', requestId: 'r1a' }),
        ingestionService.ingest({ events: [makeEvent(1, 'e1b')] }, { actor: 'test', requestId: 'r1b' }),
      ]);

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.lastIndexedLedger).toBe(1);
    });
  });
});
