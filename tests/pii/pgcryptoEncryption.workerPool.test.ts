import { afterEach, describe, expect, it } from 'vitest';
import {
  batchComputeAddressHash,
  batchComputeAddressHashes,
  computeAddressHash,
  computeAddressHashes,
  shutdownPgcryptoHashWorkerPool,
} from '../../src/pii/pgcryptoEncryption.js';
import {
  BATCH_HASH_THRESHOLD,
  hashWorkerCount,
  MAX_HASH_WORKERS,
  PgcryptoHashWorkerPool,
} from '../../src/pii/workerPool.js';

const key = 'a'.repeat(32);
const previous = 'b'.repeat(32);
const addresses = Array.from({ length: BATCH_HASH_THRESHOLD }, (_, index) => `GADDRESS${index}`);

afterEach(async () => {
  await shutdownPgcryptoHashWorkerPool();
});

describe('pgcrypto batch hashing worker pool', () => {
  it('keeps small batches on the synchronous request path', async () => {
    const smallBatch = addresses.slice(0, BATCH_HASH_THRESHOLD - 1);
    await expect(batchComputeAddressHashes(smallBatch, { current: key, previous }))
      .resolves.toEqual(smallBatch.map((address) => computeAddressHashes(address, { current: key, previous })));
  });

  it('offloads large batches and preserves hash order', async () => {
    await expect(batchComputeAddressHashes(addresses, { current: key, previous }))
      .resolves.toEqual(addresses.map((address) => computeAddressHashes(address, { current: key, previous })));
  });

  it('computes current-key-only batch hashes', async () => {
    await expect(batchComputeAddressHash(addresses, key))
      .resolves.toEqual(addresses.map((address) => computeAddressHash(address, key)));
  });

  it('replaces the pool when the active key rotates', async () => {
    await batchComputeAddressHashes(addresses, { current: key });
    const rotatedKey = 'c'.repeat(32);
    await expect(batchComputeAddressHashes(addresses, { current: rotatedKey }))
      .resolves.toEqual(addresses.map((address) => computeAddressHashes(address, { current: rotatedKey })));
  });

  it('handles empty batches without creating work', async () => {
    await expect(batchComputeAddressHashes([], { current: key })).resolves.toEqual([]);
  });

  it('reuses an initialized pool for queued batch work and shuts it down', async () => {
    const pool = new PgcryptoHashWorkerPool({ current: key }, 1);
    await expect(Promise.all([pool.compute(addresses.slice(0, 2)), pool.compute(addresses.slice(2, 4))]))
      .resolves.toEqual([
        addresses.slice(0, 2).map((address) => computeAddressHashes(address, { current: key })),
        addresses.slice(2, 4).map((address) => computeAddressHashes(address, { current: key })),
      ]);
    await pool.shutdown();
    await expect(pool.compute(addresses)).rejects.toThrow('PGCrypto hash workers are unavailable');
  });

  it('uses a bounded worker count', () => {
    expect(hashWorkerCount()).toBeGreaterThanOrEqual(1);
    expect(hashWorkerCount()).toBeLessThanOrEqual(MAX_HASH_WORKERS);
  });

  it('fails closed inside the pool when worker startup is unavailable', async () => {
    const pool = new PgcryptoHashWorkerPool({ current: key }, 1, () => {
      throw new Error('worker startup disabled');
    });

    await expect(pool.compute(addresses)).rejects.toThrow('PGCrypto hash workers are unavailable');
  });

  it('marks the pool unavailable after a running worker fails', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const worker = {
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
        return worker;
      },
      off(event: string) {
        listeners.delete(event);
        return worker;
      },
      postMessage() {
        listeners.get('error')?.(new Error('worker task failure'));
      },
      terminate: async () => 0,
    };
    const pool = new PgcryptoHashWorkerPool({ current: key }, 1, () => worker);
    queueMicrotask(() => listeners.get('online')?.());

    await expect(pool.compute(addresses)).rejects.toThrow('PGCrypto hash worker failed');
    await expect(pool.compute(addresses)).rejects.toThrow('PGCrypto hash workers are unavailable');
  });

  it('passes keys only through workerData at worker creation', async () => {
    let source = '';
    let workerData: unknown;
    const pool = new PgcryptoHashWorkerPool({ current: key, previous }, 1, (workerSource, options) => {
      source = workerSource;
      workerData = options.workerData;
      throw new Error('stop after inspection');
    });

    await expect(pool.compute(addresses)).rejects.toThrow('PGCrypto hash workers are unavailable');
    expect(source).not.toContain(key);
    expect(source).not.toContain(previous);
    expect(workerData).toEqual({ current: key, previous });
  });
});
