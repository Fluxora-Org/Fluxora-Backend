/**
 * Bounded worker_threads pool for CPU-bound pgcrypto address HMAC batches.
 *
 * A pool is bound to one key set. Keys are cloned into workerData exactly once
 * when a worker starts; task messages contain addresses only.
 */
import { availableParallelism } from 'node:os';
import { Worker, type WorkerOptions } from 'node:worker_threads';

export interface WorkerKeySet {
  current: string;
  previous?: string;
}

export interface AddressHashes {
  current: string;
  previous?: string;
}

interface WorkerMessage {
  addresses: string[];
}

interface WorkerReply {
  hashes: AddressHashes[];
}

interface WorkerLike {
  once(event: 'online', listener: () => void): WorkerLike;
  once(event: 'error', listener: (error: Error) => void): WorkerLike;
  once(event: 'exit', listener: (code: number) => void): WorkerLike;
  off(event: 'online', listener: () => void): WorkerLike;
  off(event: 'error', listener: (error: Error) => void): WorkerLike;
  off(event: 'exit', listener: (code: number) => void): WorkerLike;
  postMessage(message: WorkerMessage): void;
  terminate(): Promise<number>;
}

export type WorkerFactory = (source: string, options: WorkerOptions) => WorkerLike;

/** Minimum batch size where worker startup and IPC are worthwhile. */
export const BATCH_HASH_THRESHOLD = 50;
/** Do not create more V8 isolates than this, even on very large hosts. */
export const MAX_HASH_WORKERS = 8;

export const hashWorkerCount = (): number => Math.min(MAX_HASH_WORKERS, Math.max(1, availableParallelism()));

// Kept self-contained so it works from both tsx/Vitest source execution and compiled CommonJS output.
// It receives keys only through workerData, never process.env or a task message.
const HASH_WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const crypto = require('node:crypto');
  const hash = (address, key) => crypto.createHmac('sha256', key).update(address, 'utf8').digest('hex');
  parentPort.on('message', ({ addresses }) => {
    const hashes = addresses.map((address) => ({
      current: hash(address, workerData.current),
      ...(workerData.previous ? { previous: hash(address, workerData.previous) } : {}),
    }));
    parentPort.postMessage({ hashes });
  });
`;

const createWorker: WorkerFactory = (source, options) => new Worker(source, options);

/**
 * Reusable, bounded hash-worker pool. A startup or runtime worker failure marks
 * the pool unavailable; callers can then use their synchronous fallback.
 */
export class PgcryptoHashWorkerPool {
  private readonly workers: WorkerLike[] = [];
  private readonly ready: Promise<void>;
  private unavailable = false;
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly keys: WorkerKeySet,
    private readonly workerCount = hashWorkerCount(),
    private readonly workerFactory: WorkerFactory = createWorker,
  ) {
    this.ready = this.start();
    // The first caller may reach compute after startup has already failed.
    // Keep that rejection observed while compute still receives it via await.
    void this.ready.catch(() => undefined);
  }

  /** Hash a batch, preserving the input address order. */
  public async compute(addresses: string[]): Promise<AddressHashes[]> {
    if (this.unavailable) {
      throw new Error('PGCrypto hash workers are unavailable');
    }

    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      await this.ready;
      if (this.unavailable) {
        throw new Error('PGCrypto hash workers are unavailable');
      }
      return await this.computeOnce(addresses);
    } finally {
      release();
    }
  }

  /** Terminate workers so their copies of the key set can be reclaimed. */
  public async shutdown(): Promise<void> {
    this.unavailable = true;
    await Promise.allSettled(this.workers.map((worker) => worker.terminate()));
    this.workers.length = 0;
  }

  private async start(): Promise<void> {
    const workers: WorkerLike[] = [];
    try {
      for (let index = 0; index < this.workerCount; index += 1) {
        workers.push(this.workerFactory(HASH_WORKER_SOURCE, {
          eval: true,
          workerData: { current: this.keys.current, previous: this.keys.previous },
        }));
      }
      await Promise.all(workers.map((worker) => this.waitForOnline(worker)));
      this.workers.push(...workers);
    } catch {
      this.unavailable = true;
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
      this.workers.length = 0;
      throw new Error('PGCrypto hash workers are unavailable');
    }
  }

  private waitForOnline(worker: WorkerLike): Promise<void> {
    return new Promise((resolve, reject) => {
      const onOnline = () => {
        worker.off('error', onError);
        resolve();
      };
      const onError = () => {
        worker.off('online', onOnline);
        reject(new Error('PGCrypto hash worker failed to start'));
      };
      worker.once('online', onOnline);
      worker.once('error', onError);
    });
  }

  private async computeOnce(addresses: string[]): Promise<AddressHashes[]> {
    if (addresses.length === 0) return [];

    const chunks = Array.from({ length: Math.min(this.workers.length, addresses.length) }, () => [] as string[]);
    for (let index = 0; index < addresses.length; index += 1) {
      chunks[index % chunks.length].push(addresses[index]);
    }
    const replies = await Promise.all(chunks.map((chunk, index) => this.run(this.workers[index], chunk)));
    const result: AddressHashes[] = new Array(addresses.length);
    for (let chunkIndex = 0; chunkIndex < replies.length; chunkIndex += 1) {
      for (let itemIndex = 0; itemIndex < replies[chunkIndex].length; itemIndex += 1) {
        result[itemIndex * chunks.length + chunkIndex] = replies[chunkIndex][itemIndex];
      }
    }
    return result;
  }

  private run(worker: WorkerLike, addresses: string[]): Promise<AddressHashes[]> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off('error', onFailure);
        worker.off('exit', onExit);
        (worker as Worker).off('message', onMessage);
      };
      const onMessage = (reply: WorkerReply) => {
        cleanup();
        resolve(reply.hashes);
      };
      const onFailure = () => {
        cleanup();
        this.unavailable = true;
        reject(new Error('PGCrypto hash worker failed'));
      };
      const onExit = (code: number) => {
        if (code !== 0) onFailure();
      };
      (worker as Worker).once('message', onMessage);
      worker.once('error', onFailure);
      worker.once('exit', onExit);
      worker.postMessage({ addresses });
    });
  }
}
