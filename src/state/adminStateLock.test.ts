import { describe, it, expect, vi } from 'vitest';
import {
  RedisDistributedLock,
  AdminStateLockError,
  DEFAULT_LEASE_MS,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
} from '../state/adminStateLock.js';
import type { LogRecord } from '../lib/logger.js';
import type { RedisClient, RedisPipeline } from '../redis/client.js';

/**
 * Fake Redis that honours the pxMs expiry passed to setNx. A held lock whose
 * expiry has elapsed is treated as gone, simulating the Redis-side TTL that
 * lets a crashed holder's lock auto-release (stale-lock recovery). The clock is
 * advanced manually via `advance()` so tests stay deterministic and fast.
 *
 * Implements the full RedisClient interface (see src/redis/client.ts). Only
 * get/setNx/del carry behaviour used by the lock; the remaining members
 * satisfy the interface and are unused by these tests.
 */
class FakeRedis implements RedisClient {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private now = 0;

  advance(ms: number): void {
    this.now += ms;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
  }

  async setNx(key: string, value: string, pxMs: number): Promise<boolean> {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > this.now) return false;
    this.store.set(key, { value, expiresAt: this.now + pxMs });
    return true;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async incr(key: string): Promise<number> {
    const current = await this.get(key);
    const next = (current === null ? 0 : Number(current)) + 1;
    const entry = this.store.get(key);
    this.store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? Number.POSITIVE_INFINITY,
    });
    return next;
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  multi(): RedisPipeline {
    const noop: RedisPipeline = {
      zadd() { return noop; },
      zremrangebyscore() { return noop; },
      zcard() { return noop; },
      pexpire() { return noop; },
      async exec() { return []; },
    };
    return noop;
  }

  async zcount(): Promise<number> {
    return 0;
  }
}

/**
 * Capture every structured log record emitted to stdout while `fn` runs.
 * The logger writes one JSON object per line, so the captured stream is split
 * back into records.
 */
async function captureLogRecords(fn: () => Promise<void>): Promise<LogRecord[]> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout.write as unknown) = orig;
  }
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogRecord);
}

describe('adminStateLock stale-lock recovery', () => {
  it('acquires and releases a lock normally', async () => {
    const redis = new FakeRedis();
    const lock = new RedisDistributedLock(redis, 'ns', { timeoutMs: 1000 });
    const acquired = await lock.acquire();
    expect(acquired).toBeDefined();
    await acquired.release();
  });

  it('recovers a stale lock after its lease elapses (holder crashed without release)', async () => {
    const redis = new FakeRedis();
    const leaseMs = 5000;
    const lock = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 5000,
      leaseMs,
    });

    // Holder acquires the lock (lease 5000ms) but crashes without releasing.
    const held = await lock.acquire();
    expect(held).toBeDefined();

    // Advance past the lease; the crashed holder never called release().
    redis.advance(leaseMs + 1000);

    // A new acquirer must succeed — the stale lock has expired.
    const recovered = await lock.acquire();
    expect(recovered).toBeDefined();
    await recovered.release();
  });

  it('does not allow a second acquirer before the lease elapses', async () => {
    const redis = new FakeRedis();
    const lock = new RedisDistributedLock(redis, 'ns', { timeoutMs: 1000 });
    await lock.acquire();

    // Well within the lease: a second acquirer should time out.
    const contender = new RedisDistributedLock(redis, 'ns', { timeoutMs: 200 });
    await expect(contender.acquire()).rejects.toBeInstanceOf(AdminStateLockError);
  });

  it('releases a crashed holder\'s lock within the lease (held for the full lease, free at the boundary)', async () => {
    const redis = new FakeRedis();
    const leaseMs = 1000;
    const holder = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 1000,
      leaseMs,
    });
    await holder.acquire(); // crashed: never released

    // One millisecond before the lease ends the lock is still held.
    redis.advance(leaseMs - 1);
    const early = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 60,
      leaseMs,
    });
    await expect(early.acquire()).rejects.toBeInstanceOf(AdminStateLockError);

    // At the lease boundary the crashed holder's lock is released.
    redis.advance(1);
    const recovered = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 100,
      leaseMs,
    });
    const acquired = await recovered.acquire();
    expect(acquired).toBeDefined();
    await acquired.release();
  });
});

describe('adminStateLock lease duration', () => {
  it('applies the configured leaseMs as the SET NX PX argument', async () => {
    const redis = new FakeRedis();
    const setNxSpy = vi.spyOn(redis, 'setNx');
    const lock = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 100,
      leaseMs: 2500,
    });
    const held = await lock.acquire();
    expect(setNxSpy).toHaveBeenCalledWith(
      'admin-state:lock:ns',
      expect.any(String),
      2500,
    );
    await held.release();
  });

  it('defaults the lease to the documented DEFAULT_LEASE_MS', async () => {
    expect(DEFAULT_LEASE_MS).toBe(5000);
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(5000);

    const redis = new FakeRedis();
    const setNxSpy = vi.spyOn(redis, 'setNx');
    const lock = new RedisDistributedLock(redis, 'ns', { timeoutMs: 100 });
    const held = await lock.acquire();
    expect(setNxSpy).toHaveBeenCalledWith(
      'admin-state:lock:ns',
      expect.any(String),
      DEFAULT_LEASE_MS,
    );
    await held.release();
  });

  it('uses the lease, not the acquisition timeout, as the key TTL', async () => {
    const redis = new FakeRedis();
    const setNxSpy = vi.spyOn(redis, 'setNx');

    // A short acquisition timeout must not shorten the lease.
    const lock = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 150,
      leaseMs: 4000,
    });
    const held = await lock.acquire();
    expect(setNxSpy).toHaveBeenCalledWith(
      'admin-state:lock:ns',
      expect.any(String),
      4000,
    );
    await held.release();
  });

  it('rejects a lease duration that is not a positive finite number', () => {
    const redis = new FakeRedis();
    expect(
      () => new RedisDistributedLock(redis, 'ns', { leaseMs: 0 }),
    ).toThrow(AdminStateLockError);
    expect(
      () => new RedisDistributedLock(redis, 'ns', { leaseMs: -5 }),
    ).toThrow(AdminStateLockError);
    expect(
      () => new RedisDistributedLock(redis, 'ns', { leaseMs: Number.NaN }),
    ).toThrow(AdminStateLockError);
  });
});

describe('adminStateLock observability', () => {
  it('emits structured acquired and released events around a redis-backed acquisition', async () => {
    const redis = new FakeRedis();
    const leaseMs = 1234;
    const lock = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 100,
      leaseMs,
    });

    const records = await captureLogRecords(async () => {
      const held = await lock.acquire();
      await held.release();
    });

    const acquired = records.find(
      (r) => r.message === 'admin_state_lock:acquired',
    );
    expect(acquired).toBeDefined();
    expect(acquired?.level).toBe('info');
    expect(acquired?.['backend']).toBe('redis');
    expect(acquired?.['lockKey']).toBe('admin-state:lock:ns');
    expect(acquired?.['lockNamespace']).toBe('ns');
    expect(acquired?.['leaseMs']).toBe(leaseMs);
    expect(acquired?.['lockValue']).toEqual(expect.any(String));

    const released = records.find(
      (r) => r.message === 'admin_state_lock:released',
    );
    expect(released).toBeDefined();
    expect(released?.level).toBe('info');
    expect(released?.['backend']).toBe('redis');
    expect(released?.['lockKey']).toBe('admin-state:lock:ns');
  });

  it('emits a release_skipped event when the holder no longer owns the lock', async () => {
    const redis = new FakeRedis();
    const lock = new RedisDistributedLock(redis, 'ns', {
      timeoutMs: 100,
      leaseMs: 500,
    });
    const held = await lock.acquire();

    // Another instance takes over (our key expired and was re-acquired).
    redis.advance(500);
    await redis.setNx('admin-state:lock:ns', 'other-instance', 5000);

    const records = await captureLogRecords(() => held.release());
    const skipped = records.find(
      (r) => r.message === 'admin_state_lock:release_skipped',
    );
    expect(skipped).toBeDefined();
    expect(skipped?.['reason']).toBe('not_owner_or_expired');
    // The other instance's lock must remain untouched.
    expect(await redis.get('admin-state:lock:ns')).toBe('other-instance');
  });
});
