/**
 * src/pii/workerPool.ts
 *
 * Generic bounded worker_threads pool with graceful degradation.
 *
 * Design goals:
 *   - Bounded concurrency derived from `os.availableParallelism()` with a
 *     configurable hard cap (default: 8 workers).
 *   - Transparent fallback: if worker startup fails (e.g. sandboxed or
 *     restricted environments), the pool degrades to synchronous in-thread
 *     execution so the caller's logic is never broken.
 *   - Secure key delivery: cryptographic material is passed to workers via
 *     `workerData` (structured clone) at creation time.  The pool never reads
 *     environment variables for keys and never logs key material.
 *   - Clean shutdown: `shutdown()` terminates all workers and drains pending
 *     tasks, rejecting queued work with `PoolShutdownError`.
 *
 * ## Usage
 *
 * ```ts
 * const pool = new WorkerPool(new URL('./myWorker.js', import.meta.url), {
 *   workerData: { pgcryptoKeys: { current: '...' } },
 * });
 * const result = await pool.exec<MyResult>({ type: 'hash', ... });
 * await pool.shutdown();
 * ```
 *
 * `@security` Keys passed via `workerData` are structured-cloned into each
 * worker's V8 isolate.  They exist only in worker-local heap memory and are
 * garbage-collected when the worker terminates.  The pool never serializes
 * keys back to the parent thread or writes them to disk.
 */

import { Worker } from 'worker_threads';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Resolve a worker script URL by trying `.js` first (compiled output in
 * `dist/`) then `.ts` (source in dev/vitest).  This lets the same code work
 * in both production (compiled CJS) and development (vitest + Node 25 TS
 * strip-types).
 */
export function resolveWorkerUrl(base: URL, basename: string): URL {
  const jsUrl = new URL(`${basename}.js`, base);
  try {
    fs.accessSync(jsUrl);
    return jsUrl;
  } catch {
    // .js not found — fall back to .ts (Node 25+ type-stripping).
    return new URL(`${basename}.ts`, base);

  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkerPoolOptions {
  /**
   * Maximum number of workers.  Clamped to `[1, DEFAULT_MAX_WORKERS]`.
   * When omitted, derived from `os.availableParallelism()` with a cap.
   */
  maxWorkers?: number;
 
  /**
   * Data passed to every worker via `workerData` (structured clone).
   * Must not contain non-cloneable values (functions, symbols, handles).
   */
  workerData?: Record<string, unknown>;
}

export class PoolShutdownError extends Error {
  constructor() {
    super('WorkerPool has been shut down');
    this.name = 'PoolShutdownError';
    
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Hard upper bound on worker count.  Even on 64-core machines we never spin
 * up more than 8 workers for HMAC hashing — the per-worker overhead (V8
 * isolate, event loop) is not justified beyond this point.
 */
export const DEFAULT_MAX_WORKERS = 8;

/**
 * Minimum number of addresses before batch hashing is dispatched to workers.
 * Below this threshold the overhead of worker IPC exceeds the benefit of
 * parallel execution, so `batchComputeAddressHashes` falls back to
 * synchronous in-thread hashing.
 */
export const BATCH_HASH_THRESHOLD = 50;

/**
 * Resolve the default worker count: `min(os.availableParallelism(), cap)`.
 * Falls back to 2 if `availableParallelism` is unavailable (older Node).
 */
export function resolveWorkerCount(cap: number = DEFAULT_MAX_WORKERS): number {
  const available = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(available, cap));
}

// ── Pool implementation ────────────────────────────────────────────────────

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  healthy: boolean;
}

interface PendingTask {
  taskId: number;
  message: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Bounded worker_threads pool with FIFO task dispatch and graceful degradation.
 *
 * If ALL workers fail to start, `exec()` falls back to calling the supplied
 * `fallback` function synchronously on the main thread.  This ensures the
 * caller's logic is never broken by environment restrictions.
 */
export class WorkerPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly workerUrl: URL;
  private readonly workerData: Record<string, unknown> | undefined;
  private readonly maxWorkers: number;
  private nextTaskId = 0;
  private activeTasks = 0;
  private shutdownFlag = false;
  private fallbackFn: ((msg: unknown) => unknown) | null = null;
  private allWorkersFailed = false;

  constructor(workerUrl: URL, options?: WorkerPoolOptions) {
    this.workerUrl = workerUrl;
    this.maxWorkers = resolveWorkerCount(options?.maxWorkers);
    this.workerData = options?.workerData;
  }

  /**
   * Register a synchronous fallback function invoked when the pool has
   * zero healthy workers (all startup attempts failed).
   */
  setFallback(fn: (msg: unknown) => unknown): void {
    this.fallbackFn = fn;
  }

  /**
   * Dispatch a task to an idle worker (or queue it if all workers are busy).
   * Returns a promise that resolves with the worker's response.
   *
   * When `allWorkersFailed` is true and a fallback is registered, the task
   * is executed synchronously on the main thread instead.
   */
  exec<T>(message: unknown): Promise<T> {
    if (this.shutdownFlag) {
      return Promise.reject(new PoolShutdownError());
    }

    // Degrade to synchronous fallback if no workers are available.
    if (this.allWorkersFailed && this.fallbackFn) {
      try {
        const result = this.fallbackFn(message);
        return Promise.resolve(result as T);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return new Promise<T>((resolve, reject) => {
      const taskId = this.nextTaskId++;
      const task: PendingTask = {
        taskId,
        message,
        resolve: resolve as (v: unknown) => void,
        reject,
      };

      const idle = this.findIdleSlot();
      if (idle >= 0) {
        this.dispatch(idle, task);
      } else if (this.slots.length < this.maxWorkers) {
        this.createWorkerAndDispatch(task);
      } else {
        this.queue.push(task);
      }
    });
  }

  /**
   * Terminate all workers and drain pending tasks.
   * Queued tasks are rejected with `PoolShutdownError`.
   */
  async shutdown(): Promise<void> {
    this.shutdownFlag = true;

    // Reject all queued tasks.
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.reject(new PoolShutdownError());
    }

    // Terminate all workers.
    const terminations = this.slots.map((slot) =>
      slot.worker.terminate().catch(() => { /* already dead */ }),
    );
    await Promise.allSettled(terminations);
    this.slots.length = 0;
  }

  /** Number of tasks currently executing across all workers. */
  get pendingCount(): number {
    return this.activeTasks;
  }

  /** Number of tasks waiting in the queue for an idle worker. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Number of worker threads in the pool. */
  get workerCount(): number {
    return this.slots.length;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private findIdleSlot(): number {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i].busy) return i;
    }
    return -1;
  }

  private dispatch(slotIndex: number, task: PendingTask): void {
    const slot = this.slots[slotIndex];
    slot.busy = true;
    this.activeTasks++;

    const handler = (msg: unknown) => {
      slot.busy = false;
      this.activeTasks--;
      slot.worker.removeListener('message', handler);
      slot.worker.removeListener('error', errorHandler);

      // Workers emit { type: 'error', taskId, error } on task-level failures.
      // Resolve the task as a rejection so callers receive an Error, not a
      // success value shaped like an error message.
      if (msg !== null && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'error') {
        const workerErr = (msg as Record<string, unknown>).error;
        task.reject(new Error(typeof workerErr === 'string' ? workerErr : 'Worker task failed'));
      } else {
        task.resolve(msg);
      }

      this.drainQueue(slotIndex);
    };

    const errorHandler = (err: Error) => {
      slot.busy = false;
      slot.healthy = false;
      this.activeTasks--;
      slot.worker.removeListener('message', handler);
      slot.worker.removeListener('error', errorHandler);

      if (this.slots.every((s) => !s.healthy) && this.fallbackFn) {
        this.allWorkersFailed = true;
        this.invokeFallback(task);
      } else {
        task.reject(err);
      }
      this.drainQueue(slotIndex);
    };

    slot.worker.on('message', handler);
    slot.worker.on('error', errorHandler);
    slot.worker.postMessage(task.message);
  }

  private drainQueue(slotIndex: number): void {
    if (this.shutdownFlag) return;
    if (this.queue.length === 0) return;

    const task = this.queue.shift()!;
    this.dispatch(slotIndex, task);
  }

  private createWorkerAndDispatch(task: PendingTask): void {
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl, {
        workerData: this.workerData,
      });
    } catch {
      // Synchronous construction failure — degrade to fallback immediately.
      this.allWorkersFailed = true;
      this.invokeFallback(task);
      return;
    }

    const slotIndex = this.slots.length;
    const slot: WorkerSlot = { worker, busy: true, healthy: true };
    this.slots.push(slot);

    // Track whether the worker came online or failed during startup.
    // The first handler to fire wins; the other is a no-op.
    let settled = false;

    const onStartupError = (err: Error) => {
      if (settled) return;
      settled = true;

      slot.healthy = false;

      if (this.slots.every((s) => !s.healthy)) {
        this.allWorkersFailed = true;
      }

      // The task was never dispatched, so reject it directly (no
      // activeTasks/bookkeeping to undo).
      if (this.allWorkersFailed && this.fallbackFn) {
        this.invokeFallback(task);
      } else {
        task.reject(err);
      }
    };

    const onOnline = () => {
      if (settled) return;
      settled = true;
      this.dispatch(slotIndex, task);
    };

    worker.once('error', onStartupError);
    worker.once('online', onOnline);
  }

  private invokeFallback(task: PendingTask): void {
    if (this.fallbackFn) {
      try {
        const result = this.fallbackFn(task.message);
        task.resolve(result);
      } catch (err) {
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      task.reject(new Error('All workers failed and no fallback registered'));
    }
  }
}
