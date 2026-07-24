import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  RedisWebhookCircuitBreakerStore,
  InMemoryWebhookCircuitBreakerStore,
  hashConsumerUrl,
  transitionsTotal,
} from '../../src/redis/webhookCircuitBreakerStore.js';

const consumerUrl = 'https://consumer.example/webhooks';
const policy = {
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 60_000,
};

describe('Webhook Circuit Breaker Metrics', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
    // Reset in place rather than removing/re-registering: the store module
    // captures `transitionsTotal` once at import time, so swapping in a new
    // Counter instance here would desync the store's increments from what
    // this test reads back.
    transitionsTotal.reset();
  });

  afterEach(async () => {
    redis.reset();
  });

  const runMetricsSuite = (createStore: () => any) => {
    it('emits transition metrics when state changes', async () => {
      const store = createStore();
      const now = Date.now();
      const counter = transitionsTotal;

      // Initial: closed -> open
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(consumerUrl, policy, now + i);
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
      const metrics = await counter.get();
      const metric = metrics.values.find(v => v.labels.from_state === 'closed' && v.labels.to_state === 'open');
      expect(metric).toBeDefined();
      expect(metric?.labels.consumer_hash).toBe(hashConsumerUrl(consumerUrl));
      expect(metric?.value).toBe(1);

      // open -> half-open
      await store.checkAndClaimAttempt(consumerUrl, policy, now + 100000);
      const metricsAfterProbe = await counter.get();
      const probeMetric = metricsAfterProbe.values.find(v => v.labels.from_state === 'open' && v.labels.to_state === 'half-open');
      expect(probeMetric).toBeDefined();
      expect(probeMetric?.value).toBe(1);

      // half-open -> closed (success)
      await store.recordSuccess(consumerUrl, policy);
      const metricsAfterSuccess = await counter.get();
      const successMetric = metricsAfterSuccess.values.find(v => v.labels.from_state === 'half-open' && v.labels.to_state === 'closed');
      expect(successMetric).toBeDefined();
      expect(successMetric?.value).toBe(1);

      await store.close();
    });

    it('emits transition metrics when half-open fails and re-opens', async () => {
      const store = createStore();
      const now = Date.now();
      const counter = transitionsTotal;

      // Open
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(consumerUrl, policy, now + i);
      }
      // half-open
      await store.checkAndClaimAttempt(consumerUrl, policy, now + 100000);

      // half-open -> open
      await store.recordFailure(consumerUrl, policy, now + 100001);

      const metrics = await counter.get();
      const failMetric = metrics.values.find(v => v.labels.from_state === 'half-open' && v.labels.to_state === 'open');
      expect(failMetric).toBeDefined();
      expect(failMetric?.value).toBe(1);
      
      await store.close();
    });
  };

  describe('RedisWebhookCircuitBreakerStore', () => {
    runMetricsSuite(() => new RedisWebhookCircuitBreakerStore(redis));
  });

  describe('InMemoryWebhookCircuitBreakerStore', () => {
    runMetricsSuite(() => new InMemoryWebhookCircuitBreakerStore());
  });
});
