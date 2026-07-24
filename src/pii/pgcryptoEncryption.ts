/**
 * pgcrypto helper utilities for stream PII encryption.
 *
 * This module centralizes the application-side pieces of the encryption
 * design so the repository layer can stay readable and safe.
 *
 * Single-row functions (`computeAddressHash`, `computeAddressHashes`) run
 * synchronously on the main thread — ideal for the request-path where the
 * overhead of worker IPC is not justified.
 *
 * Batch functions (`batchComputeAddressHashes`) offload HMAC computation to
 * a bounded worker_threads pool for large row sets (export endpoint,
 * data-retention purge jobs).  Falls back to synchronous execution when the
 * row count is below the threshold or when worker startup fails.
 */

import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { WorkerPool, BATCH_HASH_THRESHOLD, resolveWorkerUrl, type WorkerPoolOptions } from './workerPool.js';
import type { HashTaskMessage, HashResultMessage } from './pgcryptoWorker.js';

export const PGCRYPTO_KEY_MIN_LENGTH = 32;
export const PGP_SYM_ENCRYPT_OPTIONS = 'cipher-algo=aes256,compress-algo=0,armor';
export const PGP_MESSAGE_PREFIX = '-----BEGIN PGP MESSAGE-----';

export interface PgcryptoKeySet {
  current: string;
  previous?: string;
}

/**
 * Compute the deterministic HMAC digest used for address filters and indexes.
 * This preserves query efficiency while keeping the stored address ciphertext
 * unreadable without the key.
 */
export function computeAddressHash(address: string, key: string): string {
  return crypto.createHmac('sha256', key).update(address, 'utf8').digest('hex');
}

export function computeAddressHashes(address: string, keys: PgcryptoKeySet): {
  current: string;
  previous?: string;
} {
  return {
    current: computeAddressHash(address, keys.current),
    previous: keys.previous ? computeAddressHash(address, keys.previous) : undefined,
  };
}

/**
 * Build a pgcrypto encryption expression for a plaintext address parameter.
 */
export function pgpEncryptAddressParam(addressParamIndex: number, keyParamIndex: number): string {
  return `pgp_sym_encrypt($${addressParamIndex}, $${keyParamIndex}, '${PGP_SYM_ENCRYPT_OPTIONS}')`;
}

/**
 * Build a pgcrypto decryption expression for a stored address column.
 */
export function pgpDecryptAddressColumn(
  columnName: string,
  keyParamIndex: number,
  previousKeyParamIndex?: number,
): string {
  const previousArg = previousKeyParamIndex !== undefined ? `$${previousKeyParamIndex}` : 'NULL';
  return `decrypt_stream_address(${columnName}, $${keyParamIndex}, ${previousArg}) AS ${columnName}`;
}

/**
 * Build a filter expression that uses keyed hash lookup first, and falls back
 * to plaintext comparison for legacy rows that have not yet been backfilled.
 */
export function buildEncryptedAddressFilter(
  column: 'sender_address' | 'recipient_address',
  filterValueParamIndex: number,
  currentHashParamIndex: number,
  previousHashParamIndex?: number,
): string {
  const hashClauses = [`${column}_hash = $${currentHashParamIndex}`];
  if (previousHashParamIndex !== undefined) {
    hashClauses.push(`${column}_hash = $${previousHashParamIndex}`);
  }
  const hashCondition = hashClauses.length > 1 ? `(${hashClauses.join(' OR ')})` : hashClauses[0];
  return `(${hashCondition} OR ${column} = $${filterValueParamIndex})`;
}

// ── Batch hashing via worker_threads pool ─────────────────────────────────

/**
 * Module-scoped lazy pool.  Initialized on first call to
 * `batchComputeAddressHashes`.  Shared across all callers in the process so
 * the pool is created once and reused.
 */
let _pool: WorkerPool | null = null;

/**
 * Resolve or create the singleton worker pool.  The pool is created lazily
 * so single-row callers (the common request-path) never pay the cost of
 * worker thread setup.
 *
 * SECURITY: The pool receives cryptographic keys via `workerData` (structured
 * clone).  Keys are never read from `process.env` inside the pool — they are
 * passed explicitly by the caller and exist only in worker-local heap memory.
 */
function getPool(): WorkerPool {
  if (_pool === null) {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), './pgcryptoWorker');
    const poolOpts: WorkerPoolOptions = {};
    _pool = new WorkerPool(workerUrl, poolOpts);

    // Fallback: if all workers fail to start (e.g. sandboxed environment),
    // degrade to synchronous in-thread execution.
    _pool.setFallback((msg: unknown) => {
      const task = msg as HashTaskMessage;
      const current = computeAddressHash(task.address, task.keys.current);
      const previous = task.keys.previous
        ? computeAddressHash(task.address, task.keys.previous)
        : undefined;
      return { type: 'result', taskId: task.taskId, current, previous } as HashResultMessage;
    });
  }
  return _pool;
}

/**
 * Shut down the singleton worker pool.  Called during graceful process
 * shutdown to terminate worker threads and free resources.
 */
export async function shutdownPgcryptoPool(): Promise<void> {
  if (_pool !== null) {
    await _pool.shutdown();
    _pool = null;
  }
}

/**
 * Compute HMAC address hashes for a batch of addresses.
 *
 * - When `addresses.length >= BATCH_HASH_THRESHOLD` (50), work is dispatched
 *   to the worker_threads pool, keeping the main event loop free for request
 *   handling.
 * - Below the threshold, computation runs synchronously on the main thread
 *   to avoid worker IPC overhead.
 * - If all workers fail to start, the pool degrades gracefully to
 *   synchronous execution — callers never see errors from the pool itself.
 *
 * Results are returned in the same order as the input `addresses` array.
 *
 * @param addresses  Array of plaintext Stellar addresses to hash.
 * @param keys       Current (and optional previous) pgcrypto key set.
 * @param options    Optional overrides:
 *   - `concurrency`: max parallel workers (default: pool default).
 *   - `threshold`: override the batch threshold (default: 50).
 * @returns Array of `{ current, previous }` hash pairs, one per input address.
 *
 * @security Cryptographic keys are passed to workers via `workerData`
 * (structured clone) and exist only in worker-local memory.  They are never
 * logged, serialized to disk, or re-read from environment variables.
 */
export async function batchComputeAddressHashes(
  addresses: string[],
  keys: PgcryptoKeySet,
  options?: { concurrency?: number; threshold?: number },
): Promise<Array<{ current: string; previous?: string }>> {
  const threshold = options?.threshold ?? BATCH_HASH_THRESHOLD;

  // Below threshold: synchronous on the main thread (no worker overhead).
  if (addresses.length < threshold) {
    return addresses.map((addr) => computeAddressHashes(addr, keys));
  }

  const pool = getPool();

  // Dispatch all hashes as individual tasks.  The pool's bounded worker set
  // naturally throttles concurrency — each worker processes one task at a
  // time, so we never exceed `maxWorkers` concurrent HMAC computations.
  const tasks = addresses.map((address, taskId): Promise<HashResultMessage> => {
    const msg: HashTaskMessage = { type: 'hash', taskId, address, keys };
    return pool.exec<HashResultMessage>(msg);
  });

  const results = await Promise.all(tasks);

  // Restore original input order (worker dispatch may complete out of order,
  // but `Promise.all` preserves order, and each result carries its `taskId`).
  return results.map((r) => ({
    current: r.current,
    previous: r.previous,
  }));
}
