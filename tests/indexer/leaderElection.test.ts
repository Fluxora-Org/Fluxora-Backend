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
