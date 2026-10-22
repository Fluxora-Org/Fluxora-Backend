/**
 * Unit coverage for `src/redis/webhookCircuitBreakerStore.ts` (issue #1803).
 *
 * The suites under `tests/webhooks/` drive the breaker through the dispatcher
 * and retry flows; this file pins the module's own contract, beside the source:
 *
 *   - every exported function and class method gets a normal-path test;
 *   - every failure mode documented in the module header/JSDoc is asserted:
 *     Redis errors fail open and are logged, corrupt payloads read back as
 *     `closed`, a disabled breaker (threshold `0`) short-circuits without
 *     touching Redis, a single half-open probe is admitted per window, and an
 *     abandoned probe is recovered only by state-record expiry;
 *   - boundary inputs are covered — empty consumer URL, zero/negative/max
 *     thresholds, the exact threshold count, `resetAt` equality, zero and
 *     sub-second reset windows, TTL floor vs. doubling;
 *   - nothing touches the network (`FakeRedisClient` is in-process) and no
 *     assertion depends on the wall clock (`Date.now` is pinned to `T0` and
 *     `now` is passed explicitly wherever a method accepts it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisClient } from './__test__/fakeRedisClient.js';
import { logger } from '../lib/logger.js';
import {
  DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS,
  DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD,
  InMemoryWebhookCircuitBreakerStore,
  RedisWebhookCircuitBreakerStore,
  WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX,
  WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS,
  WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX,
  WEBHOOK_CIRCUIT_BREAKER_STATE_TTL_FLOOR_MS,
  createWebhookCircuitBreakerStore,
  describeWebhookCircuitBreaker,
  getWebhookCircuitBreakerStore,
  hashConsumerUrl,
  setWebhookCircuitBreakerStore,
  transitionsTotal,
  webhookRateLimiterFailOpenTotal,
  type CircuitBreakerPolicy,
  type WebhookCircuitBreakerRecord,
  type WebhookCircuitBreakerStore,
} from './webhookCircuitBreakerStore.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RECEIVER = 'https://receiver.example/webhooks';
const OTHER_RECEIVER = 'https://other-receiver.example/webhooks';

/** Baseline timestamp, far from real time; `Date.now` is pinned to it. */
const T0 = 1_700_000_000_000;

/** Documented policy: open after 3 consecutive failures, 60 s open window. */
const THRESHOLD = 3;
const RESET_MS = 60_000;
const policy: CircuitBreakerPolicy = {
  circuitBreakerThreshold: THRESHOLD,
  circuitBreakerResetMs: RESET_MS,
};

/** State-record retention for this policy: max(2 × 60 s, 5 min) = 5 min. */
const STATE_TTL_MS = 300_000;

const stateKey = (url: string): string =>
  `${WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX}${hashConsumerUrl(url)}`;
const probeKey = (url: string): string =>
  `${WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX}${hashConsumerUrl(url)}`;

/** Pin the wall clock so default-parameter paths stay deterministic. */
function pinClock(): void {
  vi.spyOn(Date, 'now').mockReturnValue(T0);
}

/** A full record built from partial input; defaults mirror `parse()`. */
function recordOf(partial: Partial<WebhookCircuitBreakerRecord> = {}): WebhookCircuitBreakerRecord {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    resetAt: 0,
    lastFailureAt: null,
    expiresAt: 0,
    ...partial,
  };
}

/** Drive any store from `closed` to `open`; returns the final record. */
async function openCircuit(
  store: WebhookCircuitBreakerStore,
  url = RECEIVER,
  at = T0
): Promise<WebhookCircuitBreakerRecord> {
  let last: WebhookCircuitBreakerRecord = recordOf();
  for (let i = 0; i < THRESHOLD; i += 1) {
    last = await store.recordFailure(url, policy, at + i);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Exported constants and metric exports
// ---------------------------------------------------------------------------

describe('exported constants and metric exports', () => {
  it('documents the breaker as disabled by default (threshold 0)', () => {
    expect(DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD).toBe(0);
  });

  it('documents a 5-minute default open window', () => {
    expect(DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS).toBe(300_000);
  });

  it('bounds the probe lock at 60 s and state retention at the 5-minute floor', () => {
    expect(WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS).toBe(60_000);
    expect(WEBHOOK_CIRCUIT_BREAKER_STATE_TTL_FLOOR_MS).toBe(300_000);
    // The floor equals the default reset window, as documented.
    expect(WEBHOOK_CIRCUIT_BREAKER_STATE_TTL_FLOOR_MS).toBe(
      DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS
    );
  });

  it('namespaces state and probe keys under distinct prefixes', () => {
    expect(WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX).toBe('webhook_cb:');
    expect(WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX).toBe('webhook_cb_probe:');
    expect(WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX).not.toBe(WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX);
  });

  it('exports the transition counter and the fail-open counter for scrapers', () => {
    expect(typeof transitionsTotal.inc).toBe('function');
    expect(typeof webhookRateLimiterFailOpenTotal.inc).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// hashConsumerUrl
// ---------------------------------------------------------------------------

describe('hashConsumerUrl', () => {
  it('returns a stable 16-character lowercase hex digest', () => {
    const first = hashConsumerUrl(RECEIVER);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(hashConsumerUrl(RECEIVER)).toBe(first);
  });

  it('distinguishes different consumer URLs', () => {
    expect(hashConsumerUrl(RECEIVER)).not.toBe(hashConsumerUrl(OTHER_RECEIVER));
    expect(hashConsumerUrl(RECEIVER)).not.toBe(hashConsumerUrl(`${RECEIVER}/`));
  });

  it('hashes the empty input without throwing (boundary: empty)', () => {
    const empty = hashConsumerUrl('');
    expect(empty).toMatch(/^[0-9a-f]{16}$/);
    expect(empty).not.toBe(hashConsumerUrl(' '));
  });

  it('never embeds the raw URL — hostile characters stay out of the digest', () => {
    expect(hashConsumerUrl('https://evil/redis\nkey')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashConsumerUrl('https://例え.テスト/フック')).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// describeWebhookCircuitBreaker — the status served by
// GET /internal/webhooks/circuit-breakers
// ---------------------------------------------------------------------------

describe('describeWebhookCircuitBreaker', () => {
  beforeEach(() => pinClock());
  afterEach(() => vi.restoreAllMocks());

  it('reports no pause and the disabled-by-default policy for a consumer with no record', () => {
    const status = describeWebhookCircuitBreaker(null, {}, T0);
    expect(status).toEqual({
      state: 'closed',
      paused: false,
      reason: 'deliveries-allowed',
      consecutiveFailures: 0,
      threshold: 0,
      resetMs: 300_000,
      lastFailureAt: null,
      resumeAt: null,
    });
  });

  it('reflects the effective policy thresholds in the status', () => {
    const status = describeWebhookCircuitBreaker(
      null,
      { circuitBreakerThreshold: 7, circuitBreakerResetMs: 10_000 },
      T0
    );
    expect(status.threshold).toBe(7);
    expect(status.resetMs).toBe(10_000);
  });

  it('keeps a closed circuit with counted failures available (reason deliveries-allowed)', () => {
    const status = describeWebhookCircuitBreaker(
      recordOf({ consecutiveFailures: 2, lastFailureAt: T0 - 5_000 }),
      policy,
      T0
    );
    expect(status).toMatchObject({
      state: 'closed',
      paused: false,
      reason: 'deliveries-allowed',
      consecutiveFailures: 2,
      lastFailureAt: T0 - 5_000,
      resumeAt: null,
    });
  });

  it('pauses an open circuit until resetAt (reason failure-threshold)', () => {
    const status = describeWebhookCircuitBreaker(
      recordOf({
        state: 'open',
        consecutiveFailures: 3,
        resetAt: T0 + RESET_MS,
        lastFailureAt: T0,
      }),
      policy,
      T0
    );
    expect(status).toMatchObject({
      state: 'open',
      paused: true,
      reason: 'failure-threshold',
      consecutiveFailures: 3,
      lastFailureAt: T0,
      resumeAt: T0 + RESET_MS,
    });
  });

  it('reports the open window as elapsed at exactly resetAt (boundary: equality)', () => {
    const resetAt = T0 + RESET_MS;
    const atReset = describeWebhookCircuitBreaker(
      recordOf({ state: 'open', consecutiveFailures: 3, resetAt }),
      policy,
      resetAt
    );
    expect(atReset).toMatchObject({ paused: false, reason: 'reset-elapsed', resumeAt: null });

    const justBefore = describeWebhookCircuitBreaker(
      recordOf({ state: 'open', consecutiveFailures: 3, resetAt }),
      policy,
      resetAt - 1
    );
    expect(justBefore).toMatchObject({
      paused: true,
      reason: 'failure-threshold',
      resumeAt: resetAt,
    });
  });

  it('defaults `now` to the pinned clock when omitted', () => {
    const status = describeWebhookCircuitBreaker(
      recordOf({ state: 'open', resetAt: T0 + 1 }),
      policy
    );
    expect(status).toMatchObject({ paused: true, resumeAt: T0 + 1 });
  });

  it('reports the record expiry as resumeAt while half-open (reason half-open-probe-in-flight)', () => {
    const status = describeWebhookCircuitBreaker(
      recordOf({ state: 'half-open', consecutiveFailures: 3, expiresAt: T0 + STATE_TTL_MS }),
      policy,
      T0
    );
    expect(status).toMatchObject({
      state: 'half-open',
      paused: true,
      reason: 'half-open-probe-in-flight',
      consecutiveFailures: 3,
      resumeAt: T0 + STATE_TTL_MS,
    });
  });

  it.each([
    [
      'a reset window above the cap',
      DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS,
      WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS,
    ],
    ['a reset window below the cap', 10_000, 10_000],
  ])(
    'bounds an abandoned probe by the probe-lock cap for %s (legacy record without expiresAt)',
    (_label: string, resetMs: number, expectedResumeInMs: number) => {
      const status = describeWebhookCircuitBreaker(
        recordOf({ state: 'half-open', consecutiveFailures: 3, expiresAt: 0 }),
        { circuitBreakerThreshold: THRESHOLD, circuitBreakerResetMs: resetMs },
        T0
      );
      expect(status.paused).toBe(true);
      expect(status.reason).toBe('half-open-probe-in-flight');
      expect(status.resumeAt).toBe(T0 + expectedResumeInMs);
    }
  );
});

// ---------------------------------------------------------------------------
// RedisWebhookCircuitBreakerStore — normal paths
// ---------------------------------------------------------------------------

describe('RedisWebhookCircuitBreakerStore', () => {
  let redis: FakeRedisClient;
  let store: RedisWebhookCircuitBreakerStore;

  beforeEach(() => {
    pinClock();
    redis = new FakeRedisClient();
    store = new RedisWebhookCircuitBreakerStore(redis);
    transitionsTotal.reset();
  });

  afterEach(async () => {
    await store.close();
    vi.restoreAllMocks();
  });

  describe('checkAndClaimAttempt', () => {
    it('admits an attempt on a consumer with no recorded state (reads Redis)', async () => {
      const getSpy = vi.spyOn(redis, 'get');
      const result = await store.checkAndClaimAttempt(RECEIVER, policy, T0);
      expect(result).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 0,
        resetAt: null,
      });
      expect(getSpy).toHaveBeenCalledOnce();
    });

    it('reports accumulated failures while the circuit is still closed', async () => {
      await store.recordFailure(RECEIVER, policy, T0);
      await store.recordFailure(RECEIVER, policy, T0 + 1);
      const result = await store.checkAndClaimAttempt(RECEIVER, policy, T0 + 2);
      expect(result).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 2,
        resetAt: null,
      });
    });

    it('denies delivery throughout the open window', async () => {
      const opened = await openCircuit(store);
      expect(opened.state).toBe('open');

      const denied = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt - 1);
      expect(denied).toEqual({
        allowed: false,
        state: 'open',
        consecutiveFailures: THRESHOLD,
        resetAt: opened.resetAt,
      });
    });

    it('admits exactly one half-open probe at resetAt (resetAt is exclusive)', async () => {
      const opened = await openCircuit(store);

      const justBefore = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt - 1);
      expect(justBefore.allowed).toBe(false);

      const probe = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect(probe).toEqual({
        allowed: true,
        state: 'half-open',
        consecutiveFailures: THRESHOLD,
        resetAt: null,
      });

      // The claim persists a half-open record with the documented retention.
      expect(await store.getState(RECEIVER)).toEqual(
        recordOf({
          state: 'half-open',
          consecutiveFailures: THRESHOLD,
          lastFailureAt: T0 + (THRESHOLD - 1),
          expiresAt: opened.resetAt + STATE_TTL_MS,
        })
      );
    });

    it('denies a second claimant once the probe is in flight', async () => {
      const opened = await openCircuit(store);
      await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);

      const second = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect(second).toEqual({
        allowed: false,
        state: 'half-open',
        consecutiveFailures: THRESHOLD,
        resetAt: null,
      });
    });

    it('denies a claimant when another replica already holds the probe lock but the state is still open', async () => {
      const opened = await openCircuit(store);
      await redis.set(probeKey(RECEIVER), 'other-instance');

      const denied = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect(denied).toEqual({
        allowed: false,
        state: 'half-open',
        consecutiveFailures: THRESHOLD,
        resetAt: opened.resetAt,
      });
      // The losing claimant does not rewrite the state record.
      expect((await store.getState(RECEIVER))?.state).toBe('open');
    });

    it('keeps denying while half-open even when the probe lock is gone', async () => {
      const opened = await openCircuit(store);
      await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      // Documented: the probe lock alone does not re-open the gate — delivery
      // stays denied on the state record until the probe reports an outcome.
      await redis.del(probeKey(RECEIVER));

      const blocked = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt + 1);
      expect(blocked).toEqual({
        allowed: false,
        state: 'half-open',
        consecutiveFailures: THRESHOLD,
        resetAt: null,
      });
    });

    it('returns to closed when the half-open state record expires (abandoned probe)', async () => {
      const opened = await openCircuit(store);
      await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect((await store.getState(RECEIVER))?.state).toBe('half-open');

      // State-record expiry is the documented hard upper bound on a stuck
      // half-open pause; an expired record reads back as `closed`.
      await redis.del(stateKey(RECEIVER));
      expect(await store.getState(RECEIVER)).toBeNull();

      const afterExpiry = await store.checkAndClaimAttempt(
        RECEIVER,
        policy,
        opened.resetAt + STATE_TTL_MS
      );
      expect(afterExpiry).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 0,
        resetAt: null,
      });
    });

    it.each([0, -1])(
      'always allows when the breaker is disabled (threshold %s), without reading Redis',
      async (threshold) => {
        const getSpy = vi.spyOn(redis, 'get');
        const result = await store.checkAndClaimAttempt(
          RECEIVER,
          { ...policy, circuitBreakerThreshold: threshold },
          T0
        );
        expect(result).toEqual({
          allowed: true,
          state: 'closed',
          consecutiveFailures: 0,
          resetAt: null,
        });
        expect(getSpy).not.toHaveBeenCalled();
      }
    );

    it('allows an open circuit immediately when the operator disables the breaker', async () => {
      await openCircuit(store);
      expect((await store.getState(RECEIVER))?.state).toBe('open');

      const getSpy = vi.spyOn(redis, 'get');
      const result = await store.checkAndClaimAttempt(
        RECEIVER,
        { circuitBreakerThreshold: 0, circuitBreakerResetMs: RESET_MS },
        T0 + 1
      );
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('closed');
      expect(getSpy).not.toHaveBeenCalled();
    });
  });

  describe('recordFailure', () => {
    it('counts a failure below the threshold without pausing traffic', async () => {
      const next = await store.recordFailure(RECEIVER, policy, T0);
      expect(next).toEqual(
        recordOf({ consecutiveFailures: 1, lastFailureAt: T0, expiresAt: T0 + STATE_TTL_MS })
      );
      expect((await store.getState(RECEIVER))?.state).toBe('closed');
    });

    it('opens at exactly the threshold-th failure (boundary: equality)', async () => {
      await store.recordFailure(RECEIVER, policy, T0);
      const second = await store.recordFailure(RECEIVER, policy, T0);
      expect(second.state).toBe('closed');
      expect(second.consecutiveFailures).toBe(2);

      const third = await store.recordFailure(RECEIVER, policy, T0);
      expect(third).toEqual(
        recordOf({
          state: 'open',
          consecutiveFailures: 3,
          resetAt: T0 + RESET_MS,
          lastFailureAt: T0,
          expiresAt: T0 + STATE_TTL_MS,
        })
      );
    });

    it('opens on the first failure when the threshold is 1 (boundary: minimum)', async () => {
      const next = await store.recordFailure(
        RECEIVER,
        { ...policy, circuitBreakerThreshold: 1 },
        T0
      );
      expect(next.state).toBe('open');
      expect(next.resetAt).toBe(T0 + RESET_MS);
    });

    it('never opens for a threshold beyond any reachable count (boundary: maximum)', async () => {
      const huge = { ...policy, circuitBreakerThreshold: Number.MAX_SAFE_INTEGER };
      let last = recordOf();
      for (let i = 0; i < 50; i += 1) {
        last = await store.recordFailure(RECEIVER, huge, T0 + i);
      }
      expect(last.state).toBe('closed');
      expect(last.consecutiveFailures).toBe(50);
    });

    it('extends resetAt when a failure arrives while already open', async () => {
      const disabledOne = { ...policy, circuitBreakerThreshold: 1 };
      const first = await store.recordFailure(RECEIVER, disabledOne, T0);
      expect(first.resetAt).toBe(T0 + RESET_MS);

      const extended = await store.recordFailure(RECEIVER, disabledOne, T0 + 10_000);
      expect(extended.state).toBe('open');
      expect(extended.consecutiveFailures).toBe(2);
      expect(extended.resetAt).toBe(T0 + 10_000 + RESET_MS);
      expect(extended.lastFailureAt).toBe(T0 + 10_000);
    });

    it('re-opens on a failed probe, keeps the probe failure count, and releases the probe lock', async () => {
      const opened = await openCircuit(store);
      await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect(await redis.exists(probeKey(RECEIVER))).toBe(true);

      const reopened = await store.recordFailure(RECEIVER, policy, opened.resetAt + 1);
      expect(reopened.state).toBe('open');
      // Documented: a failed probe re-opens without inflating the count.
      expect(reopened.consecutiveFailures).toBe(THRESHOLD);
      expect(reopened.resetAt).toBe(opened.resetAt + 1 + RESET_MS);
      expect(await redis.exists(probeKey(RECEIVER))).toBe(false);
    });

    it.each([0, -5])(
      'is a no-op returning closed when the breaker is disabled (threshold %s)',
      async (threshold) => {
        const next = await store.recordFailure(
          RECEIVER,
          { ...policy, circuitBreakerThreshold: threshold },
          T0
        );
        expect(next).toEqual(recordOf());
        // Nothing is written while the breaker is disabled.
        expect(await store.getState(RECEIVER)).toBeNull();
      }
    );
  });

  describe('recordSuccess', () => {
    it('closes any circuit, resets failures, and releases the probe lock', async () => {
      const opened = await openCircuit(store);
      await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect(await redis.exists(probeKey(RECEIVER))).toBe(true);

      const next = await store.recordSuccess(RECEIVER, policy);
      expect(next).toEqual(recordOf({ expiresAt: T0 + STATE_TTL_MS }));
      expect(await store.getState(RECEIVER)).toMatchObject({
        state: 'closed',
        consecutiveFailures: 0,
      });
      expect(await redis.exists(probeKey(RECEIVER))).toBe(false);
    });

    it('writes a closed record for a consumer that has never failed', async () => {
      const next = await store.recordSuccess(RECEIVER, policy);
      expect(next).toEqual(recordOf({ expiresAt: T0 + STATE_TTL_MS }));
    });
  });

  describe('getState', () => {
    it('returns null for a consumer with no record', async () => {
      expect(await store.getState(OTHER_RECEIVER)).toBeNull();
    });

    it('returns null for an empty payload (boundary: empty)', async () => {
      await redis.set(stateKey(RECEIVER), '');
      expect(await store.getState(RECEIVER)).toBeNull();
    });

    it('round-trips the record written by recordFailure', async () => {
      const written = await store.recordFailure(RECEIVER, policy, T0);
      expect(await store.getState(RECEIVER)).toEqual(written);
    });

    it('normalizes a partial payload to full record defaults', async () => {
      await redis.set(stateKey(RECEIVER), JSON.stringify({ state: 'half-open' }));
      expect(await store.getState(RECEIVER)).toEqual(recordOf({ state: 'half-open' }));
    });

    it('reads a corrupt payload as closed', async () => {
      await redis.set(stateKey(RECEIVER), '{not-json');
      expect(await store.getState(RECEIVER)).toEqual(recordOf());
    });
  });

  describe('close', () => {
    it('closes the underlying Redis connection', async () => {
      const closeSpy = vi.spyOn(redis, 'close');
      await store.close();
      expect(closeSpy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Documented failure modes
  // -------------------------------------------------------------------------

  describe('documented failure modes', () => {
    let loggerError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    });

    it('checkAndClaimAttempt fails open on a Redis read error and logs it', async () => {
      redis.throwOnNext('get');
      const result = await store.checkAndClaimAttempt(RECEIVER, policy, T0);

      expect(result).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 0,
        resetAt: null,
      });
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('failing open'),
        undefined,
        expect.objectContaining({
          operation: 'checkAndClaimAttempt',
          consumerKey: hashConsumerUrl(RECEIVER),
          error: expect.any(String),
        })
      );
    });

    it('checkAndClaimAttempt fails open when the probe-lock SET NX errors', async () => {
      const opened = await openCircuit(store);
      redis.throwOnNext('setNx');

      const result = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
      expect(result).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 0,
        resetAt: null,
      });
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('failing open'),
        undefined,
        expect.objectContaining({ operation: 'checkAndClaimAttempt' })
      );
    });

    it('checkAndClaimAttempt treats a corrupt state payload as closed', async () => {
      await redis.set(stateKey(RECEIVER), '{not-json');
      const result = await store.checkAndClaimAttempt(RECEIVER, policy, T0);
      expect(result).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 0,
        resetAt: null,
      });
    });

    it('recordSuccess returns a closed record and logs when Redis errors', async () => {
      redis.throwOnNext('get');
      const result = await store.recordSuccess(RECEIVER, policy);

      expect(result).toEqual(recordOf());
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('recordSuccess'),
        undefined,
        expect.objectContaining({
          operation: 'recordSuccess',
          consumerKey: hashConsumerUrl(RECEIVER),
          error: expect.any(String),
        })
      );
    });

    it('recordFailure returns a closed record and logs when Redis errors on read', async () => {
      redis.throwOnNext('get');
      const result = await store.recordFailure(RECEIVER, policy, T0);

      expect(result).toEqual(recordOf());
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('recordFailure'),
        undefined,
        expect.objectContaining({
          operation: 'recordFailure',
          consumerKey: hashConsumerUrl(RECEIVER),
          error: expect.any(String),
        })
      );
    });

    it('recordFailure returns a closed record and logs when Redis errors mid-write', async () => {
      await store.recordFailure(RECEIVER, policy, T0);
      redis.throwOnNext('set');

      const result = await store.recordFailure(RECEIVER, policy, T0 + 1);
      expect(result).toEqual(recordOf());
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('recordFailure'),
        undefined,
        expect.objectContaining({ operation: 'recordFailure' })
      );
    });

    it('getState returns null silently when Redis errors', async () => {
      redis.throwOnNext('get');
      expect(await store.getState(RECEIVER)).toBeNull();
      expect(loggerError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Boundary inputs
  // -------------------------------------------------------------------------

  describe('boundary inputs', () => {
    it.each([
      ['empty string', ''],
      ['unicode host', 'https://例え.テスト/フック'],
      ['newline-bearing URL', 'https://evil/redis\nkey'],
    ])('records and reads state for a %s consumer URL', async (_label: string, url: string) => {
      const next = await store.recordFailure(url, policy, T0);
      expect(next.consecutiveFailures).toBe(1);
      expect(await store.getState(url)).toEqual(next);
      // The key is always the namespaced hash — raw URL bytes never reach it.
      expect(stateKey(url)).toMatch(/^webhook_cb:[0-9a-f]{16}$/);
      expect(await redis.get(stateKey(url))).not.toBeNull();
    });

    it.each([
      ['below the floor', 1_000, 300],
      ['at the floor (sub-second window rounds up)', 150_001, 301],
      ['doubled above the floor', 200_000, 400],
      ['default policy window', undefined, 600],
    ])(
      'retains the state record for max(2 × resetMs, floor): %s',
      async (_label, resetMs, expectedExSec) => {
        const effective = { circuitBreakerThreshold: 1, circuitBreakerResetMs: resetMs };
        const setSpy = vi.spyOn(redis, 'set');

        await store.recordFailure(RECEIVER, effective, T0);

        expect(setSpy).toHaveBeenCalledWith(stateKey(RECEIVER), expect.any(String), {
          ex: expectedExSec,
        });
      }
    );

    it.each([
      ['shorter than the cap', 5_000, 5_000],
      [
        'exactly the cap',
        WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS,
        WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS,
      ],
      ['longer than the cap', 600_000, WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS],
    ])(
      'bounds the probe lock when the reset window is %s',
      async (_label, resetMs, expectedPxMs) => {
        const effective = { circuitBreakerThreshold: 1, circuitBreakerResetMs: resetMs };
        await store.recordFailure(RECEIVER, effective, T0);
        const opened = await store.getState(RECEIVER);
        const setNxSpy = vi.spyOn(redis, 'setNx');

        const probe = await store.checkAndClaimAttempt(RECEIVER, effective, opened!.resetAt);

        expect(probe.allowed).toBe(true);
        expect(setNxSpy).toHaveBeenCalledWith(probeKey(RECEIVER), expect.any(String), expectedPxMs);
      }
    );

    it('admits a probe immediately when resetMs is 0 (boundary: zero)', async () => {
      const effective = { circuitBreakerThreshold: 1, circuitBreakerResetMs: 0 };
      const opened = await store.recordFailure(RECEIVER, effective, T0);
      expect(opened.resetAt).toBe(T0);

      // resetAt is exclusive, so now === resetAt is already claimable.
      const probe = await store.checkAndClaimAttempt(RECEIVER, effective, T0);
      expect(probe).toEqual({
        allowed: true,
        state: 'half-open',
        consecutiveFailures: 1,
        resetAt: null,
      });
    });

    it('keeps the 5-minute retention floor for a zero reset window (boundary: zero)', async () => {
      const setSpy = vi.spyOn(redis, 'set');
      await store.recordFailure(
        RECEIVER,
        { circuitBreakerThreshold: 1, circuitBreakerResetMs: 0 },
        T0
      );
      expect(setSpy).toHaveBeenCalledWith(stateKey(RECEIVER), expect.any(String), { ex: 300 });
    });
  });
});

// ---------------------------------------------------------------------------
// InMemoryWebhookCircuitBreakerStore — mirrors the Redis contract in-process
// ---------------------------------------------------------------------------

describe('InMemoryWebhookCircuitBreakerStore', () => {
  let store: InMemoryWebhookCircuitBreakerStore;

  beforeEach(() => {
    pinClock();
    store = new InMemoryWebhookCircuitBreakerStore();
    transitionsTotal.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts a failure below the threshold without pausing traffic', async () => {
    const next = await store.recordFailure(RECEIVER, policy, T0);
    expect(next).toEqual(
      recordOf({ consecutiveFailures: 1, lastFailureAt: T0, expiresAt: T0 + STATE_TTL_MS })
    );
    expect((await store.getState(RECEIVER))?.state).toBe('closed');
  });

  it('opens at exactly the threshold and denies until the window elapses', async () => {
    const opened = await openCircuit(store);
    expect(opened.state).toBe('open');
    expect(opened.resetAt).toBe(T0 + (THRESHOLD - 1) + RESET_MS);

    const denied = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt - 1);
    expect(denied).toEqual({
      allowed: false,
      state: 'open',
      consecutiveFailures: THRESHOLD,
      resetAt: opened.resetAt,
    });
  });

  it('admits exactly one half-open probe at resetAt and denies the rest', async () => {
    const opened = await openCircuit(store);

    const justBefore = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt - 1);
    expect(justBefore.allowed).toBe(false);

    const probe = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
    expect(probe).toEqual({
      allowed: true,
      state: 'half-open',
      consecutiveFailures: THRESHOLD,
      resetAt: null,
    });
    expect((await store.getState(RECEIVER))?.expiresAt).toBe(opened.resetAt + STATE_TTL_MS);

    const second = await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);
    expect(second).toEqual({
      allowed: false,
      state: 'half-open',
      consecutiveFailures: THRESHOLD,
      resetAt: null,
    });
  });

  it('keeps probe admission isolated per consumer URL', async () => {
    const opened = await openCircuit(store);
    await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);

    // A different receiver's circuit is untouched by the in-flight probe.
    const other = await store.checkAndClaimAttempt(OTHER_RECEIVER, policy, opened.resetAt);
    expect(other).toEqual({
      allowed: true,
      state: 'closed',
      consecutiveFailures: 0,
      resetAt: null,
    });

    const otherProbe = await store.recordFailure(OTHER_RECEIVER, policy, T0);
    expect(otherProbe.state).toBe('closed');
    expect((await store.getState(RECEIVER))?.state).toBe('half-open');
  });

  it('closes on success from any state, resets failures, and releases the probe', async () => {
    const opened = await openCircuit(store);
    await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);

    const next = await store.recordSuccess(RECEIVER, policy);
    expect(next).toEqual(recordOf({ expiresAt: T0 + STATE_TTL_MS }));

    // The released probe means the next closed-circuit failure counts from 1.
    const afterSuccess = await store.recordFailure(RECEIVER, policy, T0);
    expect(afterSuccess.consecutiveFailures).toBe(1);
  });

  it('re-opens on a failed probe and admits a fresh probe in the next window', async () => {
    const opened = await openCircuit(store);
    await store.checkAndClaimAttempt(RECEIVER, policy, opened.resetAt);

    const reopened = await store.recordFailure(RECEIVER, policy, opened.resetAt + 1);
    expect(reopened.state).toBe('open');
    expect(reopened.consecutiveFailures).toBe(THRESHOLD);

    const denied = await store.checkAndClaimAttempt(RECEIVER, policy, reopened.resetAt - 1);
    expect(denied.allowed).toBe(false);

    const retryProbe = await store.checkAndClaimAttempt(RECEIVER, policy, reopened.resetAt);
    expect(retryProbe.allowed).toBe(true);
    expect(retryProbe.state).toBe('half-open');
  });

  it.each([0, -1])(
    'returns closed without storing anything when the breaker is disabled (threshold %s)',
    async (threshold) => {
      const disabled = { ...policy, circuitBreakerThreshold: threshold };

      const check = await store.checkAndClaimAttempt(RECEIVER, disabled, T0);
      expect(check).toEqual({
        allowed: true,
        state: 'closed',
        consecutiveFailures: 0,
        resetAt: null,
      });

      const failure = await store.recordFailure(RECEIVER, disabled, T0);
      expect(failure).toEqual(recordOf());
      expect(await store.getState(RECEIVER)).toBeNull();
    }
  );

  it('returns null state for a consumer with no record', async () => {
    expect(await store.getState(OTHER_RECEIVER)).toBeNull();
  });

  it('forgets every circuit on close()', async () => {
    await openCircuit(store);
    await openCircuit(store, OTHER_RECEIVER);
    expect(await store.getState(RECEIVER)).not.toBeNull();

    await store.close();

    expect(await store.getState(RECEIVER)).toBeNull();
    expect(await store.getState(OTHER_RECEIVER)).toBeNull();
    const fresh = await store.checkAndClaimAttempt(RECEIVER, policy, T0);
    expect(fresh.allowed).toBe(true);
  });

  it('records and reads state for an empty consumer URL (boundary: empty)', async () => {
    let last = recordOf();
    for (let i = 0; i < THRESHOLD; i += 1) last = await store.recordFailure('', policy, T0 + i);
    expect(last.state).toBe('open');
    expect(await store.getState('')).toEqual(last);
    expect(await store.getState(' ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transition metrics — no-op re-entries are not counted (both implementations)
// ---------------------------------------------------------------------------

describe('transition metrics', () => {
  beforeEach(() => {
    pinClock();
    transitionsTotal.reset();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(['redis', 'memory'] as const)('counts only real transitions (%s)', async (kind) => {
    const redis = new FakeRedisClient();
    const store =
      kind === 'redis'
        ? new RedisWebhookCircuitBreakerStore(redis)
        : new InMemoryWebhookCircuitBreakerStore();
    const inc = vi.spyOn(transitionsTotal, 'inc');
    const fast = { circuitBreakerThreshold: 1, circuitBreakerResetMs: RESET_MS };

    await store.recordFailure(RECEIVER, fast, T0); // closed → open
    expect(inc).toHaveBeenCalledTimes(1);

    await store.recordFailure(RECEIVER, fast, T0 + 1); // open → open (no-op)
    expect(inc).toHaveBeenCalledTimes(1);

    // The no-op failure extended resetAt to T0 + 1 + RESET_MS; claim there.
    const opened = await store.getState(RECEIVER);
    const probe = await store.checkAndClaimAttempt(RECEIVER, fast, opened!.resetAt);
    expect(probe.allowed).toBe(true); // open → half-open
    expect(inc).toHaveBeenCalledTimes(2);

    await store.recordFailure(RECEIVER, fast, opened!.resetAt + 1); // half-open → open
    expect(inc).toHaveBeenCalledTimes(3);

    await store.recordSuccess(RECEIVER, fast); // open → closed
    expect(inc).toHaveBeenCalledTimes(4);

    await store.recordSuccess(RECEIVER, fast); // closed → closed (no-op)
    expect(inc).toHaveBeenCalledTimes(4);

    // A below-threshold failure never transitions either.
    await store.recordFailure(OTHER_RECEIVER, { ...fast, circuitBreakerThreshold: 5 }, T0);
    expect(inc).toHaveBeenCalledTimes(4);

    expect(inc).toHaveBeenLastCalledWith({
      from_state: 'open',
      to_state: 'closed',
      consumer_hash: hashConsumerUrl(RECEIVER),
    });
  });
});

// ---------------------------------------------------------------------------
// Store wiring: setWebhookCircuitBreakerStore / getWebhookCircuitBreakerStore /
// createWebhookCircuitBreakerStore
// ---------------------------------------------------------------------------

describe('store wiring', () => {
  afterEach(() => {
    setWebhookCircuitBreakerStore(null);
    vi.restoreAllMocks();
  });

  it('falls back to an in-memory singleton when no store is wired', () => {
    setWebhookCircuitBreakerStore(null);
    const first = getWebhookCircuitBreakerStore();
    expect(first).toBeInstanceOf(InMemoryWebhookCircuitBreakerStore);
    // The fallback is memoized — repeated reads return the same instance.
    expect(getWebhookCircuitBreakerStore()).toBe(first);
  });

  it('returns the explicitly wired store and creates a fresh fallback after unsetting', () => {
    const custom = new InMemoryWebhookCircuitBreakerStore();
    setWebhookCircuitBreakerStore(custom);
    expect(getWebhookCircuitBreakerStore()).toBe(custom);

    const replacement = new InMemoryWebhookCircuitBreakerStore();
    setWebhookCircuitBreakerStore(replacement);
    expect(getWebhookCircuitBreakerStore()).toBe(replacement);

    setWebhookCircuitBreakerStore(null);
    expect(getWebhookCircuitBreakerStore()).not.toBe(replacement);
    expect(getWebhookCircuitBreakerStore()).toBeInstanceOf(InMemoryWebhookCircuitBreakerStore);
  });

  it('createWebhookCircuitBreakerStore builds a Redis-backed store bound to the client', async () => {
    const redis = new FakeRedisClient();
    const created = createWebhookCircuitBreakerStore(redis);
    expect(created).toBeInstanceOf(RedisWebhookCircuitBreakerStore);

    const closeSpy = vi.spyOn(redis, 'close');
    await created.close();
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});
