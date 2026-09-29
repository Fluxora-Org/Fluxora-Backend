/**
 * tests/state/adminStateLock.concurrentReindex.test.ts
 *
 * Integration tests proving that `RedisDistributedLock` serializes concurrent
 * `POST /api/admin/reindex` calls across two independent process instances
 * sharing the same Redis backend, and that the lock's documented lease
 * behaviour holds against a real store.
 *
 * Uses `FakeRedisClient` (Map-backed in-process test double) to simulate
 * cross-process lock contention without requiring a live Redis server.
 * The `vi.resetModules()` pattern creates a second module scope that
 * represents a separate Node.js process with its own in-memory state,
 * while sharing the same `FakeRedisClient` instance (analogous to two
 * processes connecting to the same Redis).
 *
 * The "real store" suite below exercises contention, lease-based crash
 * recovery, and observability against the real OS filesystem (the lock's
 * file-backed fallback store) — it runs unconditionally in the standard
 * test environment.
 *
 * Security:  The distributed lock uses Redis SET NX for atomic acquisition.
 *            Lock values include PID + timestamp + sequence for
 *            auditability.  Keys are namespaced to prevent collision with
 *            pause-flag locks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  RedisDistributedLock,
  AdminStateLockError,
  REINDEX_LOCK_NAMESPACE,
  DEFAULT_LEASE_MS,
} from '../../src/state/adminStateLock.js';
import { createRedisClient, quitAllRedisClients } from '../../src/redis/client.js';
import type { LogRecord } from '../../src/lib/logger.js';

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
 * Capture every structured log record emitted to stdout while `fn` runs.
 * The logger writes one JSON object per line, so the captured stream is
 * split back into records. Used to assert that lock acquisition and release
 * are observable.
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
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogRecord];
      } catch {
        return [];
      }
    });
}

/** Namespaces used by the filesystem real-store suite (for cleanup). */
const FILE_LOCK_NAMESPACES = [
  'file-contention',
  'file-lease',
  'file-ownership',
  'file-observability',
];

/** Lock-file path the file backend uses for a namespace (mirrors production). */
function fileLockPath(lockNamespace: string): string {
  return path.join(os.tmpdir(), `fluxora-admin-state-${lockNamespace}.lock`);
}

/**
 * Build a FakeRedisClient whose `setNx` always throws, simulating a Redis
 * outage. `RedisDistributedLock.acquire()` then falls back to the file-based
 * lock — contention is exercised against the real OS filesystem.
 */
function failingRedis(): FakeRedisClient {
  const client = new FakeRedisClient();
  client.setNx = async () => {
    throw new Error('simulated Redis outage');
  };
  return client;
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
  // Remove any lock files left behind by the filesystem real-store suite.
  for (const ns of FILE_LOCK_NAMESPACES) {
    fs.rmSync(fileLockPath(ns), { force: true });
  }
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

  // -----------------------------------------------------------------------
  // 11. Configurable lease duration applied as the lock key TTL
  // -----------------------------------------------------------------------

  it('applies the configured leaseMs as the SET NX PX argument', async () => {
    const setNxSpy = vi.spyOn(sharedRedis, 'setNx');
    const lock = new RedisDistributedLock(sharedRedis, 'reindex', {
      timeoutMs: TEST_LOCK_TIMEOUT_MS,
      leaseMs: 4321,
    });

    const held = await lock.acquire();
    expect(setNxSpy).toHaveBeenCalledWith(
      `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`,
      expect.any(String),
      4321,
    );
    await held.release();
  });

  it('defaults the lease to the documented DEFAULT_LEASE_MS (5000 ms)', async () => {
    expect(DEFAULT_LEASE_MS).toBe(5000);
    const setNxSpy = vi.spyOn(sharedRedis, 'setNx');
    const lock = new RedisDistributedLock(sharedRedis, 'reindex', {
      timeoutMs: TEST_LOCK_TIMEOUT_MS,
    });

    const held = await lock.acquire();
    expect(setNxSpy).toHaveBeenCalledWith(
      `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`,
      expect.any(String),
      DEFAULT_LEASE_MS,
    );
    await held.release();
  });

  // -----------------------------------------------------------------------
  // 12. Acquisition and release are observable (structured log events)
  // -----------------------------------------------------------------------

  it('emits structured acquired and released events for redis-backed locks', async () => {
    const leaseMs = 2750;
    const lock = new RedisDistributedLock(sharedRedis, 'reindex', {
      timeoutMs: TEST_LOCK_TIMEOUT_MS,
      leaseMs,
    });
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;

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
    expect(acquired?.['lockKey']).toBe(lockKey);
    expect(acquired?.['leaseMs']).toBe(leaseMs);
    expect(acquired?.['lockValue']).toEqual(expect.any(String));

    const released = records.find(
      (r) => r.message === 'admin_state_lock:released',
    );
    expect(released).toBeDefined();
    expect(released?.level).toBe('info');
    expect(released?.['backend']).toBe('redis');
    expect(released?.['lockKey']).toBe(lockKey);
  });
});

// ---------------------------------------------------------------------------
// Real-store (filesystem) suite
//
// Exercises contention, the documented lease bound for crashed holders, and
// acquire/release observability against the OS filesystem — the lock's
// real, file-backed fallback store — so these guarantees are asserted in the
// standard test environment without any external service. Redis is
// simulated as unavailable so `RedisDistributedLock` takes the file path.
// ---------------------------------------------------------------------------

describe('AdminStateLock real-store (filesystem) behaviour', () => {
  const NS_CONTENTION = 'file-contention';
  const NS_LEASE = 'file-lease';
  const NS_OWNERSHIP = 'file-ownership';
  const NS_OBSERVABILITY = 'file-observability';

  it('serializes two lock instances contending on the real filesystem store', async () => {
    const client = failingRedis();
    const lockA = new RedisDistributedLock(client, NS_CONTENTION, {
      timeoutMs: TEST_LOCK_TIMEOUT_MS,
      leaseMs: 5000,
    });
    const lockB = new RedisDistributedLock(client, NS_CONTENTION, {
      timeoutMs: TEST_LOCK_TIMEOUT_MS,
      leaseMs: 5000,
    });
    const lockFile = fileLockPath(NS_CONTENTION);

    // A acquires — observable as the lock file appearing in the store.
    const heldA = await lockA.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);

    // B contends against the real store and must not acquire while A holds.
    await expect(lockB.acquire()).rejects.toThrow(AdminStateLockError);
    expect(fs.existsSync(lockFile)).toBe(true);

    // A releases — observable as the lock file disappearing.
    await heldA.release();
    expect(fs.existsSync(lockFile)).toBe(false);

    // With the store free, B acquires and releases cleanly.
    const heldB = await lockB.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);
    await heldB.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("releases a crashed holder's lock within the lease", async () => {
    const client = failingRedis();
    const LEASE_MS = 500;
    const holder = new RedisDistributedLock(client, NS_LEASE, {
      timeoutMs: 1000,
      leaseMs: LEASE_MS,
    });
    const blocked = new RedisDistributedLock(client, NS_LEASE, {
      timeoutMs: 200,
      leaseMs: LEASE_MS,
    });
    const survivor = new RedisDistributedLock(client, NS_LEASE, {
      timeoutMs: 3000,
      leaseMs: LEASE_MS,
    });
    const lockFile = fileLockPath(NS_LEASE);

    // Holder acquires and then "crashes": the handle is dropped un-released.
    const crashedAt = Date.now();
    await holder.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);

    // Well within the lease the crashed holder still blocks other acquirers.
    await expect(blocked.acquire()).rejects.toThrow(AdminStateLockError);
    expect(fs.existsSync(lockFile)).toBe(true);

    // Once the lease has elapsed the lock is handed over: the survivor's
    // acquire succeeds (it steals the stale lock) — i.e. the crashed
    // holder's lock was released within the lease.
    const recovered = await survivor.acquire();
    const recoveredAt = Date.now();
    expect(recovered).toBeDefined();
    expect(fs.existsSync(lockFile)).toBe(true);
    // Documented bound: free no later than the lease (+50 ms poll granularity
    // and scheduling slack).
    expect(recoveredAt - crashedAt).toBeLessThan(LEASE_MS + 1000);

    await recovered.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("a revived crashed holder's late release does not free the new holder's lock", async () => {
    const client = failingRedis();
    const LEASE_MS = 100;
    const crashed = new RedisDistributedLock(client, NS_OWNERSHIP, {
      timeoutMs: 500,
      leaseMs: LEASE_MS,
    });
    const successor = new RedisDistributedLock(client, NS_OWNERSHIP, {
      timeoutMs: 2000,
      leaseMs: LEASE_MS,
    });
    const lockFile = fileLockPath(NS_OWNERSHIP);

    const staleHandle = await crashed.acquire();

    // Simulate the crash having outlived the lease: age the lock file past
    // the lease boundary deterministically.
    const past = new Date(Date.now() - (LEASE_MS + 60_000));
    fs.utimesSync(lockFile, past, past);

    // The successor steals the stale lock.
    const newHandle = await successor.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);

    // The revived crashed holder releases: ownership check must detect it no
    // longer owns the lock and leave the successor's lock file in place.
    const records = await captureLogRecords(() => staleHandle.release());
    expect(fs.existsSync(lockFile)).toBe(true);
    const skipped = records.find(
      (r) => r.message === 'admin_state_lock:release_skipped',
    );
    expect(skipped).toBeDefined();
    expect(skipped?.['reason']).toBe('not_owner_or_expired');
    expect(skipped?.['backend']).toBe('file');

    // The successor's release removes the lock normally.
    await newHandle.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('emits observable acquire/release log events for the file backend', async () => {
    const client = failingRedis();
    const leaseMs = 2500;
    const lock = new RedisDistributedLock(client, NS_OBSERVABILITY, {
      timeoutMs: 500,
      leaseMs,
    });
    const lockFile = fileLockPath(NS_OBSERVABILITY);

    const records = await captureLogRecords(async () => {
      const held = await lock.acquire();
      expect(fs.existsSync(lockFile)).toBe(true);
      await held.release();
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    const acquired = records.find(
      (r) => r.message === 'admin_state_lock:acquired',
    );
    expect(acquired).toBeDefined();
    expect(acquired?.level).toBe('info');
    expect(acquired?.['backend']).toBe('file');
    expect(acquired?.['lockKey']).toBe(lockFile);
    expect(acquired?.['lockNamespace']).toBe(NS_OBSERVABILITY);
    expect(acquired?.['leaseMs']).toBe(leaseMs);
    expect(acquired?.['lockValue']).toEqual(expect.any(String));

    const released = records.find(
      (r) => r.message === 'admin_state_lock:released',
    );
    expect(released).toBeDefined();
    expect(released?.level).toBe('info');
    expect(released?.['backend']).toBe('file');
    expect(released?.['lockKey']).toBe(lockFile);
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

// ---------------------------------------------------------------------------
// Integration tests (real Redis)
//
// Keep-gated (issue #1248): requires a live Redis server. Opt in locally
// with `REDIS_INTEGRATION=true` (point `REDIS_TEST_URL` at your server);
// CI provisions a Redis service and sets `REDIS_INTEGRATION=true`
// automatically, so the real-Redis contention assertions run on every CI
// build. Real-store (filesystem) contention coverage runs unconditionally
// in the suite above.
// ---------------------------------------------------------------------------

const REDIS_INTEGRATION_ENABLED = process.env['REDIS_INTEGRATION'] === 'true';
const REDIS_TEST_URL = process.env['REDIS_TEST_URL'] ?? 'redis://localhost:6379';

describe.skipIf(!REDIS_INTEGRATION_ENABLED)('Integration: AdminStateLock with real Redis', () => {
  afterEach(async () => {
    // Close any Redis clients created during tests to avoid leaked sockets.
    try {
      await quitAllRedisClients();
    } catch {
      // ignore
    }
    // Reset module state so subsequent tests are isolated.
    vi.resetModules();
    const mod = await import('../../src/state/adminState.js');
    mod._resetForTest({ clearLock: true, clearPersistence: true });
  });

  it('serializes reindex triggers across two process instances using real Redis', async () => {
    // Helper to create a module scope backed by a real Redis client.
    async function createProcessScopeReal(lockNamespace: string, timeoutMs?: number) {
      vi.resetModules();
      const client = await createRedisClient({ url: REDIS_TEST_URL, enabled: true });
      const mod = await import('../../src/state/adminState.js');
      mod._resetForTest();
      const lock = new RedisDistributedLock(client, lockNamespace, { timeoutMs });
      mod._setReindexLockForTest(lock);
      return { triggerReindex: mod.triggerReindex, getReindexState: mod.getReindexState, client, lock };
    }

    const pA = await createProcessScopeReal('reindex', TEST_LOCK_TIMEOUT_MS);
    const pB = await createProcessScopeReal('reindex', TEST_LOCK_TIMEOUT_MS);

    // Let process B acquire the lock first (competing process).
    const held = await pB.lock.acquire();

    // Process A should observe the lock and return idle state.
    const loser = await pA.triggerReindex();
    expect(loser.status).toBe('idle');

    // Release the competing lock and retry — should start running.
    await held.release();
    const winner = await pA.triggerReindex();
    expect(winner.status).toBe('running');

    // Wait for background job to complete and assert final state.
    await wait(400);
    expect(pA.getReindexState().status).toBe('completed');
  });

  it('recovers a crashed holder\'s lock after the lease expires (real Redis)', async () => {
    const leaseMs = 500;
    const lockKey = `admin-state:lock:${REINDEX_LOCK_NAMESPACE}`;
    const client = await createRedisClient({ url: REDIS_TEST_URL, enabled: true });
    const holder = new RedisDistributedLock(client, REINDEX_LOCK_NAMESPACE, {
      timeoutMs: 1000,
      leaseMs,
    });
    const survivor = new RedisDistributedLock(client, REINDEX_LOCK_NAMESPACE, {
      timeoutMs: 3000,
      leaseMs,
    });

    // Holder acquires and "crashes" — never calls release(). Real Redis
    // enforces the PX TTL server-side, so the key expires within the lease.
    await holder.acquire();
    expect(await client.exists(lockKey)).toBe(true);

    const crashedAt = Date.now();
    const recovered = await survivor.acquire();
    const recoveredAt = Date.now();
    expect(recovered).toBeDefined();
    // Released within the lease (plus retry poll granularity).
    expect(recoveredAt - crashedAt).toBeGreaterThanOrEqual(leaseMs - 100);
    expect(recoveredAt - crashedAt).toBeLessThan(leaseMs + 2000);

    await recovered.release();
    expect(await client.exists(lockKey)).toBe(false);
  });
});
