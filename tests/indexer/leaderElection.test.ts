import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  NoOpLeaderElection,
  RedisIndexerLeaderElection,
  initializeIndexerLeaderElection,
  getIndexerLeaderElection,
  _resetIndexerLeaderElection,
} from '../../src/indexer/leaderElection.js';

describe('NoOpLeaderElection', () => {
  it('always reports leadership and never rejects', async () => {
    const noop = new NoOpLeaderElection();
    expect(noop.isLeader()).toBe(true);
    await expect(noop.tryAcquire()).resolves.toBe(true);
    expect(noop.isLeader()).toBe(true);
    await expect(noop.release()).resolves.toBeUndefined();
  });
});

describe('RedisIndexerLeaderElection', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    redis.reset();
  });

  it('acquires the lease when the key is absent', async () => {
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    expect(le.isLeader()).toBe(false);
    await expect(le.tryAcquire()).resolves.toBe(true);
    expect(le.isLeader()).toBe(true);
  });

  it('fails to acquire when another instance already holds the lease', async () => {
    const holder = new RedisIndexerLeaderElection(redis, { instanceId: 'holder' });
    await expect(holder.tryAcquire()).resolves.toBe(true);

    const challenger = new RedisIndexerLeaderElection(redis, { instanceId: 'challenger' });
    await expect(challenger.tryAcquire()).resolves.toBe(false);
    expect(challenger.isLeader()).toBe(false);
    // The original holder is unaffected.
    expect(holder.isLeader()).toBe(true);
  });

  it('is idempotent for the current holder (repeated tryAcquire by the same instance succeeds)', async () => {
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    await expect(le.tryAcquire()).resolves.toBe(true);
    // A second call from the SAME instance must not be treated as a failed
    // acquisition just because the key already exists (setNx would fail) —
    // callers such as resumeIncompleteReplay() followed by replayEvents()
    // both call tryAcquire() on the same instance in sequence.
    await expect(le.tryAcquire()).resolves.toBe(true);
    expect(le.isLeader()).toBe(true);
  });

  it('generates distinct instanceIds by default so concurrently-started replicas do not collide', () => {
    const a = new RedisIndexerLeaderElection(redis);
    const b = new RedisIndexerLeaderElection(redis);
    expect((a as unknown as { instanceId: string }).instanceId).not.toBe(
      (b as unknown as { instanceId: string }).instanceId,
    );
  });

  it('fails safe (not leader) when setNx throws', async () => {
    redis.throwOnNext('setNx', 'simulated redis outage');
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    await expect(le.tryAcquire()).resolves.toBe(false);
    expect(le.isLeader()).toBe(false);
  });

  it('renews the lease via PEXPIRE on heartbeat while still the holder', async () => {
    const leaseMs = 9000;

    // FakeRedisClient stores TTLs but never enforces expiry (by design — see
    // its doc comment), so the only reliable way to prove renewal actually
    // fired is to intercept the PEXPIRE call itself rather than relying on
    // key expiry.
    const pexpireCalls: Array<[string, number]> = [];
    const originalMulti = redis.multi.bind(redis);
    vi.spyOn(redis, 'multi').mockImplementation(() => {
      const pipeline = originalMulti();
      const originalPexpire = pipeline.pexpire.bind(pipeline);
      pipeline.pexpire = (key: string, ms: number) => {
        pexpireCalls.push([key, ms]);
        return originalPexpire(key, ms);
      };
      return pipeline;
    });

    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    await le.tryAcquire();

    // Advance past one heartbeat tick (renewIntervalMs = leaseMs / 3).
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(true);
    expect(pexpireCalls).toContainEqual(['indexer:leader-election:replay', leaseMs]);
  });

  it('drops leadership when another instance has taken over the key (lease expired)', async () => {
    const leaseMs = 9000;
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    await le.tryAcquire();
    expect(le.isLeader()).toBe(true);

    // Simulate our lease having actually expired and a different instance
    // taking over, out from under us.
    await redis.del('indexer:leader-election:replay');
    await redis.setNx('indexer:leader-election:replay', 'other-instance', leaseMs);

    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(false);
  });

  it('drops leadership when the heartbeat PEXPIRE fails', async () => {
    const leaseMs = 9000;
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    await le.tryAcquire();

    redis.throwOnNext('pexpire', 'simulated redis outage during renewal');
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(false);
  });

  it('release() deletes the key when we still hold it, and stops the heartbeat', async () => {
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs: 9000 });
    await le.tryAcquire();

    await le.release();

    expect(le.isLeader()).toBe(false);
    await expect(redis.exists('indexer:leader-election:replay')).resolves.toBe(false);

    // No further heartbeat renewal should occur post-release.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(redis.exists('indexer:leader-election:replay')).resolves.toBe(false);
  });

  it('release() does not delete a lease now held by a different instance', async () => {
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs: 9000 });
    await le.tryAcquire();

    // Someone else took over between our last successful renewal and release()
    // (our lease had already expired).
    await redis.del('indexer:leader-election:replay');
    await redis.setNx('indexer:leader-election:replay', 'other-instance', 9000);

    await le.release();

    await expect(redis.get('indexer:leader-election:replay')).resolves.toBe('other-instance');
  });

  it('release() swallows errors', async () => {
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs: 9000 });
    await le.tryAcquire();
    redis.throwOnNext('get', 'simulated redis outage during release');
    await expect(le.release()).resolves.toBeUndefined();
  });
});

describe('RedisIndexerLeaderElection — multiple instance competition', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    redis.reset();
  });

  it('instance B acquires leadership after instance A lease expires', async () => {
    const leaseMs = 9000;
    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs });

    // A acquires first.
    await a.tryAcquire();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);

    // A's heartbeat renewal stops working (simulating Redis outage / lease expiry).
    // A's key expires and B successfully acquires.
    await redis.del('indexer:leader-election:replay');
    const acquired = await b.tryAcquire();
    expect(acquired).toBe(true);
    expect(b.isLeader()).toBe(true);

    // Advance timers so A's heartbeat fires — A should detect it no longer holds the key.
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(a.isLeader()).toBe(false);
  });

  it('two instances both calling tryAcquire concurrently — only one wins', async () => {
    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs: 15_000 });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs: 15_000 });

    // Both attempt simultaneously (sequentially in test, but key is absent for both).
    const resultA = await a.tryAcquire();
    // The second call to tryAcquire fails because A already holds the key.
    const resultB = await b.tryAcquire();

    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
  });

  it('release by one instance allows the other to acquire', async () => {
    const leaseMs = 9000;
    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs });

    await a.tryAcquire();
    expect(a.isLeader()).toBe(true);

    // A releases gracefully.
    await a.release();
    expect(a.isLeader()).toBe(false);

    // B can now acquire.
    const acquired = await b.tryAcquire();
    expect(acquired).toBe(true);
    expect(b.isLeader()).toBe(true);
  });

  /**
   * Concurrent-takeover regression test for the check-then-act race in
   * renew() and release().
   *
   * Forces the exact window where:
   *   1. Instance A's heartbeat fires and `get` confirms A still holds the key.
   *   2. Between A's `get` and A's `pexpire`, the lease expires and B acquires.
   *   3. A's stale `pexpire` executes, inadvertently extending B's lease.
   *
   * The dual-leadership window must be bounded to at most one renewIntervalMs:
   * on the next heartbeat, A's `get` returns B's instanceId, A drops leadership
   * and stops the heartbeat. See docs/indexer.md §"Security note — non-atomic
   * renew/release" for why this risk is accepted.
   *
   * @see docs/indexer.md line ~295
   */
  it('renew() check-then-act race: stale pexpire after B takes over — A recovers within one interval', async () => {
    const leaseMs = 9000;
    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs });

    // A acquires first.
    await a.tryAcquire();
    expect(a.isLeader()).toBe(true);

    // Simulate A's lease expiring and B legitimately acquiring.
    await redis.del('indexer:leader-election:replay');
    await b.tryAcquire();
    expect(b.isLeader()).toBe(true);

    // Spy on redis.get to simulate A seeing stale data on its next heartbeat:
    // A's `get` returns 'a' (the value A expects) even though B now holds the key.
    // This forces exactly the race: A's get succeeds (stale), then A's pexpire
    // fires and extends B's lease.
    let staleReturned = false;
    const originalGet = redis.get.bind(redis);
    vi.spyOn(redis, 'get').mockImplementation(async (key: string) => {
      if (key === 'indexer:leader-election:replay' && !staleReturned) {
        staleReturned = true;
        return 'a';
      }
      return originalGet(key);
    });

    // Advance one interval: A's heartbeat fires, spy returns 'a' (stale view),
    // A proceeds to pexpire which extends B's lease. A still thinks it's leader.
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(true);

    // Advance another interval: A's heartbeat fires again, this time get returns 'b'
    // (no spy interference), A detects B holds the key and drops leadership.
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(a.isLeader()).toBe(false);
    expect(b.isLeader()).toBe(true);
    await expect(redis.get('indexer:leader-election:replay')).resolves.toBe('b');
  });

  /**
   * release() check-then-act safety: release() never deletes a lease key that
   * has since been legitimately re-acquired by a different instance.
   *
   * This is called out explicitly in the docs/indexer.md risk write-up:
   * the check-then-act pattern in release() could, in theory, delete a
   * re-acquired lease. The existing test "release() does not delete a lease
   * now held by a different instance" above proves it does not by simulating
   * the takeover before release() is invoked (no spy needed).
   *
   * @see tests/indexer/leaderElection.test.ts "release() does not delete a lease now held by a different instance"
   * @see docs/indexer.md §"Security note — non-atomic renew/release"
   */
  it('release() check-then-act: never deletes a lease re-acquired by another instance', async () => {
    const leaseMs = 9000;
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    await le.tryAcquire();

    // Simulate the race: our lease expired, and B legitimately acquired before
    // we called release(). The check-then-act in release() MUST see B's value
    // and skip the DEL.
    await redis.del('indexer:leader-election:replay');
    await redis.setNx('indexer:leader-election:replay', 'other-instance', leaseMs);

    await le.release();

    await expect(redis.get('indexer:leader-election:replay')).resolves.toBe('other-instance');
  });
});

describe('default leader election accessor', () => {
  afterEach(() => {
    _resetIndexerLeaderElection();
  });

  it('defaults to NoOpLeaderElection', () => {
    expect(getIndexerLeaderElection()).toBeInstanceOf(NoOpLeaderElection);
  });

  it('initializeIndexerLeaderElection swaps in a Redis-backed instance', () => {
    const redis = new FakeRedisClient();
    initializeIndexerLeaderElection(redis, { instanceId: 'a' });
    expect(getIndexerLeaderElection()).toBeInstanceOf(RedisIndexerLeaderElection);
  });

  it('_resetIndexerLeaderElection restores the NoOp default', () => {
    const redis = new FakeRedisClient();
    initializeIndexerLeaderElection(redis);
    _resetIndexerLeaderElection();
    expect(getIndexerLeaderElection()).toBeInstanceOf(NoOpLeaderElection);
  });
});

// =============================================================================
// Clock-anomaly regression tests
//
// These tests verify the behaviour introduced by the injectable `clockNowMs`
// option and the forward-jump guard in `renew()`.
//
// Design recap
// ------------
// Lease expiry is enforced by the **Redis server** (via SET … PX / PEXPIRE).
// The local clock is used only to detect missed-renewal windows:
//
//   • Forward jump / GC pause / VM resume: if `clockNowMs()` advances by more
//     than `leaseMs` between two consecutive heartbeat ticks, the process
//     conservatively self-revokes without contacting Redis.
//
//   • Backward jump (NTP step-back, reboot): elapsed time is clamped to zero
//     when the current reading is less than the previous one, so a backward
//     step never causes a spurious self-revocation.
//
//   • Delayed / just-in-time renewal: elapsed time between 0 and leaseMs is
//     normal; no self-revocation occurs regardless of how close to the
//     boundary the heartbeat fires.
//
//   • Fencing token: each fresh lease acquisition atomically increments a
//     shared counter.  A stale leader retains its old (lower) token so the
//     write store can reject it and prevent split-brain commits.
// =============================================================================

describe('RedisIndexerLeaderElection — clock-anomaly regression', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    redis.reset();
  });

  // ---------------------------------------------------------------------------
  // Forward clock jump — missed renewal window
  // ---------------------------------------------------------------------------

  it('self-revokes when a forward clock jump exceeds the lease duration (missed renewal)', async () => {
    const leaseMs = 9000;
    let now = 1_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();
    expect(le.isLeader()).toBe(true);

    // Simulate a forward clock jump of exactly leaseMs: the full lease has
    // elapsed since the last renewal attempt, so the Redis TTL has certainly
    // expired. The heartbeat fires but the guard must self-revoke before
    // contacting Redis.
    now += leaseMs;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(false);
    // The leader key must not have been deleted (it is no longer ours to delete).
    await expect(redis.exists('indexer:leader-election:replay')).resolves.toBe(true);
  });

  it('self-revokes when a forward clock jump exceeds leaseMs by more than 2×', async () => {
    const leaseMs = 6000;
    let now = 5_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'leader-x',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();
    expect(le.isLeader()).toBe(true);

    // Jump forward by 2× leaseMs (e.g. VM suspend for 12 s with a 6 s lease).
    now += leaseMs * 2;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(false);
  });

  it('does NOT self-revoke on a forward clock advance that is less than the lease duration', async () => {
    const leaseMs = 9000;
    let now = 1_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();

    // Advance local clock by one renewInterval (leaseMs / 3 − 1 ms).
    // This is a normal heartbeat — well under the leaseMs threshold.
    now += Math.floor(leaseMs / 3) - 1;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    // Must still be leader — no false self-revocation.
    expect(le.isLeader()).toBe(true);
  });

  it('boundary: clock elapsed exactly equal to leaseMs causes self-revocation', async () => {
    const leaseMs = 6000;
    let now = 2_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'boundary',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();

    // Exactly leaseMs elapsed since last renewal — the guard condition is
    // `elapsed >= leaseMs`, so this must trigger self-revocation.
    now += leaseMs;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Backward clock jump — must not cause spurious self-revocation
  // ---------------------------------------------------------------------------

  it('does NOT self-revoke on a backward clock jump (NTP step-back)', async () => {
    const leaseMs = 9000;
    let now = 5_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();
    expect(le.isLeader()).toBe(true);

    // Step the clock BACKWARD by 2 seconds — simulates an NTP correction or
    // monotonic counter reset.  Elapsed time must be clamped to zero by the
    // `Math.max(0, …)` in the guard, so no self-revocation fires.
    now -= 2000;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(true);
  });

  it('backward jump followed by a normal advance does not accumulate ghost elapsed time', async () => {
    // Ensures that after a backward jump the baseline is reset correctly so
    // the *next* heartbeat does not see a spuriously large elapsed value.
    const leaseMs = 9000;
    let now = 5_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();

    // First heartbeat — normal advance.
    now += Math.floor(leaseMs / 3) - 1;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(le.isLeader()).toBe(true);

    // Backward jump — clocks steps back 3 s.
    now -= 3000;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(le.isLeader()).toBe(true); // no self-revocation

    // Another normal advance of renewInterval.
    now += Math.floor(leaseMs / 3) - 1;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(le.isLeader()).toBe(true); // still leader, not falsely revoked
  });

  // ---------------------------------------------------------------------------
  // Delayed renewal — just before the boundary
  // ---------------------------------------------------------------------------

  it('delayed renewal just below the leaseMs threshold does not self-revoke', async () => {
    // Models a heartbeat that fires very late — one millisecond before the
    // full lease duration — but still in time to avoid self-revocation.
    const leaseMs = 12_000;
    let now = 1_000_000;
    const clockNowMs = () => now;

    const le = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    await le.tryAcquire();

    // Advance local clock by leaseMs − 1 ms (one ms short of triggering the guard).
    now += leaseMs - 1;
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);

    expect(le.isLeader()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Instance restart — fencing token ensures write authorisation
  // ---------------------------------------------------------------------------

  it('fencing token is 0 before any acquisition', () => {
    const le = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    expect(le.getFencingToken()).toBe(0);
  });

  it('fencing token increments on each fresh acquisition epoch', async () => {
    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b' });

    await a.tryAcquire();
    const tokenA1 = a.getFencingToken();
    expect(tokenA1).toBeGreaterThan(0);

    // A releases; B acquires — new epoch, higher token.
    await a.release();
    await b.tryAcquire();
    const tokenB = b.getFencingToken();
    expect(tokenB).toBeGreaterThan(tokenA1);
  });

  it('after restart: new acquisition gets a strictly greater fencing token than the pre-restart epoch', async () => {
    // Scenario:
    //   1. Instance A acquires (epoch 1, token = 1).
    //   2. A crashes / lease expires.
    //   3. B acquires (epoch 2, token = 2).
    //   4. A restarts and tries to acquire — it loses because B holds the key.
    //   5. After B releases, A re-acquires (epoch 3, token = 3).
    //
    // Any write from "A epoch 1" carries token 1, which must be less than 3
    // and therefore rejected by the write store.

    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b' });

    // Epoch 1 — A acquires.
    await a.tryAcquire();
    const preRestartToken = a.getFencingToken();
    expect(preRestartToken).toBe(1);

    // A's lease expires (simulate by deleting the key).
    await redis.del('indexer:leader-election:replay');

    // Epoch 2 — B acquires.
    await b.tryAcquire();
    const tokenB = b.getFencingToken();
    expect(tokenB).toBe(2);

    // "A restarts" — new RedisIndexerLeaderElection object.
    const aRestarted = new RedisIndexerLeaderElection(redis, { instanceId: 'a' });
    const failedReacquire = await aRestarted.tryAcquire();
    expect(failedReacquire).toBe(false);
    expect(aRestarted.getFencingToken()).toBe(0); // never set — B still holds

    // B releases, then A-restarted acquires.
    await b.release();
    await aRestarted.tryAcquire();
    const postRestartToken = aRestarted.getFencingToken();
    expect(postRestartToken).toBe(3);

    // The pre-restart token is strictly less than the new epoch token.
    expect(postRestartToken).toBeGreaterThan(preRestartToken);
  });

  // ---------------------------------------------------------------------------
  // Split-brain prevention via fencing tokens
  // ---------------------------------------------------------------------------

  it('split-brain: stale leader retains a lower fencing token after new leader takes over', async () => {
    // Scenario:
    //   1. A acquires (token = 1).
    //   2. A appears to freeze (simulated by a forward clock jump).
    //   3. B acquires (token = 2).
    //   4. A's next heartbeat self-revokes due to the forward-jump guard.
    //
    // After step 4, A.getFencingToken() is still 1 and B.getFencingToken() is 2.
    // Any write store that checks token > maxSeen must accept B's writes
    // and reject A's writes — no split-brain.

    const leaseMs = 9000;
    let now = 1_000_000;
    const clockNowMs = () => now;

    const a = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs });

    // Step 1: A acquires.
    await a.tryAcquire();
    expect(a.isLeader()).toBe(true);
    expect(a.getFencingToken()).toBe(1);

    // Step 2: Simulate A being frozen — delete its key so B can acquire,
    // then forward the local clock past the lease boundary.
    await redis.del('indexer:leader-election:replay');
    now += leaseMs; // forward jump — A missed its renewal window

    // Step 3: B acquires while A's clock is still "in the jump".
    await b.tryAcquire();
    expect(b.isLeader()).toBe(true);
    expect(b.getFencingToken()).toBe(2);

    // Step 4: A's heartbeat fires — forward-jump guard must self-revoke.
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(a.isLeader()).toBe(false);

    // Post-condition: A's stale token is strictly less than B's current token.
    expect(a.getFencingToken()).toBeLessThan(b.getFencingToken());

    // B is still the valid leader.
    expect(b.isLeader()).toBe(true);
  });

  it('split-brain: after self-revocation, the stale leader must not write (write store contract)', async () => {
    // This test validates the write-permission contract at the application level:
    // a store that tracks the "max seen fencing token" must reject a write from
    // a stale leader that carries an older token.

    const leaseMs = 6000;
    let now = 0;
    const clockNowMs = () => now;

    const a = new RedisIndexerLeaderElection(redis, {
      instanceId: 'a',
      leaseMs,
      clockNowMs,
    });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs });

    // A acquires — token 1.
    await a.tryAcquire();
    const staleToken = a.getFencingToken();

    // Simulate A's lease expiring and B taking over.
    await redis.del('indexer:leader-election:replay');
    now += leaseMs; // forward jump — triggers self-revocation
    await b.tryAcquire();
    const freshToken = b.getFencingToken();

    // Minimal write-store: accepts only writes whose token > maxAcceptedToken.
    let maxAcceptedToken = 0;
    function authoriseWrite(token: number): boolean {
      if (token <= maxAcceptedToken) return false; // reject stale / duplicate
      maxAcceptedToken = token;
      return true;
    }

    // B's write (token 2) is accepted.
    expect(authoriseWrite(freshToken)).toBe(true);

    // A's heartbeat fires, self-revokes.
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(a.isLeader()).toBe(false);

    // A's stale write (token 1, less than maxAcceptedToken = 2) is rejected.
    expect(authoriseWrite(staleToken)).toBe(false);
  });

  it('split-brain: leader that lost Redis connectivity self-revokes on pexpire failure, not via clock guard', async () => {
    // Verifies that the existing Redis-outage path (renew fails due to PEXPIRE
    // error) also prevents split-brain — complementary to the clock-jump path.
    const leaseMs = 9000;

    const a = new RedisIndexerLeaderElection(redis, { instanceId: 'a', leaseMs });
    const b = new RedisIndexerLeaderElection(redis, { instanceId: 'b', leaseMs });

    await a.tryAcquire();
    const tokenA = a.getFencingToken();

    // Simulate Redis outage for A's next PEXPIRE: A self-revokes.
    redis.throwOnNext('pexpire', 'Redis connection lost');
    await vi.advanceTimersByTimeAsync(Math.floor(leaseMs / 3) + 10);
    expect(a.isLeader()).toBe(false);

    // B now acquires — new epoch, higher token.
    await redis.del('indexer:leader-election:replay'); // lease expired
    await b.tryAcquire();
    const tokenB = b.getFencingToken();

    expect(tokenB).toBeGreaterThan(tokenA);
    expect(b.isLeader()).toBe(true);
  });
});
