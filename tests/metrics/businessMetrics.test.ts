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
  authJwtVerifyDurationSeconds,
  authApiKeyLookupDurationSeconds,
  deRegisterBusinessMetrics,
} from '../../src/metrics/businessMetrics.js';
import { WebhookService } from '../../src/webhooks/service.js';
import { IndexerIngestionService } from '../../src/indexer/service.js';
import { InMemoryContractEventStore } from '../../src/indexer/store.js';

// Setup fresh metrics before each test in this suite
beforeEach(() => {
  // Reset existing metrics if they are still registered
  try {
    streamsCreatedTotal.reset();
    webhookDeliveriesTotal.reset();
    webhookDeliveryDurationSeconds.reset();
    indexerEventsIngestedTotal.reset();
    indexerLagSeconds.reset();
    authJwtVerifyDurationSeconds.reset();
    authApiKeyLookupDurationSeconds.reset();
  } catch {
    // no-op if already de-registered
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

    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fluxora_streams_created_total');
    expect(res.text).toContain('status="active"');
  });

  // 4. Double Registration & De-registration protection
  it('guards against duplicate registration on multiple loads and supports de-registration', () => {
    // Attempting to look up or get standard metrics returns the exact instances
    const streamsMetric = registry.getSingleMetric('fluxora_streams_created_total');
    expect(streamsMetric).toBe(streamsCreatedTotal);

    // Verify calling deRegister removes them
    deRegisterBusinessMetrics();
    expect(registry.getSingleMetric('fluxora_streams_created_total')).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Issue #361 — auth-latency histograms
// ───────────────────────────────────────────────────────────────────────────────
describe('Auth Latency Histograms (issue #361)', () => {
  describe('fluxora_auth_jwt_verify_duration_seconds', () => {
    it('registers the histogram on the Prometheus registry', () => {
      expect(
        registry.getSingleMetric('fluxora_auth_jwt_verify_duration_seconds'),
      ).toBe(authJwtVerifyDurationSeconds);
    });

    it('declares outcome as the only label (no high-cardinality labels)', () => {
      const metric = registry.getSingleMetric('fluxora_auth_jwt_verify_duration_seconds');
      // prom-client exposes labelNames as a readonly string[]
      expect(metric?.labelNames).toEqual(['outcome']);
    });

    it('uses bounded bucket boundaries for auth latency', () => {
      // Every bucket must be > 0 and strictly increasing
      const upperBounds = (authJwtVerifyDurationSeconds as any).upperBounds as number[];
      for (let i = 0; i < upperBounds.length; i++) {
        expect(upperBounds[i]).toBeGreaterThan(0);
        if (i > 0) {
          expect(upperBounds[i]).toBeGreaterThan(upperBounds[i - 1]);
        }
      }
      // Cover sub-millisecond through roughly 1 second for JWT verify
      expect(upperBounds[0]).toBeLessThanOrEqual(0.001);
      expect(upperBounds[upperBounds.length - 1]).toBeGreaterThanOrEqual(1);
    });

    it('records an outcome=success observation and only emits the outcome label', () => {
      authJwtVerifyDurationSeconds.reset();
      authJwtVerifyDurationSeconds.observe({ outcome: 'success' }, 0.012);

      // Verify via /metrics endpoint
      return request(app)
        .get('/metrics')
        .expect(200)
        .then((res) => {
          expect(res.text).toContain('fluxora_auth_jwt_verify_duration_seconds');
          expect(res.text).toContain('outcome="success"');
        });
    });
  });

  describe('fluxora_auth_apikey_lookup_duration_seconds', () => {
    it('registers the histogram on the Prometheus registry', () => {
      expect(
        registry.getSingleMetric('fluxora_auth_apikey_lookup_duration_seconds'),
      ).toBe(authApiKeyLookupDurationSeconds);
    });

    it('declares outcome as the only label (no high-cardinality labels)', () => {
      const metric = registry.getSingleMetric('fluxora_auth_apikey_lookup_duration_seconds');
      expect(metric?.labelNames).toEqual(['outcome']);
    });

    it('uses bounded bucket boundaries for in-memory hash-compare latency', () => {
      const upperBounds = (authApiKeyLookupDurationSeconds as any).upperBounds as number[];
      for (let i = 0; i < upperBounds.length; i++) {
        expect(upperBounds[i]).toBeGreaterThan(0);
        if (i > 0) {
          expect(upperBounds[i]).toBeGreaterThan(upperBounds[i - 1]);
        }
      }
      // Bucket range is skewed sub-millisecond through 50 ms for hash compare
      expect(upperBounds[0]).toBeLessThanOrEqual(0.0001);
      expect(upperBounds[upperBounds.length - 1]).toBeGreaterThanOrEqual(0.05);
    });

    it('records an outcome=failure observation and only emits the outcome label', async () => {
      authApiKeyLookupDurationSeconds.reset();
      authApiKeyLookupDurationSeconds.observe({ outcome: 'failure' }, 0.0005);

      const val = await authApiKeyLookupDurationSeconds.get();
      // Only one labelled series, and the labels are exactly { outcome }
      expect(val.values.some((v) => v.labels.outcome === 'failure' && v.value === 1)).toBe(true);
      for (const v of val.values) {
        expect(Object.keys(v.labels)).toEqual(['outcome']);
      }
    });

    it('emits no credential material as labels (security guarantee)', async () => {
      authApiKeyLookupDurationSeconds.reset();
      // Observe with the only permitted label set
      authApiKeyLookupDurationSeconds.observe({ outcome: 'success' }, 0.001);

      const val = await authApiKeyLookupDurationSeconds.get();
      const forbidden = ['keyId', 'key_id', 'prefix', 'principal', 'jti', 'address', 'subject'];
      for (const v of val.values) {
        for (const f of forbidden) {
          expect((v.labels as Record<string, unknown>)[f]).toBeUndefined();
        }
      }
    });
  });

  describe('de-registration', () => {
    it('removes both auth histograms from the registry', () => {
      deRegisterBusinessMetrics();
      expect(registry.getSingleMetric('fluxora_auth_jwt_verify_duration_seconds')).toBeUndefined();
      expect(registry.getSingleMetric('fluxora_auth_apikey_lookup_duration_seconds')).toBeUndefined();
    });
  });
});
