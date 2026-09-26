/**
 * Webhook circuit breaker — documented state machine and thresholds (Issue #1435).
 *
 * The thresholds asserted here are the ones documented in `docs/webhooks.md`
 * ("Circuit breaker resilience") and in the module header of
 * `src/redis/webhookCircuitBreakerStore.ts`:
 *
 * - the circuit opens on the `circuitBreakerThreshold`-th consecutive retryable
 *   failure and stays open for `circuitBreakerResetMs`;
 * - one half-open probe is admitted once that window elapses;
 * - the probe's outcome closes the circuit or re-opens it for another window;
 * - a threshold of `0` disables the breaker entirely.
 *
 * Every transition is asserted against BOTH store implementations so the
 * shared (Redis) contract and the in-process fallback cannot drift.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  RedisWebhookCircuitBreakerStore,
  InMemoryWebhookCircuitBreakerStore,
  describeWebhookCircuitBreaker,
  setWebhookCircuitBreakerStore,
  DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS,
  WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS,
  type WebhookCircuitBreakerStore,
} from '../../src/redis/webhookCircuitBreakerStore.js';
import { attemptWebhookDeliveryWithRateLimit } from '../../src/webhooks/retry.js';
import { webhooksRouter } from '../../src/routes/webhooks.js';

// ── Documented policy under test ──────────────────────────────────────────────

const RECEIVER = 'https://receiver.example/webhooks';
const OTHER_RECEIVER = 'https://other-receiver.example/webhooks';

/** Threshold and reset window used by every transition assertion below. */
const THRESHOLD = 4;
const RESET_MS = 60_000;

/** State-record retention: `max(circuitBreakerResetMs * 2, 300000)`. */
const STATE_TTL_MS = 300_000;

const policy = {
  maxAttempts: 10,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
  jitterPercent: 0,
  timeoutMs: 5000,
  retryableStatusCodes: [500],
  circuitBreakerThreshold: THRESHOLD,
  circuitBreakerResetMs: RESET_MS,
};

/** Baseline timestamp; far from the real clock so `Date.now()` never leaks in. */
const T0 = 1_700_000_000_000;

async function driveToOpen(
  store: WebhookCircuitBreakerStore,
  url: string,
  at: number,
  count = THRESHOLD,
): Promise<number> {
  for (let i = 0; i < count; i++) {
    await store.recordFailure(url, policy, at + i);
  }
  return at + count - 1;
}

// ── Transition matrix, asserted for both store implementations ─────────────────

const runStateMachineSuite = (label: string, createStore: () => WebhookCircuitBreakerStore) => {
  describe(`${label} — documented transitions`, () => {
    let store: WebhookCircuitBreakerStore;

    beforeEach(() => {
      store = createStore();
    });

    afterEach(async () => {
      await store.close();
    });

    it('closed → closed: stays closed while consecutiveFailures < threshold', async () => {
      for (let i = 1; i < THRESHOLD; i++) {
        const record = await store.recordFailure(RECEIVER, policy, T0 + i);
        expect(record.state).toBe('closed');
        expect(record.consecutiveFailures).toBe(i);

        // Deliveries keep flowing below the threshold.
        const check = await store.checkAndClaimAttempt(RECEIVER, policy, T0 + i);
        expect(check.allowed).toBe(true);
        expect(check.state).toBe('closed');
      }

      const status = describeWebhookCircuitBreaker(await store.getState(RECEIVER), policy, T0);
      expect(status.paused).toBe(false);
      expect(status.reason).toBe('deliveries-allowed');
      expect(status.resumeAt).toBeNull();
    });

    it('closed → open: opens on exactly the threshold-th failure, for resetMs', async () => {
      const openedAt = await driveToOpen(store, RECEIVER, T0, THRESHOLD - 1);
      expect((await store.getState(RECEIVER))?.state).toBe('closed');

      const opened = await store.recordFailure(RECEIVER, policy, openedAt + 1);

      expect(opened.state).toBe('open');
      expect(opened.consecutiveFailures).toBe(THRESHOLD);
      expect(opened.resetAt).toBe(openedAt + 1 + RESET_MS);
    });

    it('open → open: a failure while open keeps the circuit open and extends the window', async () => {
      const lastFailureAt = await driveToOpen(store, RECEIVER, T0);
      const first = (await store.getState(RECEIVER))!;
      const failedAgainAt = lastFailureAt + RESET_MS / 2;

      const again = await store.recordFailure(RECEIVER, policy, failedAgainAt);

      expect(again.state).toBe('open');
      expect(again.consecutiveFailures).toBe(first.consecutiveFailures + 1);
      expect(again.resetAt).toBe(failedAgainAt + RESET_MS);
      expect(again.resetAt).toBeGreaterThan(first.resetAt);
    });

    it('open → half-open: admitted on the first attempt at resetAt, denied one ms before', async () => {
      await driveToOpen(store, RECEIVER, T0);
      const { resetAt } = (await store.getState(RECEIVER))!;

      const before = await store.checkAndClaimAttempt(RECEIVER, policy, resetAt - 1);
      expect(before.allowed).toBe(false);
      expect(before.state).toBe('open');
      expect(before.resetAt).toBe(resetAt);

      const probe = await store.checkAndClaimAttempt(RECEIVER, policy, resetAt);
      expect(probe.allowed).toBe(true);
      expect(probe.state).toBe('half-open');
      expect((await store.getState(RECEIVER))?.state).toBe('half-open');
    });

  it('half-open → half-open: only one probe is admitted while it is in flight', async () => {
    await driveToOpen(store, RECEIVER, T0);
    const { resetAt } = (await store.getState(RECEIVER))!;

    const claims = await Promise.all([
      store.checkAndClaimAttempt(RECEIVER, policy, resetAt),
      store.checkAndClaimAttempt(RECEIVER, policy, resetAt),
      store.checkAndClaimAttempt(RECEIVER, policy, resetAt),
    ]);

    expect(claims.filter((c) => c.allowed)).toHaveLength(1);
    for (const denied of claims.filter((c) => !c.allowed)) {
      expect(denied.state).toBe('half-open');
    }

    // The loser stays blocked even after the probe lock's own TTL has passed:
    // the circuit is still half-open and no outcome has been recorded. Only the
    // state record's expiry returns the receiver to `closed`.
    const halfOpen = (await store.getState(RECEIVER))!;
    expect(halfOpen.expiresAt).toBe(resetAt + STATE_TTL_MS);

    const afterProbeLock = await store.checkAndClaimAttempt(
      RECEIVER,
      policy,
      resetAt + WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS,
    );
    expect(afterProbeLock.allowed).toBe(false);
    expect(afterProbeLock.state).toBe('half-open');

    const status = describeWebhookCircuitBreaker(halfOpen, policy, resetAt);
    expect(status.paused).toBe(true);
    expect(status.reason).toBe('half-open-probe-in-flight');
    expect(status.resumeAt).toBe(halfOpen.expiresAt);
  });


    it('half-open → closed: a successful probe closes the circuit and clears the counter', async () => {
      await driveToOpen(store, RECEIVER, T0);
      const { resetAt } = (await store.getState(RECEIVER))!;
      await store.checkAndClaimAttempt(RECEIVER, policy, resetAt);

      const closed = await store.recordSuccess(RECEIVER, policy);

      expect(closed.state).toBe('closed');
      expect(closed.consecutiveFailures).toBe(0);
      expect(closed.resetAt).toBe(0);
      expect(closed.lastFailureAt).toBeNull();

      // The probe lock is released, so a fresh failure starts counting from zero.
      const next = await store.recordFailure(RECEIVER, policy, resetAt + 1);
      expect(next.state).toBe('closed');
      expect(next.consecutiveFailures).toBe(1);
    });

    it('half-open → open: a failed probe re-opens the circuit for another resetMs', async () => {
      await driveToOpen(store, RECEIVER, T0);
      const { resetAt, consecutiveFailures } = (await store.getState(RECEIVER))!;
      await store.checkAndClaimAttempt(RECEIVER, policy, resetAt);

      const reopened = await store.recordFailure(RECEIVER, policy, resetAt + 1);

      expect(reopened.state).toBe('open');
      expect(reopened.consecutiveFailures).toBe(consecutiveFailures);
      expect(reopened.resetAt).toBe(resetAt + 1 + RESET_MS);
    });

    it('half-open → open → half-open: the next reset window admits a fresh probe', async () => {
      await driveToOpen(store, RECEIVER, T0);
      const first = (await store.getState(RECEIVER))!;
      await store.checkAndClaimAttempt(RECEIVER, policy, first.resetAt);
      const reopened = await store.recordFailure(RECEIVER, policy, first.resetAt + 1);

      const denied = await store.checkAndClaimAttempt(RECEIVER, policy, reopened.resetAt - 1);
      expect(denied.allowed).toBe(false);

      const second = await store.checkAndClaimAttempt(RECEIVER, policy, reopened.resetAt);
      expect(second.allowed).toBe(true);
      expect(second.state).toBe('half-open');
    });

    it('tracks circuit state independently per receiver URL', async () => {
      await driveToOpen(store, RECEIVER, T0);

      expect((await store.getState(RECEIVER))?.state).toBe('open');
      expect(await store.getState(OTHER_RECEIVER)).toBeNull();

      const other = await store.checkAndClaimAttempt(OTHER_RECEIVER, policy, T0);
      expect(other.allowed).toBe(true);
      expect(other.state).toBe('closed');

      const healthy = await store.recordFailure(OTHER_RECEIVER, policy, T0);
      expect(healthy.consecutiveFailures).toBe(1);
    });

    it('never opens or pauses when the threshold is disabled (0)', async () => {
      const disabled = { ...policy, circuitBreakerThreshold: 0 };

      for (let i = 0; i < 10; i++) {
        expect((await store.recordFailure(RECEIVER, disabled, T0 + i)).state).toBe('closed');
        expect((await store.checkAndClaimAttempt(RECEIVER, disabled, T0 + i)).allowed).toBe(true);
      }

      const status = describeWebhookCircuitBreaker(await store.getState(RECEIVER), disabled, T0);
      expect(status.threshold).toBe(0);
      expect(status.paused).toBe(false);
      expect(status.reason).toBe('deliveries-allowed');
    });

    it('records the time of the last failure for observability', async () => {
      await driveToOpen(store, RECEIVER, T0, 2);

      const record = (await store.getState(RECEIVER))!;
      expect(record.lastFailureAt).toBe(T0 + 1);

      const status = describeWebhookCircuitBreaker(record, policy, T0 + 1);
      expect(status.lastFailureAt).toBe(T0 + 1);
    });
  });
};

describe('Webhook circuit breaker state machine', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
  });

  afterEach(() => {
    redis.reset();
  });

  runStateMachineSuite('RedisWebhookCircuitBreakerStore', () => new RedisWebhookCircuitBreakerStore(redis));
  runStateMachineSuite('InMemoryWebhookCircuitBreakerStore', () => new InMemoryWebhookCircuitBreakerStore());
});

// ── Why a receiver's deliveries are paused ────────────────────────────────────

describe('describeWebhookCircuitBreaker — pause reporting', () => {
  const openRecord = {
    state: 'open' as const,
    consecutiveFailures: THRESHOLD,
    resetAt: T0 + RESET_MS,
    lastFailureAt: T0,
    expiresAt: T0 + STATE_TTL_MS,
  };
  const halfOpenRecord = {
    state: 'half-open' as const,
    consecutiveFailures: THRESHOLD,
    resetAt: 0,
    lastFailureAt: T0,
    expiresAt: T0 + RESET_MS + STATE_TTL_MS,
  };

  it('reports an open circuit as paused by the failure threshold, resuming at resetAt', () => {
    const status = describeWebhookCircuitBreaker(openRecord, policy, T0);

    expect(status.state).toBe('open');
    expect(status.paused).toBe(true);
    expect(status.reason).toBe('failure-threshold');
    expect(status.resumeAt).toBe(openRecord.resetAt);
    expect(status.consecutiveFailures).toBe(THRESHOLD);
    expect(status.threshold).toBe(THRESHOLD);
    expect(status.resetMs).toBe(RESET_MS);
  });

  it('reports "reset-elapsed" once the open window has passed but no probe is claimed', () => {
    const status = describeWebhookCircuitBreaker(openRecord, policy, openRecord.resetAt);

    expect(status.paused).toBe(false);
    expect(status.reason).toBe('reset-elapsed');
    expect(status.resumeAt).toBeNull();
  });

  it('reports half-open as paused by the in-flight probe, bounded by the state record expiry', () => {
    const now = T0 + RESET_MS;
    const status = describeWebhookCircuitBreaker(halfOpenRecord, policy, now);

    expect(status.paused).toBe(true);
    expect(status.reason).toBe('half-open-probe-in-flight');
    expect(status.resumeAt).toBe(halfOpenRecord.expiresAt);
  });

  it('falls back to the probe-lock bound for a half-open record with no expiry', () => {
    const now = T0 + RESET_MS;
    const status = describeWebhookCircuitBreaker({ ...halfOpenRecord, expiresAt: 0 }, policy, now);

    expect(status.resumeAt).toBe(now + Math.min(RESET_MS, WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS));
  });

  it('reports a closed circuit as delivering normally', () => {
    const status = describeWebhookCircuitBreaker(
      { state: 'closed', consecutiveFailures: 2, resetAt: 0, lastFailureAt: T0, expiresAt: T0 + STATE_TTL_MS },
      policy,
      T0,
    );

    expect(status.paused).toBe(false);
    expect(status.reason).toBe('deliveries-allowed');
    expect(status.resumeAt).toBeNull();
  });

  it('reports an unknown receiver as closed and falling back to the documented defaults', () => {
    const status = describeWebhookCircuitBreaker(null, {}, T0);

    expect(status.state).toBe('closed');
    expect(status.paused).toBe(false);
    expect(status.reason).toBe('deliveries-allowed');
    expect(status.threshold).toBe(DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD);
    expect(status.resetMs).toBe(DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS);
  });
});

// ── Validation: drive a receiver to failure through the delivery gate ─────────

describe('A receiver driven to failure follows the documented transitions', () => {
  let store: WebhookCircuitBreakerStore;

  beforeEach(() => {
    store = new InMemoryWebhookCircuitBreakerStore();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(async () => {
    await store.close();
    vi.restoreAllMocks();
  });

  /** One full delivery attempt through the rate-limit + circuit-breaker gate. */
  const deliverOnce = (now: number, statusCode = 500) =>
    attemptWebhookDeliveryWithRateLimit(
      {
        consumerUrl: RECEIVER,
        streamId: 'stream-1',
        eventType: 'stream.created',
        payload: { id: 'evt-1' },
        attemptNumber: 1,
        policy,
        now,
      },
      async () => ({ attemptNumber: 1, timestamp: now, statusCode }),
      { circuitBreakerStore: store },
    );

  it('opens at the threshold, pauses with a resume time, then recovers via a probe', async () => {
    const failing = vi.fn(async () => ({ attemptNumber: 1, timestamp: T0, statusCode: 500 }));

    // Failures below the threshold are delivered and only counted.
    for (let i = 1; i < THRESHOLD; i++) {
      const plan = await attemptWebhookDeliveryWithRateLimit(
        { consumerUrl: RECEIVER, streamId: 's', eventType: 'stream.created', payload: {}, attemptNumber: i, policy, now: T0 },
        failing,
        { circuitBreakerStore: store },
      );
      expect(plan.attempt?.statusCode).toBe(500);
      expect((await store.getState(RECEIVER))?.state).toBe('closed');
    }
    expect(failing).toHaveBeenCalledTimes(THRESHOLD - 1);

    // The threshold-th failure is delivered and opens the circuit.
    const openedPlan = await attemptWebhookDeliveryWithRateLimit(
      { consumerUrl: RECEIVER, streamId: 's', eventType: 'stream.created', payload: {}, attemptNumber: THRESHOLD, policy, now: T0 },
      failing,
      { circuitBreakerStore: store },
    );
    expect(openedPlan.attempt?.statusCode).toBe(500);
    expect(failing).toHaveBeenCalledTimes(THRESHOLD);

    const open = (await store.getState(RECEIVER))!;
    expect(open.state).toBe('open');
    expect(open.consecutiveFailures).toBe(THRESHOLD);
    expect(open.resetAt).toBe(T0 + RESET_MS);

    // Deliveries are paused: no HTTP call is made and the retry is deferred to resetAt.
    const paused = await deliverOnce(T0 + 1);
    expect(failing).toHaveBeenCalledTimes(THRESHOLD);
    expect(paused.attempt).toBeUndefined();
    expect(paused.shouldRetry).toBe(true);
    expect(paused.retryAt).toEqual(new Date(open.resetAt));

    const statusWhilePaused = describeWebhookCircuitBreaker(await store.getState(RECEIVER), policy, T0 + 1);
    expect(statusWhilePaused.paused).toBe(true);
    expect(statusWhilePaused.reason).toBe('failure-threshold');
    expect(statusWhilePaused.resumeAt).toBe(open.resetAt);

    // Once the window elapses, exactly one probe is delivered — and it succeeds.
    const probe = await deliverOnce(open.resetAt, 200);
    expect(failing).toHaveBeenCalledTimes(THRESHOLD);
    expect(probe.attempt?.statusCode).toBe(200);

    const recovered = (await store.getState(RECEIVER))!;
    expect(recovered.state).toBe('closed');
    expect(recovered.consecutiveFailures).toBe(0);
    expect(describeWebhookCircuitBreaker(recovered, policy, open.resetAt).reason).toBe('deliveries-allowed');
  });

  it('keeps the circuit open when the half-open probe also fails', async () => {
    await deliverOnce(T0);
    await deliverOnce(T0);
    await deliverOnce(T0);
    await deliverOnce(T0);

    const open = (await store.getState(RECEIVER))!;
    expect(open.state).toBe('open');

    const probe = await deliverOnce(open.resetAt, 500);
    expect(probe.attempt?.statusCode).toBe(500);

    const reopened = (await store.getState(RECEIVER))!;
    expect(reopened.state).toBe('open');
    expect(reopened.resetAt).toBe(open.resetAt + RESET_MS);
  });
});

// ── Observability: a receiver can be told why delivery is paused ──────────────

describe('GET /internal/webhooks/circuit-breakers — per-receiver observability', () => {
  const ADMIN_KEY = 'test-admin-key-circuit-breaker-state';
  const BASE = '/internal/webhooks';
  const app = express();
  let store: WebhookCircuitBreakerStore;
  let originalAdminKey: string | undefined;
  let originalThreshold: string | undefined;
  let originalResetMs: string | undefined;

  beforeEach(() => {
    originalAdminKey = process.env.ADMIN_API_KEY;
    originalThreshold = process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;
    originalResetMs = process.env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD = String(THRESHOLD);
    process.env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS = String(RESET_MS);

    app.use(BASE, webhooksRouter);
    store = new InMemoryWebhookCircuitBreakerStore();
    setWebhookCircuitBreakerStore(store);
  });

  afterEach(async () => {
    await store.close();
    setWebhookCircuitBreakerStore(null);
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
    if (originalThreshold === undefined) delete process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;
    else process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD = originalThreshold;
    if (originalResetMs === undefined) delete process.env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
    else process.env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS = originalResetMs;
  });

  const getState = (url: string) =>
    request(app)
      .get(`${BASE}/circuit-breakers`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .query({ endpointUrl: url });

  it('reports deliveries as flowing for a receiver with no recorded state', async () => {
    const res = await getState(RECEIVER);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.states[0]).toMatchObject({
      endpointUrl: RECEIVER,
      state: 'closed',
      paused: false,
      reason: 'deliveries-allowed',
      consecutiveFailures: 0,
      threshold: THRESHOLD,
      resetMs: RESET_MS,
      lastFailureTime: null,
      resumeAt: null,
    });
  });

  it('tells the receiver why deliveries are paused and when they resume', async () => {
    // The route reads the real clock, so drive the failures relative to it.
    await driveToOpen(store, RECEIVER, Date.now());
    const open = (await store.getState(RECEIVER))!;
    expect(open.state).toBe('open');

    const res = await getState(RECEIVER);
    const state = res.body.states[0];

    expect(res.status).toBe(200);
    expect(state).toMatchObject({
      state: 'open',
      paused: true,
      reason: 'failure-threshold',
      consecutiveFailures: THRESHOLD,
      failureCount: THRESHOLD,
      threshold: THRESHOLD,
      resetMs: RESET_MS,
      lastFailureTime: new Date(open.lastFailureAt!).toISOString(),
      resumeAt: new Date(open.resetAt).toISOString(),
    });
    expect(state.nextAttemptTime).toBe(state.resumeAt);
    expect(res.body.observedAt).toEqual(expect.any(String));
  });

  it('reports half-open probe contention as the pause reason', async () => {
    const base = Date.now();
    await driveToOpen(store, RECEIVER, base);
    const open = (await store.getState(RECEIVER))!;
    await store.checkAndClaimAttempt(RECEIVER, policy, open.resetAt);

    const res = await getState(RECEIVER);

    expect(res.status).toBe(200);
    expect(res.body.states[0]).toMatchObject({
      state: 'half-open',
      paused: true,
      reason: 'half-open-probe-in-flight',
    });
    expect(res.body.states[0].resumeAt).not.toBeNull();
  });

  it('reports the receiver as healthy after a manual reset', async () => {
    await driveToOpen(store, RECEIVER, Date.now());
    expect((await store.getState(RECEIVER))?.state).toBe('open');

    const res = await request(app)
      .post(`${BASE}/circuit-breakers/${encodeURIComponent(RECEIVER)}/reset`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.states[0]).toMatchObject({ state: 'closed', paused: false, reason: 'deliveries-allowed' });
    expect((await store.getState(RECEIVER))?.state).toBe('closed');
  });
});
