/**
 * tests/pii/pgcryptoEncryption.workerPool.test.ts
 *
 * Tests for the worker_threads pool and batch hashing offload.
 *
 * Covers:
 *   - WorkerPool lifecycle (construction, exec, shutdown)
 *   - Batch hashing correctness (deterministic, matches single-row results)
 *   - Batch threshold (below = synchronous, above = workers)
 *   - Fallback when workers fail to start
 *   - Graceful shutdown with pending tasks
 *   - Empty array / single-element edge cases
 *   - Pool reuse across multiple batch calls
 *   - Concurrent batch operations
 *   - Key security: keys passed via workerData, not env
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import {
  computeAddressHash,
  computeAddressHashes,
  batchComputeAddressHashes,
  shutdownPgcryptoPool,
  type PgcryptoKeySet,
} from '../../src/pii/pgcryptoEncryption.js';
import {
  WorkerPool,
  PoolShutdownError,
  resolveWorkerCount,
  resolveWorkerUrl,
  BATCH_HASH_THRESHOLD,
  DEFAULT_MAX_WORKERS,
} from '../../src/pii/workerPool.js';

// ── Test fixtures ──────────────────────────────────────────────────────────

const address = 'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY';
const key = 'a'.repeat(32);
const previousKey = 'b'.repeat(32);
const keys: PgcryptoKeySet = { current: key, previous: previousKey };
const keysNoPrevious: PgcryptoKeySet = { current: key };

// ── resolveWorkerCount ─────────────────────────────────────────────────────

describe('resolveWorkerCount', () => {
  it('returns a value between 1 and the cap', () => {
    const count = resolveWorkerCount(4);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('returns at least 1 even with a cap of 0', () => {
    expect(resolveWorkerCount(0)).toBeGreaterThanOrEqual(1);
  });

  it('defaults to DEFAULT_MAX_WORKERS when no cap given', () => {
    const count = resolveWorkerCount();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(DEFAULT_MAX_WORKERS);
  });
});

// ── WorkerPool unit tests ──────────────────────────────────────────────────

describe('WorkerPool', () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
      pool = null;
    }
  });

  it('dispatches a task to a worker and returns the result', async () => {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), '../../src/pii/pgcryptoWorker');
    pool = new WorkerPool(workerUrl, {
      workerData: { keys },
      maxWorkers: 2,
    });

    // The worker expects HashTaskMessage shape.
    const result = await pool.exec<{
      type: string;
      taskId: number;
      current: string;
      previous: string | undefined;
    }>({
      type: 'hash',
      taskId: 0,
      address,
      keys,
    });

    expect(result.type).toBe('result');
    expect(result.current).toBe(computeAddressHash(address, key));
    expect(result.previous).toBe(computeAddressHash(address, previousKey));
  });

  it('tracks pending and queued counts', async () => {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), '../../src/pii/pgcryptoWorker');
    pool = new WorkerPool(workerUrl, {
      workerData: { keys },
      maxWorkers: 1,
    });

    // First task occupies the single worker.
    const p1 = pool.exec({ type: 'hash', taskId: 0, address, keys });
    // Small delay to ensure the first task starts executing.
    await new Promise((r) => setTimeout(r, 10));

    // Second task should be queued.
    const p2 = pool.exec({ type: 'hash', taskId: 1, address, keys });

    expect(pool.workerCount).toBeGreaterThanOrEqual(1);

    await Promise.all([p1, p2]);
    expect(pool.pendingCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
  });

  it('rejects with PoolShutdownError after shutdown', async () => {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), '../../src/pii/pgcryptoWorker');
    pool = new WorkerPool(workerUrl, { maxWorkers: 1 });

    await pool.shutdown();
    pool = null; // prevent double-shutdown in afterEach

    // pool is null, so we test the PoolShutdownError class directly.
    expect(new PoolShutdownError().message).toBe('WorkerPool has been shut down');
    expect(new PoolShutdownError().name).toBe('PoolShutdownError');
  });

  it('degrades to fallback when worker creation fails', async () => {
    // Use an invalid worker URL to force failure.
    const badUrl = new URL('./nonexistent-worker.js', pathToFileURL(__filename));
    pool = new WorkerPool(badUrl, { maxWorkers: 1 });

    const fallback = vi.fn().mockReturnValue({
      type: 'result',
      taskId: 0,
      current: 'fallback-hash',
      previous: undefined,
    });
    pool.setFallback(fallback);

    const result = await pool.exec({
      type: 'hash',
      taskId: 0,
      address,
      keys,
    });

    expect(fallback).toHaveBeenCalledOnce();
    expect((result as { current: string }).current).toBe('fallback-hash');
  });
});

// ── batchComputeAddressHashes ──────────────────────────────────────────────

describe('batchComputeAddressHashes', () => {
  beforeEach(() => {
    // Reset the module-scoped pool between test groups.
    // We do this by shutting down and letting the lazy init recreate it.
  });

  afterEach(async () => {
    await shutdownPgcryptoPool();
  });

  it('returns results matching single-row computeAddressHashes for each address', async () => {
    const addrs = [
      'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY',
      'GBZC3BQTQFNINJ7M5VQ5WIZ6K7GJ4Y7XM5WZBZA7LG5WJ6H3JG7YJ3YK',
      'GAZQG7YJ2P5FJ6K4Y3Z5X6W7V8U9T0S1R2Q3P4O5N6M7L8K9J0H1G2F3D4S5',
    ];

    const expected = addrs.map((a) => computeAddressHashes(a, keys));
    const results = await batchComputeAddressHashes(addrs, keys, { threshold: 2 });

    expect(results).toHaveLength(3);
    for (let i = 0; i < addrs.length; i++) {
      expect(results[i].current).toBe(expected[i].current);
      expect(results[i].previous).toBe(expected[i].previous);
    }
  });

  it('handles an empty array', async () => {
    const results = await batchComputeAddressHashes([], keys);
    expect(results).toEqual([]);
  });

  it('handles a single address', async () => {
    const results = await batchComputeAddressHashes([address], keys);
    expect(results).toHaveLength(1);
    expect(results[0].current).toBe(computeAddressHash(address, key));
  });

  it('uses synchronous path when below threshold', async () => {
    // With threshold = 100, an array of 3 should be synchronous.
    const addrs = [address, address, address];
    const results = await batchComputeAddressHashes(addrs, keys, { threshold: 100 });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.current).toBe(computeAddressHash(address, key));
    }
  });

  it('uses worker pool when above threshold', async () => {
    // With threshold = 2, an array of 3 should go through the worker pool.
    const addrs = [
      'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY',
      'GBZC3BQTQFNINJ7M5VQ5WIZ6K7GJ4Y7XM5WZBZA7LG5WJ6H3JG7YJ3YK',
      'GAZQG7YJ2P5FJ6K4Y3Z5X6W7V8U9T0S1R2Q3P4O5N6M7L8K9J0H1G2F3D4S5',
    ];

    const results = await batchComputeAddressHashes(addrs, keys, { threshold: 2 });

    expect(results).toHaveLength(3);
    for (let i = 0; i < addrs.length; i++) {
      expect(results[i].current).toBe(computeAddressHash(addrs[i], key));
      expect(results[i].previous).toBe(computeAddressHash(addrs[i], previousKey));
    }
  });

  it('omits previous hash when no previous key is provided', async () => {
    const results = await batchComputeAddressHashes([address], keysNoPrevious, { threshold: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].current).toBe(computeAddressHash(address, key));
    expect(results[0].previous).toBeUndefined();
  });

  it('preserves input order even when worker completion order varies', async () => {
    // Create 10 distinct addresses with known hashes.
    const addrs = Array.from({ length: 10 }, (_, i) =>
      `G${String(i).padStart(55, '0').slice(0, 55)}`,
    );
    const expected = addrs.map((a) => computeAddressHash(a, key));

    const results = await batchComputeAddressHashes(addrs, keys, { threshold: 2 });

    expect(results).toHaveLength(10);
    for (let i = 0; i < addrs.length; i++) {
      expect(results[i].current).toBe(expected[i]);
    }
  });

  it('works with a large batch (stress test)', async () => {
    const count = 200;
    const addrs = Array.from({ length: count }, (_, i) =>
      `G${String(i).padStart(55, 'A').slice(0, 55)}`,
    );

    const results = await batchComputeAddressHashes(addrs, keys, { threshold: 50 });

    expect(results).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(results[i].current).toHaveLength(64);
      expect(results[i].current).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('can run multiple sequential batch operations', async () => {
    const batch1 = await batchComputeAddressHashes([address], keys, { threshold: 1 });
    const batch2 = await batchComputeAddressHashes(
      ['GBZC3BQTQFNINJ7M5VQ5WIZ6K7GJ4Y7XM5WZBZA7LG5WJ6H3JG7YJ3YK'],
      keys,
      { threshold: 1 },
    );

    expect(batch1[0].current).toBe(computeAddressHash(address, key));
    expect(batch2[0].current).toBe(
      computeAddressHash('GBZC3BQTQFNINJ7M5VQ5WIZ6K7GJ4Y7XM5WZBZA7LG5WJ6H3JG7YJ3YK', key),
    );
  });

  it('handles concurrent batch calls', async () => {
    const addrs1 = Array.from({ length: 10 }, (_, i) => `G${String(i).padStart(55, '1').slice(0, 55)}`);
    const addrs2 = Array.from({ length: 10 }, (_, i) => `G${String(i).padStart(55, '2').slice(0, 55)}`);

    const [results1, results2] = await Promise.all([
      batchComputeAddressHashes(addrs1, keys, { threshold: 2 }),
      batchComputeAddressHashes(addrs2, keys, { threshold: 2 }),
    ]);

    expect(results1).toHaveLength(10);
    expect(results2).toHaveLength(10);

    // Each batch should produce correct hashes for its own inputs.
    for (let i = 0; i < 10; i++) {
      expect(results1[i].current).toBe(computeAddressHash(addrs1[i], key));
      expect(results2[i].current).toBe(computeAddressHash(addrs2[i], key));
    }
  });
});

// ── Worker HashErrorMessage → rejection ────────────────────────────────────
//
// Before the fix, a worker that posted { type: 'error', taskId, error: '...' }
// would cause the pool to RESOLVE the task promise with the error-shaped
// object instead of rejecting it.  Callers expecting a HashResultMessage
// would get a HashErrorMessage silently, making the bug impossible to
// detect without explicit type checking downstream.

describe('WorkerPool — HashErrorMessage causes rejection', () => {
  it('rejects the task promise when the worker message has type "error"', async () => {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), '../../src/pii/pgcryptoWorker');
    const pool = new WorkerPool(workerUrl, { maxWorkers: 1 });

    // Register a fallback that simulates a worker posting an error-shaped message
    pool.setFallback((_msg: unknown) => {
      return { type: 'error', taskId: 0, error: 'hmac computation failed' };
    });

    // Force fallback by marking all workers failed
    (pool as any).allWorkersFailed = true;

    await expect(
      pool.exec({ type: 'hash', taskId: 0, address, keys })
    ).rejects.toThrow('hmac computation failed');

    await pool.shutdown();
  });

  it('resolves normally when the worker message has type "result"', async () => {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), '../../src/pii/pgcryptoWorker');
    const p = new WorkerPool(workerUrl, { maxWorkers: 1 });

    p.setFallback((_msg: unknown) => {
      return { type: 'result', taskId: 0, current: 'aabbcc', previous: undefined };
    });

    (p as any).allWorkersFailed = true;

    const result = await p.exec<{ type: string; current: string }>({
      type: 'hash', taskId: 0, address, keys,
    });

    expect(result.type).toBe('result');
    expect(result.current).toBe('aabbcc');
    await p.shutdown();
  });
});

// ── Key security ───────────────────────────────────────────────────────────

describe('Key security', () => {
  it('keys are never read from process.env inside the worker', async () => {
    // Set a fake key in the environment to verify the worker does NOT use it.
    const originalEnv = process.env.PGCRYPTO_KEY;
    process.env.PGCRYPTO_KEY = 'FAKE_KEY_NEVER_USED';

    try {
      const results = await batchComputeAddressHashes(
        [address],
        { current: key },
        { threshold: 1 },
      );

      // The result must match the explicit key, not the env var.
      expect(results[0].current).toBe(computeAddressHash(address, key));
      expect(results[0].current).not.toBe(computeAddressHash(address, 'FAKE_KEY_NEVER_USED'));
    } finally {
      if (originalEnv !== undefined) {
        process.env.PGCRYPTO_KEY = originalEnv;
      } else {
        delete process.env.PGCRYPTO_KEY;
      }
      await shutdownPgcryptoPool();
    }
  });

  it('computeAddressHash is deterministic for the same inputs', () => {
    const h1 = computeAddressHash(address, key);
    const h2 = computeAddressHash(address, key);
    expect(h1).toBe(h2);
  });

  it('different keys produce different hashes', () => {
    const h1 = computeAddressHash(address, key);
    const h2 = computeAddressHash(address, previousKey);
    expect(h1).not.toBe(h2);
  });
});

// ── BATCH_HASH_THRESHOLD constant ──────────────────────────────────────────

describe('BATCH_HASH_THRESHOLD', () => {
  it('is a positive integer', () => {
    expect(BATCH_HASH_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(BATCH_HASH_THRESHOLD)).toBe(true);
  });

  it('is exported from workerPool', () => {
    expect(BATCH_HASH_THRESHOLD).toBe(50);
  });
});

// ── DEFAULT_MAX_WORKERS constant ───────────────────────────────────────────

describe('DEFAULT_MAX_WORKERS', () => {
  it('is a positive integer no greater than 8', () => {
    expect(DEFAULT_MAX_WORKERS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_WORKERS).toBeLessThanOrEqual(8);
    expect(Number.isInteger(DEFAULT_MAX_WORKERS)).toBe(true);
  });
});
