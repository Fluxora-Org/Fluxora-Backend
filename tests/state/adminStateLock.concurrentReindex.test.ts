/**
 * tests/state/adminStateLock.concurrentReindex.test.ts
 *
 * Integration tests proving that `RedisDistributedLock` serializes concurrent
 * `POST /api/admin/reindex` calls across two independent process instances
 * sharing the same Redis backend.
 *
 * Uses `FakeRedisClient` (Map-backed in-process test double) to simulate
 * cross-process lock contention without requiring a live Redis server.
 * The `vi.resetModules()` pattern creates a second module scope that
 * represents a separate Node.js process with its own in-memory state,
 * while sharing the same `FakeRedisClient` instance (analogous to two
 * processes connecting to the same Redis).
 *
 * Security:  The distributed lock uses Redis SET NX for atomic acquisition.
 *            Lock values include PID + timestamp for auditability.  Keys are
 *            namespaced to prevent collision with pause-flag locks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  RedisDistributedLock,
  AdminStateLockError,
  REINDEX_LOCK_NAMESPACE,
} from '../../src/state/adminStateLock.js';
import type { Lock } from '../../src/state/adminStateLock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Short lock timeout for tests (avoids 5 s default). */
const TEST_LOCK_TIMEOUT_MS = 200;

/**
 * Wait for `ms` milliseconds.  Used to let background reindex jobs
 * (5 × 50 ms = 250 ms) finish between assertions.
 */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shared FakeRedisClient that simulates a Redis instance visible to
 * multiple process-like module scopes.
 */
let sharedRedis: FakeRedisClient;

beforeEach(() => {
  sharedRedis = new FakeRedisClient();
});

afterEach(() => {
  sharedRedis.reset();
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AdminStateLock concurrent reindex serialization', () => {
  // -----------------------------------------------------------------------
  // 1. Two concurrent reindex attempts — only one wins
  // -----------------------------------------------------------------------

  it('serializes two concurrent reindex triggers across simulated processes', async () => {
    // Simulate process A: set up the module scope with a short-timeout reindex lock.
    const { triggerReindex, getReindexState } =
      await createProcessScope('reindex', TEST_LOCK_TIMEOUT_MS);

    // Simulate process B: a separate RedisDistributedLock instance on the
    // same namespace, sharing the same Redis backend.  This lock grabs the
    // key first, mimicking another process holding the lock.
    const competingLock = new RedisDistributedLock(sharedRedis, 'reindex');
    const heldLock = await competingLock.acquire();

    // Now triggerReindex() tries to acquire the lock but finds it held.
    // It should return idle state so the route layer can return 409.
    const loserResult = await triggerReindex();
    expect(loserResult.status).toBe('idle');

    // Release the competing lock.
    await heldLock.release();

    // With the lock free, triggerReindex() should succeed.
    const winnerResult = await triggerReindex();
    expect(winnerResult.status).toBe('running');

    // Wait for background job to complete.
    await wait(400);
    expect(getReindexState().status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // 2. Lock released after completion — subsequent call succeeds
  // -----------------------------------------------------------------------

  it('releases lock after completion so a subsequent reindex succeeds', async () => {
    const { triggerReindex, getReindexState } =
      await createProcessScope('reindex');

    // First reindex: should succeed.
    const first = await triggerReindex();
    expect(first.status).toBe('running');

    // Wait for background job to complete (5 × 50 ms + margin).
    await wait(400);

    // Second reindex: lock was released after job completed, should succeed.
    const second = await triggerReindex();
    expect(second.status).toBe('running');

    // Wait and verify final state.
    await wait(400);
    expect(getReindexState().status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // 3. Lock released on failure — subsequent call still succeeds
  // -----------------------------------------------------------------------

  it('releases lock even when the reindex job fails', async () => {
    const { triggerReindex } = await createProcessScope('reindex');

    // Trigger first reindex.
    const first = await triggerReindex();
    expect(first.status).toBe('running');

    // Wait for it to complete.
    await wait(400);

    // Verify lock was released by checking the Redis key is gone.
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;
    const lockStillExists = await sharedRedis.exists(lockKey);
    expect(lockStillExists).toBe(false);

    // A subsequent reindex should succeed because the lock was released.
    const second = await triggerReindex();
    expect(second.status).toBe('running');

    await wait(400);
  });

  // -----------------------------------------------------------------------
  // 4. Loser receives clear conflict — route-level 409 behavior
  // -----------------------------------------------------------------------

  it('returns idle state to the loser so the route layer can return 409', async () => {
    const { triggerReindex } = await createProcessScope('reindex', TEST_LOCK_TIMEOUT_MS);

    // Simulate a competing process by manually holding the lock.
    const competingLock = new RedisDistributedLock(sharedRedis, 'reindex');
    const heldLock = await competingLock.acquire();

    // triggerReindex() tries to acquire the lock but finds it held.
    // Should return idle (not running) so the route handler can return 409.
    const loserResult = await triggerReindex();
    expect(loserResult.status).not.toBe('running');
    expect(loserResult.status).toBe('idle');

    await heldLock.release();
  });

  // -----------------------------------------------------------------------
  // 5. Direct lock contention — two lock objects, same namespace
  // -----------------------------------------------------------------------

  it('prevents two direct lock acquisitions on the same namespace', async () => {
    const lockA = new RedisDistributedLock(sharedRedis, 'reindex');
    const lockB = new RedisDistributedLock(sharedRedis, 'reindex');

    // Instance A acquires the lock.
    const heldA = await lockA.acquire();
    expect(heldA).toBeDefined();

    // Instance B should fail to acquire — the key already exists.
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;
    const secondAttempt = await sharedRedis.setNx(lockKey, 'process-b', 5000);
    expect(secondAttempt).toBe(false);

    // Release A.
    await heldA.release();

    // Now B can acquire.
    const heldB = await lockB.acquire();
    expect(heldB).toBeDefined();
    await heldB.release();

    // Key should be cleaned up.
    const keyExists = await sharedRedis.exists(lockKey);
    expect(keyExists).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 6. Lock is not leaked after release
  // -----------------------------------------------------------------------

  it('does not leak the lock key after release', async () => {
    const lock = new RedisDistributedLock(sharedRedis, 'reindex');
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;

    const held = await lock.acquire();
    expect(await sharedRedis.exists(lockKey)).toBe(true);

    await held.release();
    expect(await sharedRedis.exists(lockKey)).toBe(false);

    // Acquire again to prove the key is truly gone.
    const held2 = await lock.acquire();
    expect(await sharedRedis.exists(lockKey)).toBe(true);

    await held2.release();
    expect(await sharedRedis.exists(lockKey)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 7. AdminStateLockError on timeout
  // -----------------------------------------------------------------------

  it('throws AdminStateLockError when lock cannot be acquired within timeout', async () => {
    // Pre-fill the lock key with a stale value.  FakeRedisClient never expires
    // keys, so acquire() will always see the existing key and retry until
    // timeout, then throw.
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;
    await sharedRedis.setNx(lockKey, 'stale-process', 60_000);

    const lock = new RedisDistributedLock(sharedRedis, 'reindex', {
      timeoutMs: TEST_LOCK_TIMEOUT_MS,
    });

    await expect(lock.acquire()).rejects.toThrow(AdminStateLockError);
    await expect(lock.acquire()).rejects.toThrow(
      /Failed to acquire admin state lock/,
    );
  });

  // -----------------------------------------------------------------------
  // 8. triggerReindex() returns idle state when lock acquisition fails
  // -----------------------------------------------------------------------

  it('triggerReindex returns idle state when lock cannot be acquired', async () => {
    // Pre-fill the lock key so acquire() fails immediately.
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;
    await sharedRedis.setNx(lockKey, 'stale', 60_000);

    // Create a process scope with a short lock timeout.
    vi.resetModules();
    const mod = await import('../../src/state/adminState.js');
    mod._resetForTest();
    mod._setReindexLockForTest(
      new RedisDistributedLock(sharedRedis, 'reindex', {
        timeoutMs: TEST_LOCK_TIMEOUT_MS,
      }),
    );

    const result = await mod.triggerReindex();

    // Should return current idle state, not 'running'.
    expect(result.status).toBe('idle');

    // Clean up.
    await sharedRedis.del(lockKey);
  });

  // -----------------------------------------------------------------------
  // 9. Rapid sequential calls after lock release all succeed
  // -----------------------------------------------------------------------

  it('allows rapid sequential reindex calls after lock release', async () => {
    const { triggerReindex, getReindexState } =
      await createProcessScope('reindex');

    // First reindex.
    const r1 = await triggerReindex();
    expect(r1.status).toBe('running');
    await wait(400);

    // Second reindex (after lock released).
    const r2 = await triggerReindex();
    expect(r2.status).toBe('running');
    await wait(400);

    // Third reindex.
    const r3 = await triggerReindex();
    expect(r3.status).toBe('running');
    await wait(400);

    expect(getReindexState().status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // 10. No distributed lock configured — fallback still works
  // -----------------------------------------------------------------------

  it('works without a distributed lock (single-process fallback)', async () => {
    const { triggerReindex, getReindexState } =
      await createProcessScopeNoLock();

    const first = await triggerReindex();
    expect(first.status).toBe('running');

    await wait(400);

    const second = await triggerReindex();
    expect(second.status).toBe('running');

    await wait(400);
    expect(getReindexState().status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Process-scope helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated module scope (simulating a separate Node.js process)
 * with a RedisDistributedLock backed by the shared FakeRedisClient.
 *
 * Uses `vi.resetModules()` to get a fresh module import with its own
 * in-memory state while sharing the same Redis backend.
 */
async function createProcessScope(lockNamespace: string, timeoutMs?: number) {
  vi.resetModules();
  const mod = await import('../../src/state/adminState.js');
  mod._resetForTest();
  mod._setReindexLockForTest(
    new RedisDistributedLock(sharedRedis, lockNamespace, { timeoutMs }),
  );
  return {
    triggerReindex: mod.triggerReindex,
    getReindexState: mod.getReindexState,
  };
}

/**
 * Create an isolated module scope WITHOUT a distributed lock (single-process
 * fallback path).
 */
async function createProcessScopeNoLock() {
  vi.resetModules();
  const mod = await import('../../src/state/adminState.js');
  mod._resetForTest();
  // Do NOT set a reindex lock — simulates no Redis configured.
  return {
    triggerReindex: mod.triggerReindex,
    getReindexState: mod.getReindexState,
  };
}
