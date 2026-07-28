import { describe, it, expect } from 'vitest';
import { RedisDistributedLock, AdminStateLockError } from '../state/adminStateLock.js';

/**
 * Fake Redis that honours the pxMs expiry passed to setNx. A held lock whose
 * expiry has elapsed is treated as gone, simulating the Redis-side TTL that
 * lets a crashed holder's lock auto-release (stale-lock recovery). The clock is
 * advanced manually via `advance()` so tests stay deterministic and fast.
 */
class FakeRedis {
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

  async setNx(key: string, value: string, pxMs: number): Promise<boolean> {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > this.now) return false;
    this.store.set(key, { value, expiresAt: this.now + pxMs });
    return true;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('adminStateLock stale-lock recovery', () => {
  it('acquires and releases a lock normally', async () => {
    const redis = new FakeRedis();
    const lock = new RedisDistributedLock(redis as any, 'ns', { timeoutMs: 1000 });
    const acquired = await lock.acquire();
    expect(acquired).toBeDefined();
    await acquired.release();
  });

  it('recovers a stale lock after its TTL elapses (holder crashed without release)', async () => {
    const redis = new FakeRedis();
    const lock = new RedisDistributedLock(redis as any, 'ns', { timeoutMs: 5000 });

    // Holder acquires the lock (TTL 5000ms) but crashes without releasing.
    const held = await lock.acquire();
    expect(held).toBeDefined();

    // Advance past the lock TTL; the crashed holder never called release().
    redis.advance(6000);

    // A new acquirer must succeed — the stale lock has expired.
    const recovered = await lock.acquire();
    expect(recovered).toBeDefined();
    await recovered.release();
  });

  it('does not allow a second acquirer before the TTL elapses', async () => {
    const redis = new FakeRedis();
    const lock = new RedisDistributedLock(redis as any, 'ns', { timeoutMs: 1000 });
    await lock.acquire();

    // Well within the TTL: a second acquirer should time out.
    const contender = new RedisDistributedLock(redis as any, 'ns', { timeoutMs: 200 });
    await expect(contender.acquire()).rejects.toBeInstanceOf(AdminStateLockError);
  });
});
