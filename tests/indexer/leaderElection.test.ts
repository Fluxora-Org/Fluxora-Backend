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
