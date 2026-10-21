import { describe, it, expect, afterEach } from 'vitest';
import { pathToFileURL } from 'url';
import {
  WorkerPool,
  PoolInvalidInputError,
  validateTaskMessage,
  resolveWorkerUrl,
  DEFAULT_MAX_MESSAGE_SIZE_BYTES,
} from './workerPool.js';

// ── validateTaskMessage ──────────────────────────────────────────────────

describe('validateTaskMessage', () => {
  it('accepts a normal task-shaped object', () => {
    expect(() =>
      validateTaskMessage({ type: 'hash', taskId: 0, address: 'G...', keys: { current: 'k' } }),
    ).not.toThrow();
  });

  it('accepts a non-empty string', () => {
    expect(() => validateTaskMessage('ping')).not.toThrow();
  });

  it('accepts a non-empty array', () => {
    expect(() => validateTaskMessage([1, 2, 3])).not.toThrow();
  });

  it('accepts a message at exactly the size limit', () => {
    // '"' + N chars + '"' == N + 2 bytes when JSON-serialized.
    const value = 'a'.repeat(98);
    expect(() => validateTaskMessage(value, 100)).not.toThrow();
  });

  it('rejects undefined', () => {
    expect(() => validateTaskMessage(undefined)).toThrow(PoolInvalidInputError);
  });

  it('rejects null', () => {
    expect(() => validateTaskMessage(null)).toThrow(PoolInvalidInputError);
  });

  it('rejects an empty string', () => {
    expect(() => validateTaskMessage('')).toThrow(PoolInvalidInputError);
  });

  it('rejects an empty array', () => {
    expect(() => validateTaskMessage([])).toThrow(PoolInvalidInputError);
  });

  it('rejects an empty object', () => {
    expect(() => validateTaskMessage({})).toThrow(PoolInvalidInputError);
  });

  it('rejects a function (not structured-cloneable)', () => {
    expect(() => validateTaskMessage(() => {})).toThrow(PoolInvalidInputError);
  });

  it('rejects a value containing a circular reference', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => validateTaskMessage(circular)).toThrow(PoolInvalidInputError);
  });

  it('rejects a message exceeding the size limit', () => {
    const oversized = 'a'.repeat(1001);
    expect(() => validateTaskMessage(oversized, 1000)).toThrow(PoolInvalidInputError);
  });

  it('rejects a message exceeding the default size limit', () => {
    const oversized = 'a'.repeat(DEFAULT_MAX_MESSAGE_SIZE_BYTES + 1);
    expect(() => validateTaskMessage(oversized)).toThrow(PoolInvalidInputError);
  });

  it('carries a reason distinguishing why the input was rejected', () => {
    try {
      validateTaskMessage(undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PoolInvalidInputError);
      expect((err as PoolInvalidInputError).reason).toMatch(/null or undefined/);
    }

    try {
      validateTaskMessage('a'.repeat(1001), 1000);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PoolInvalidInputError);
      expect((err as PoolInvalidInputError).reason).toMatch(/exceeds the maximum allowed size/);
    }

    try {
      validateTaskMessage({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PoolInvalidInputError);
      expect((err as PoolInvalidInputError).reason).toMatch(/empty object/);
    }
  });
});

// ── WorkerPool.exec input validation ─────────────────────────────────────

describe('WorkerPool.exec input validation', () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
      pool = null;
    }
  });

  function freshPool(options?: ConstructorParameters<typeof WorkerPool>[1]): WorkerPool {
    const workerUrl = resolveWorkerUrl(pathToFileURL(__filename), './pgcryptoWorker');
    pool = new WorkerPool(workerUrl, { maxWorkers: 1, ...options });
    return pool;
  }

  it('rejects null/undefined/empty messages with PoolInvalidInputError', async () => {
    const p = freshPool();
    await expect(p.exec(undefined)).rejects.toBeInstanceOf(PoolInvalidInputError);
    await expect(p.exec(null)).rejects.toBeInstanceOf(PoolInvalidInputError);
    await expect(p.exec('')).rejects.toBeInstanceOf(PoolInvalidInputError);
    await expect(p.exec({})).rejects.toBeInstanceOf(PoolInvalidInputError);
    await expect(p.exec([])).rejects.toBeInstanceOf(PoolInvalidInputError);
  });

  it('rejects malformed (non-cloneable) messages with PoolInvalidInputError', async () => {
    const p = freshPool();
    await expect(p.exec(() => {})).rejects.toBeInstanceOf(PoolInvalidInputError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(p.exec(circular)).rejects.toBeInstanceOf(PoolInvalidInputError);
  });

  it('rejects oversized messages with PoolInvalidInputError', async () => {
    const p = freshPool({ maxMessageSizeBytes: 1000 });
    await expect(p.exec('a'.repeat(1001))).rejects.toBeInstanceOf(PoolInvalidInputError);
  });

  it('lets the caller distinguish the rejection reason', async () => {
    const p = freshPool();
    await expect(p.exec(undefined)).rejects.toThrow(/null or undefined/);
  });

  it('does not create a worker or touch the queue when input is rejected', async () => {
    const p = freshPool();

    await expect(p.exec(undefined)).rejects.toBeInstanceOf(PoolInvalidInputError);

    expect(p.workerCount).toBe(0);
    expect(p.queuedCount).toBe(0);
    expect(p.pendingCount).toBe(0);
  });

  it('does not affect a subsequent valid task after a rejected one', async () => {
    const p = freshPool({ workerData: { keys: { current: 'a'.repeat(32) } } });

    await expect(p.exec(undefined)).rejects.toBeInstanceOf(PoolInvalidInputError);

    const result = await p.exec<{ type: string }>({
      type: 'hash',
      taskId: 0,
      address: 'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY',
      keys: { current: 'a'.repeat(32) },
    });

    expect(result.type).toBe('result');
  });

  it('accepts a valid, normally-shaped task message unaffected by validation', async () => {
    const p = freshPool({ workerData: { keys: { current: 'a'.repeat(32) } } });

    const result = await p.exec<{ type: string; current: string }>({
      type: 'hash',
      taskId: 0,
      address: 'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY',
      keys: { current: 'a'.repeat(32) },
    });

    expect(result.type).toBe('result');
    expect(typeof result.current).toBe('string');
  });

  it('rejects before checking shutdown-independent state even when queue is already busy', async () => {
    const p = freshPool({ workerData: { keys: { current: 'a'.repeat(32) } }, maxQueueSize: 5 });

    const valid = p.exec({
      type: 'hash',
      taskId: 0,
      address: 'GDRXE2BQUC3AZ7D3G7BMNJ4XOSXHG6YKO4IZ3Y4S7HNW3F4AWMRI6ZIY',
      keys: { current: 'a'.repeat(32) },
    });

    await expect(p.exec(null)).rejects.toBeInstanceOf(PoolInvalidInputError);
    expect(p.queuedCount).toBe(0);

    await valid;
  });
});
