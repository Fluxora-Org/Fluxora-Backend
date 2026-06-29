import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  RedisWebhookCircuitBreakerStore,
  InMemoryWebhookCircuitBreakerStore,
  getWebhookCircuitBreakerStore,
  setWebhookCircuitBreakerStore,
  hashConsumerUrl,
  WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX,
  WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX,
  type WebhookCircuitBreakerStore,
} from '../../src/redis/webhookCircuitBreakerStore.js';
import {
  attemptWebhookDeliveryWithRateLimit,
  checkWebhookDeliveryGate,
  shouldRetry,
  scheduleWebhookOutboxRetry,
  HALF_OPEN_CONTENTION_DEFERRAL_MS,
  countsTowardCircuitBreaker,
} from '../../src/webhooks/retry.js';
import { registry } from '../../src/metrics.js';

const consumerUrl = 'https://consumer.example/webhooks';
const policy = {
  maxAttempts: 5,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
  jitterPercent: 0,
  timeoutMs: 5000,
  retryableStatusCodes: [500],
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 60_000,
};

describe('RedisWebhookCircuitBreakerStore', () => {
  let redis: FakeRedisClient;
  let store: RedisWebhookCircuitBreakerStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    store = new RedisWebhookCircuitBreakerStore(redis);
    registry.removeSingleMetric('fluxora_webhook_circuit_breaker_transitions_total');
  });

  afterEach(async () => {
    await store.close();
    redis.reset();
  });

  it('hashes consumer URLs before composing Redis keys', () => {
    expect(hashConsumerUrl(consumerUrl)).toHaveLength(16);
    expect(`${WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX}${hashConsumerUrl("https://evil/redis\nkey")}`).not.toContain('\n');
  });

  it('opens after threshold failures and blocks until reset expiry', async () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now + i);
    }

    const state = await store.getState(consumerUrl);
    expect(state?.state).toBe('open');
    expect(state?.consecutiveFailures).toBe(3);

    const blocked = await store.checkAndClaimAttempt(consumerUrl, policy, now + 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe('open');
  });

  it('transitions open -> half-open -> closed on successful probe', async () => {
    const now = 2_000_000;
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now);
    }

    const openState = await store.getState(consumerUrl);
    const probe = await store.checkAndClaimAttempt(consumerUrl, policy, openState!.resetAt);
    expect(probe.allowed).toBe(true);
    expect(probe.state).toBe('half-open');

    const secondProbe = await store.checkAndClaimAttempt(consumerUrl, policy, openState!.resetAt);
    expect(secondProbe.allowed).toBe(false);

    const closed = await store.recordSuccess(consumerUrl, policy);
    expect(closed.state).toBe('closed');
    expect(closed.consecutiveFailures).toBe(0);
  });

  it('re-opens when the half-open probe fails', async () => {
    const now = 3_000_000;
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now);
    }
    const openState = await store.getState(consumerUrl);
    await store.checkAndClaimAttempt(consumerUrl, policy, openState!.resetAt);

    const reopened = await store.recordFailure(consumerUrl, policy, openState!.resetAt + 1);
    expect(reopened.state).toBe('open');
  });

  it('shares breaker state across store instances (multi-dispatcher)', async () => {
    const storeA = new RedisWebhookCircuitBreakerStore(redis);
    const storeB = new RedisWebhookCircuitBreakerStore(redis);
    const now = 4_000_000;

    await storeA.recordFailure(consumerUrl, policy, now);
    await storeA.recordFailure(consumerUrl, policy, now + 1);
    await storeB.recordFailure(consumerUrl, policy, now + 2);

    const state = await storeB.getState(consumerUrl);
    expect(state?.state).toBe('open');
    await storeA.close();
    await storeB.close();
  });

  it('survives store recreation (restart simulation)', async () => {
    const now = 5_000_000;
    await store.recordFailure(consumerUrl, policy, now);
    await store.recordFailure(consumerUrl, policy, now + 1);
    await store.recordFailure(consumerUrl, policy, now + 2);
    await store.close();

    const restarted = new RedisWebhookCircuitBreakerStore(redis);
    const state = await restarted.getState(consumerUrl);
    expect(state?.state).toBe('open');
    await restarted.close();
  });

  it('returns null state for unknown consumers', async () => {
    expect(await store.getState('https://unknown.example/hooks')).toBeNull();
  });

  it('fails open when Redis is unavailable', async () => {
    redis.throwOnNext('get');
    const result = await store.checkAndClaimAttempt(consumerUrl, policy);
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('closed');
  });

  it('treats corrupt Redis payloads as closed', async () => {
    const key = `${WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX}${hashConsumerUrl(consumerUrl)}`;
    await redis.set(key, '{not-json');
    const result = await store.checkAndClaimAttempt(consumerUrl, policy);
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('closed');
  });

  it('denies half-open probe when another instance holds the probe lock', async () => {
    const now = 6_000_000;
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now);
    }
    const openState = await store.getState(consumerUrl);
    const probeKey = `${WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX}${hashConsumerUrl(consumerUrl)}`;
    await redis.set(probeKey, 'other-instance');

    const blocked = await store.checkAndClaimAttempt(consumerUrl, policy, openState!.resetAt);
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe('half-open');
  });

  it('increments failures without opening below threshold', async () => {
    const state = await store.recordFailure(consumerUrl, policy, Date.now());
    expect(state.state).toBe('closed');
    expect(state.consecutiveFailures).toBe(1);
  });

  it('ignores breaker when threshold is disabled', async () => {
    const disabled = { ...policy, circuitBreakerThreshold: 0 };
    const result = await store.checkAndClaimAttempt(consumerUrl, disabled);
    expect(result.allowed).toBe(true);
  });
});

describe('InMemoryWebhookCircuitBreakerStore', () => {
  it('mirrors open/half-open/closed transitions in-process', async () => {
    const memory = new InMemoryWebhookCircuitBreakerStore();
    const now = 7_000_000;
    await memory.recordFailure(consumerUrl, policy, now);
    await memory.recordFailure(consumerUrl, policy, now);
    const opened = await memory.recordFailure(consumerUrl, policy, now);
    expect(opened.state).toBe('open');

    const probe = await memory.checkAndClaimAttempt(consumerUrl, policy, opened.resetAt);
    expect(probe.allowed).toBe(true);
    const reopened = await memory.recordFailure(consumerUrl, policy, opened.resetAt + 1);
    expect(reopened.state).toBe('open');
    await memory.recordSuccess(consumerUrl, policy);
    expect((await memory.getState(consumerUrl))?.state).toBe('closed');
    await memory.close();
  });

  it('uses singleton fallback when Redis store is not wired', async () => {
    setWebhookCircuitBreakerStore(new InMemoryWebhookCircuitBreakerStore());
    const singleton = getWebhookCircuitBreakerStore();
    const allowed = await singleton.checkAndClaimAttempt(consumerUrl, policy);
    expect(allowed.allowed).toBe(true);
    await singleton.close();
    setWebhookCircuitBreakerStore(null);
  });
});

describe('Circuit Breaker Store Concurrency and Lifecycle (Shared Semantics)', () => {
  const urls = [
    'https://consumer-a.example/webhooks',
    'https://consumer-b.example/webhooks',
  ];

  const runSharedSuite = (getStore: () => WebhookCircuitBreakerStore, isRedis: boolean) => {
    let store: WebhookCircuitBreakerStore;

    beforeEach(() => {
      store = getStore();
    });

    afterEach(async () => {
      await store.close();
    });

    it('enforces exactly one probe admitted per URL under concurrency', async () => {
      const now = 10_000_000;
      const targetUrl = urls[0];

      // Move URL to open state
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(targetUrl, policy, now + i * 1000);
      }

      const openState = await store.getState(targetUrl);
      expect(openState?.state).toBe('open');

      // Attempt to claim probe concurrently
      const results = await Promise.all([
        store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt),
        store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt),
        store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt),
      ]);

      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(1);

      const allowedResult = results.find((r) => r.allowed);
      expect(allowedResult?.state).toBe('half-open');

      const deniedResults = results.filter((r) => !r.allowed);
      expect(deniedResults).toHaveLength(2);
      for (const res of deniedResults) {
        expect(res.state).toBe('half-open');
      }
    });

    it('ensures concurrent probes for two different URLs do not interfere', async () => {
      const now = 20_000_000;
      const urlA = urls[0];
      const urlB = urls[1];

      // Open both URL A and URL B
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(urlA, policy, now + i * 1000);
        await store.recordFailure(urlB, policy, now + i * 1000);
      }

      const stateA = await store.getState(urlA);
      const stateB = await store.getState(urlB);

      expect(stateA?.state).toBe('open');
      expect(stateB?.state).toBe('open');

      // Claim concurrently for different URLs
      const [resA, resB] = await Promise.all([
        store.checkAndClaimAttempt(urlA, policy, stateA!.resetAt),
        store.checkAndClaimAttempt(urlB, policy, stateB!.resetAt),
      ]);

      expect(resA.allowed).toBe(true);
      expect(resA.state).toBe('half-open');
      expect(resB.allowed).toBe(true);
      expect(resB.state).toBe('half-open');
    });

    it('resets probe state correctly after successful probe', async () => {
      const now = 30_000_000;
      const targetUrl = urls[0];

      // Open
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(targetUrl, policy, now + i * 1000);
      }

      const openState = await store.getState(targetUrl);
      const probeRes = await store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt);
      expect(probeRes.allowed).toBe(true);

      // Record success
      await store.recordSuccess(targetUrl, policy);

      const stateAfterSuccess = await store.getState(targetUrl);
      expect(stateAfterSuccess?.state).toBe('closed');
      expect(stateAfterSuccess?.consecutiveFailures).toBe(0);

      // Verify a new probe is not active and the circuit is closed (allowed = true, state = closed)
      const checkRes = await store.checkAndClaimAttempt(targetUrl, policy, now);
      expect(checkRes.allowed).toBe(true);
      expect(checkRes.state).toBe('closed');
    });

    it('resets probe state correctly after failed probe', async () => {
      const now = 40_000_000;
      const targetUrl = urls[0];

      // Open
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(targetUrl, policy, now + i * 1000);
      }

      const openState1 = await store.getState(targetUrl);
      const probeRes1 = await store.checkAndClaimAttempt(targetUrl, policy, openState1!.resetAt);
      expect(probeRes1.allowed).toBe(true);

      // Record failure (re-opens circuit)
      const recordFailTime = openState1!.resetAt + 1000;
      const reopenState = await store.recordFailure(targetUrl, policy, recordFailTime);
      expect(reopenState.state).toBe('open');

      // Now that it has failed, the probe state is cleared.
      // After resetAt is reached again, we should be able to claim a new probe.
      const probeRes2 = await store.checkAndClaimAttempt(targetUrl, policy, reopenState.resetAt);
      expect(probeRes2.allowed).toBe(true);
      expect(probeRes2.state).toBe('half-open');
    });

    it('repeated concurrent probes for the same URL behave correctly', async () => {
      const now = 50_000_000;
      const targetUrl = urls[0];

      // 1. Open
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(targetUrl, policy, now + i * 1000);
      }

      let openState = await store.getState(targetUrl);

      // 2. Claim concurrently (Cycle 1)
      const results1 = await Promise.all([
        store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt),
        store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt),
      ]);
      expect(results1.filter(r => r.allowed)).toHaveLength(1);

      // 3. Complete probe with failure
      const failTime = openState!.resetAt + 1000;
      openState = await store.recordFailure(targetUrl, policy, failTime);
      expect(openState.state).toBe('open');

      // 4. Claim concurrently again (Cycle 2)
      const results2 = await Promise.all([
        store.checkAndClaimAttempt(targetUrl, policy, openState.resetAt),
        store.checkAndClaimAttempt(targetUrl, policy, openState.resetAt),
      ]);
      expect(results2.filter(r => r.allowed)).toHaveLength(1);
    });

    it('probe expires and allows another probe', async () => {
      const now = 60_000_000;
      const targetUrl = urls[0];

      // Open
      for (let i = 0; i < 3; i++) {
        await store.recordFailure(targetUrl, policy, now + i * 1000);
      }

      const openState = await store.getState(targetUrl);
      
      // Claim first probe
      const firstProbe = await store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt);
      expect(firstProbe.allowed).toBe(true);

      // Try to claim another probe immediately (should be denied)
      const immediateSecond = await store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt);
      expect(immediateSecond.allowed).toBe(false);

      // Reset the state to 'open' to simulate that the first probe did not complete
      // and we want to retry. (If state remains 'half-open', subsequent checks are blocked by state).
      if (isRedis) {
        const stateKey = `${WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX}${hashConsumerUrl(targetUrl)}`;
        const record = { state: 'open' as const, consecutiveFailures: 3, resetAt: openState!.resetAt };
        await (store as any).client.set(stateKey, JSON.stringify(record));
      } else {
        (store as any).states.set(hashConsumerUrl(targetUrl), { state: 'open', consecutiveFailures: 3, resetAt: openState!.resetAt });
      }

      // If we check now, it should still be blocked because the probe lock/key is still active
      const stillBlocked = await store.checkAndClaimAttempt(targetUrl, policy, openState!.resetAt);
      expect(stillBlocked.allowed).toBe(false);

      // Now simulate expiration of the probe lock:
      if (isRedis) {
        const probeKey = `${WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX}${hashConsumerUrl(targetUrl)}`;
        await (store as any).client.del(probeKey);
      }

      const checkTime = isRedis ? openState!.resetAt : openState!.resetAt + 65_000;
      const afterExpiry = await store.checkAndClaimAttempt(targetUrl, policy, checkTime);
      
      // It should be allowed now because the probe lock expired/was cleared!
      expect(afterExpiry.allowed).toBe(true);
      expect(afterExpiry.state).toBe('half-open');
    });
  };

  describe('InMemoryWebhookCircuitBreakerStore', () => {
    runSharedSuite(() => new InMemoryWebhookCircuitBreakerStore(), false);
  });

  describe('RedisWebhookCircuitBreakerStore', () => {
    let redis: FakeRedisClient;
    beforeEach(() => {
      redis = new FakeRedisClient();
    });
    afterEach(() => {
      redis.reset();
    });
    runSharedSuite(() => new RedisWebhookCircuitBreakerStore(redis), true);
  });
});

describe('checkWebhookDeliveryGate / attemptWebhookDeliveryWithRateLimit', () => {
  let redis: FakeRedisClient;
  let store: RedisWebhookCircuitBreakerStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    store = new RedisWebhookCircuitBreakerStore(redis);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(async () => {
    await store.close();
    redis.reset();
    vi.restoreAllMocks();
  });

  it('defers delivery when the circuit is open', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now);
    }

    const gate = await checkWebhookDeliveryGate(consumerUrl, policy, { circuitBreakerStore: store }, now + 1000);
    expect(gate.canDeliver).toBe(false);
    expect(gate.circuitBreakerOpen).toBe(true);
    expect(gate.retryAt).not.toBeNull();
  });

  it('always returns a retry time for half-open probe contention', async () => {
    const now = 9_000_000;
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now);
    }
    await store.checkAndClaimAttempt(consumerUrl, policy, now + 60_000);

    const gate = await checkWebhookDeliveryGate(consumerUrl, policy, { circuitBreakerStore: store }, now + 60_000);
    expect(gate.canDeliver).toBe(false);
    expect(gate.retryAt).toEqual(new Date(now + 60_000 + HALF_OPEN_CONTENTION_DEFERRAL_MS));
  });

  it('does not count permanent HTTP failures toward the breaker', async () => {
    const attempt = { attemptNumber: 1, timestamp: Date.now(), statusCode: 404 };
    expect(countsTowardCircuitBreaker(attempt, policy)).toBe(false);

    const deliver = vi.fn(async () => attempt);
    await attemptWebhookDeliveryWithRateLimit(
      {
        consumerUrl,
        streamId: 's1',
        eventType: 'stream.created',
        payload: { id: 'evt-404' },
        attemptNumber: 1,
        policy,
      },
      deliver,
      { circuitBreakerStore: store },
    );

    const state = await store.getState(consumerUrl);
    expect(state).toBeNull();
  });

  it('records breaker failures via attemptWebhookDeliveryWithRateLimit', async () => {
    const deliver = vi.fn(async () => ({
      attemptNumber: 1,
      timestamp: Date.now(),
      statusCode: 500,
    }));

    const result = await attemptWebhookDeliveryWithRateLimit(
      {
        consumerUrl,
        streamId: 's1',
        eventType: 'stream.created',
        payload: { id: 'evt-1' },
        attemptNumber: 1,
        policy,
      },
      deliver,
      { circuitBreakerStore: store },
    );

    expect(deliver).toHaveBeenCalledOnce();
    expect(result.shouldRetry).toBe(true);
    const state = await store.getState(consumerUrl);
    expect(state?.consecutiveFailures).toBe(1);
  });

  it('stops retrying when breaker threshold blocks shouldRetry', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await store.recordFailure(consumerUrl, policy, now);
    }

    const attempt = { attemptNumber: 1, timestamp: now, statusCode: 500 };
    expect(shouldRetry(attempt, 1, policy, 3)).toBe(false);
  });

  it('schedules durable outbox retries with incremented attempt metadata', () => {
    const now = Date.now();
    const plan = scheduleWebhookOutboxRetry({
      streamId: 'stream-1',
      eventType: 'stream.created',
      payload: { id: 'evt-1' },
      attemptNumber: 1,
      policy,
      now,
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retryAt).toEqual(new Date(now + 2000));
    expect(plan.payload).toMatchObject({ id: 'evt-1', _webhookRetry: { attemptNumber: 2 } });
  });
});
