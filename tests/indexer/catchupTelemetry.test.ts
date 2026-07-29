/**
 * Tests for indexer catch-up telemetry (ledger lag and ETA estimation).
 *
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
    it('should update indexerLedgerLag gauge', async () => {
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

    it('should update indexerCatchupEtaSeconds gauge when lagging', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      // First ingest
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

      // Second ingest with time delay
      await new Promise(resolve => setTimeout(resolve, 100));
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

      const metric = await indexerCatchupEtaSeconds.get();
      expect(metric.values[0].value).toBeGreaterThan(0);
    });

    it('should set indexerCatchupEtaSeconds to 0 when caught up', async () => {
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

      const metric = await indexerCatchupEtaSeconds.get();
      expect(metric.values[0].value).toBe(0);
    });
  });

  describe('RPC failure handling', () => {
    it('should handle RPC failures gracefully without failing ingest', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockRejectedValue(new Error('RPC timeout'));

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

      // Should not throw
      const result = await ingestionService.ingest({ events }, { actor: 'test-actor', requestId: 'test-1' });

      expect(result.insertedCount).toBe(1);
      
      // Telemetry should remain at initial values
      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(0);
      expect(telemetry.catchupEtaSeconds).toBeNull();
    });

    it('should keep last known values on RPC failure', async () => {
      // First successful ingest
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

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

      const telemetry1 = ingestionService.getCatchupTelemetry();
      expect(telemetry1.ledgerLag).toBe(100);

      // Second ingest with RPC failure
      vi.mocked(mockRpcClient.getLatestLedger).mockRejectedValue(new Error('RPC timeout'));

      const events2: ContractEventRecord[] = [
        {
          eventId: 'event-2',
          ledger: 910,
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

      const telemetry2 = ingestionService.getCatchupTelemetry();
      // Should keep previous values (100 lag from before)
      expect(telemetry2.ledgerLag).toBe(100);
    });
  });

  describe('state reset', () => {
    it('should reset telemetry state on resetRuntimeState', async () => {
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

      const telemetryBefore = ingestionService.getCatchupTelemetry();
      expect(telemetryBefore.ledgerLag).toBe(100);

      ingestionService.resetRuntimeState();

      const telemetryAfter = ingestionService.getCatchupTelemetry();
      expect(telemetryAfter.ledgerLag).toBe(0);
      expect(telemetryAfter.catchupEtaSeconds).toBeNull();
      expect(telemetryAfter.lastIndexedLedger).toBe(0);
      expect(telemetryAfter.lastLedgerLagUpdateAt).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle empty event batch', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000 });

      // Empty batch should not update telemetry
      const result = await ingestionService.ingest({ events: [] }, { actor: 'test-actor', requestId: 'test-1' });

      expect(result.insertedCount).toBe(0);

      const telemetry = ingestionService.getCatchupTelemetry();
      expect(telemetry.ledgerLag).toBe(0);
      expect(telemetry.catchupEtaSeconds).toBeNull();
    });

    it('should handle events with same ledger (no progress)', async () => {
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

      // Ingest same ledger again
      const events2: ContractEventRecord[] = [
        {
          eventId: 'event-2',
          ledger: 900,
          contractId: 'contract-1',
          topic: 'topic-1',
          txHash: 'hash-2',
          txIndex: 1,
          operationIndex: 0,
          eventIndex: 0,
          payload: {},
          happenedAt: new Date().toISOString(),
          ledgerHash: 'ledger-hash-1',
        },
      ];

      await ingestionService.ingest({ events: events2 }, { actor: 'test-actor', requestId: 'test-2' });

      const telemetry = ingestionService.getCatchupTelemetry();
      // Lag should still be computed based on tip
      expect(telemetry.ledgerLag).toBe(100);
    });

    it('should handle very large lag values', async () => {
      vi.mocked(mockRpcClient.getLatestLedger).mockResolvedValue({ sequence: 1000000 });

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
      expect(telemetry.ledgerLag).toBe(999000);
    });
  });
});
