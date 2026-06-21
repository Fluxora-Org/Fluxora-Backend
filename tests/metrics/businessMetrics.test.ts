import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { registry } from '../../src/metrics.js';
import {
  streamsCreatedTotal,
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
  indexerEventsIngestedTotal,
  indexerLagSeconds,
  syncWebhookStoreMetrics,
  deRegisterBusinessMetrics,
} from '../../src/metrics/businessMetrics.js';
import { WebhookService } from '../../src/webhooks/service.js';
import { IndexerIngestionService } from '../../src/indexer/service.js';
import { InMemoryContractEventStore } from '../../src/indexer/store.js';

const ADMIN_KEY = 'business-metrics-admin-key';
let originalAdminKey: string | undefined;

// Setup fresh metrics before each test in this suite
beforeEach(() => {
  originalAdminKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;

  // Reset existing metrics if they are still registered
  try {
    streamsCreatedTotal.reset();
    webhookDeliveriesTotal.reset();
    webhookDeliveryDurationSeconds.reset();
    indexerEventsIngestedTotal.reset();
    indexerLagSeconds.reset();
  } catch {
    // no-op if already de-registered
  }
});

afterEach(() => {
  if (originalAdminKey !== undefined) {
    process.env.ADMIN_API_KEY = originalAdminKey;
  } else {
    delete process.env.ADMIN_API_KEY;
  }
});

describe('Business Metrics Integration', () => {
  // 1. Webhook Service Delivery Metrics Observation
  describe('Webhook Service metrics', () => {
    let originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('records success outcome and latency on 2xx responses', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const service = new WebhookService();
      const delivery = {
        id: 'deliv-1',
        deliveryId: 'd1',
        eventId: 'evt-1',
        eventType: 'stream.created',
        endpointUrl: 'http://test-endpoint.local',
        status: 'pending' as const,
        attempts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: '{}',
      };

      await service.attemptDelivery(delivery, 'test-secret', '123456');

      // Verify counter
      const counterVal = await webhookDeliveriesTotal.get();
      expect(counterVal.values).toHaveLength(1);
      expect(counterVal.values[0]?.labels).toEqual({ outcome: 'success' });
      expect(counterVal.values[0]?.value).toBe(1);

      // Verify histogram
      const histVal = await webhookDeliveryDurationSeconds.get();
      expect(histVal.values.length).toBeGreaterThan(0);
    });

    it('records failed outcome on non-2xx responses', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const service = new WebhookService({
        maxAttempts: 1,
        initialDelayMs: 1,
        backoffMultiplier: 1.5,
        timeoutMs: 10,
      });
      const delivery = {
        id: 'deliv-2',
        deliveryId: 'd2',
        eventId: 'evt-2',
        eventType: 'stream.created',
        endpointUrl: 'http://test-endpoint.local',
        status: 'pending' as const,
        attempts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: '{}',
      };

      await service.attemptDelivery(delivery, 'test-secret', '123456');

      // Verify counter
      const counterVal = await webhookDeliveriesTotal.get();
      expect(counterVal.values).toHaveLength(1);
      expect(counterVal.values[0]?.labels).toEqual({ outcome: 'failed' });
      expect(counterVal.values[0]?.value).toBe(1);
    });

    it('records failed outcome on network exception', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network disconnected'));

      const service = new WebhookService({
        maxAttempts: 1,
        initialDelayMs: 1,
        backoffMultiplier: 1.5,
        timeoutMs: 10,
      });
      const delivery = {
        id: 'deliv-3',
        deliveryId: 'd3',
        eventId: 'evt-3',
        eventType: 'stream.created',
        endpointUrl: 'http://test-endpoint.local',
        status: 'pending' as const,
        attempts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: '{}',
      };

      await service.attemptDelivery(delivery, 'test-secret', '123456');

      // Verify counter still observed failure
      const counterVal = await webhookDeliveriesTotal.get();
      expect(counterVal.values).toHaveLength(1);
      expect(counterVal.values[0]?.labels).toEqual({ outcome: 'failed' });
      expect(counterVal.values[0]?.value).toBe(1);
    });
  });

  // 2. Indexer Service Metrics Observation
  describe('Indexer Ingestion Service metrics', () => {
    it('records ingested count and updates lag seconds gauge', async () => {
      const store = new InMemoryContractEventStore();
      const service = new IndexerIngestionService(store);

      const happenedAt = new Date(Date.now() - 10000).toISOString(); // 10s lag
      const rawEvents = {
        events: [
          {
            eventId: 'evt-idx-1',
            ledger: 100,
            contractId: 'C1',
            topic: 'stream.created',
            txHash: 'tx1',
            txIndex: 0,
            operationIndex: 0,
            eventIndex: 0,
            payload: {},
            happenedAt,
            ledgerHash: 'hash100',
          },
        ],
      };

      await service.ingest(rawEvents, { actor: 'test-actor' });

      // Verify count counter
      const countVal = await indexerEventsIngestedTotal.get();
      expect(countVal.values).toHaveLength(1);
      expect(countVal.values[0]?.value).toBe(1);

      // Verify lag gauge is set to approx 10s (allow range due to execution time)
      const lagVal = await indexerLagSeconds.get();
      expect(lagVal.values).toHaveLength(1);
      expect(lagVal.values[0]?.value).toBeGreaterThanOrEqual(9.5);
      expect(lagVal.values[0]?.value).toBeLessThanOrEqual(15);
    });
  });

  // 3. Scrape integration
  it('exposes custom business metrics in /metrics endpoint', async () => {
    streamsCreatedTotal.inc({ status: 'active' });
    syncWebhookStoreMetrics({ dlqItems: 1, outboxItems: 2 });

    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('fluxora_streams_created_total');
    expect(res.text).toContain('status="active"');
    expect(res.text).toMatch(/fluxora_webhook_dlq_items\{[^}]*\} 1/);
    expect(res.text).toMatch(/fluxora_webhook_outbox_pending_items\{[^}]*\} 2/);
  });

  // 4. Double Registration & De-registration protection
  it('guards against duplicate registration on multiple loads and supports de-registration', () => {
    // Attempting to look up or get standard metrics returns the exact instances
    const streamsMetric = registry.getSingleMetric('fluxora_streams_created_total');
    expect(streamsMetric).toBe(streamsCreatedTotal);

    // Verify calling deRegister removes them
    deRegisterBusinessMetrics();
    expect(registry.getSingleMetric('fluxora_streams_created_total')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_webhook_dlq_items')).toBeUndefined();
  });
});