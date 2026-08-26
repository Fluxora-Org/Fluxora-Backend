/**
 * src/pii/pgcryptoWorker.ts
 *
 * Worker thread script for offloading HMAC address hashing from the main
 * event loop.  Loaded by `WorkerPool` via `new Worker(new URL(...))`.
 *
 * This file is **self-contained** — it does not import from any other project
 * module so it can be loaded directly by Node's `worker_threads` without
 * requiring a bundler or vitest transform pipeline.
 *
 * Protocol:
 *   - Receives `HashTaskMessage` via `parentPort.postMessage()`.
 *   - Computes HMAC digests using `crypto.createHmac` (inlined).
 *   - Posts `HashResultMessage` back with the matching `taskId`.
 *
 * Security:
 *   - Cryptographic keys arrive via `workerData` (structured clone) at
 *     worker creation time; the worker does NOT read environment variables
 *     or files for key material.
 *   - Keys are held in worker-local memory only for the lifetime of the
 *     worker and are garbage-collected when the worker terminates.
 *   - The worker never logs, serializes, or transmits key material.
 */

import { createHmac } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

export interface HashTaskMessage {
  type: 'hash';
  taskId: number;
  address: string;
  keys: { current: string; previous?: string };
}

export interface HashResultMessage {
  type: 'result';
  taskId: number;
  current: string;
  previous: string | undefined;
}

export interface HashErrorMessage {
  type: 'error';
  taskId: number;
  error: string;
}

if (!parentPort) {
  throw new Error('pgcryptoWorker must run inside a worker_threads Worker');
}

const port = parentPort;

function computeAddressHashLocal(address: string, key: string): string {
  return createHmac('sha256', key).update(address, 'utf8').digest('hex');
}

port.on('message', (msg: HashTaskMessage) => {
  try {
    const { taskId, address, keys } = msg;

    const current = computeAddressHashLocal(address, keys.current);
    const previous = keys.previous
      ? computeAddressHashLocal(address, keys.previous)
      : undefined;

    const result: HashResultMessage = { type: 'result', taskId, current, previous };
    port!.postMessage(result);
  } catch (err) {
    const errorMsg: HashErrorMessage = {
      type: 'error',
      taskId: msg.taskId,
      error: err instanceof Error ? err.message : String(err),
    };
    port!.postMessage(errorMsg);
  }
});
