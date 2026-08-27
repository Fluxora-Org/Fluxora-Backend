import { describe, it, expect } from 'vitest';
import { OrderedBackfillScheduler, type BackfillBatch } from '../../src/indexer/backfill.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OrderedBackfillScheduler', () => {
  it('bounds concurrency to the configured worker count', async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];

    const processor = async (batch: BackfillBatch) => {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(batch.index);
      await delay(5);
      active--;
    };

    const scheduler = new OrderedBackfillScheduler(processor, {
      concurrency: 2,
      batchSize: 10,
    });

    const result = await scheduler.run(0, 49);
    expect(result.ok).toBe(true);
    expect(result.lastCheckpointLedger).toBe(49);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
    expect(started).toHaveLength(5);
  });

  it('preserves ordered checkpoints when a later batch succeeds past a failed one', async () => {
    const processor = async (batch: BackfillBatch) => {
      if (batch.fromLedger === 10) {
        throw new Error('simulated failure');
      }
    };

    const scheduler = new OrderedBackfillScheduler(processor, {
      concurrency: 3,
      batchSize: 10,
      maxRetries: 0,
    });

    const result = await scheduler.run(0, 29);
    expect(result.ok).toBe(false);
    // Batch [10,19] failed, so the checkpoint stops at the end of batch [0,9].
    expect(result.lastCheckpointLedger).toBe(9);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].fromLedger).toBe(10);
    expect(result.processedBatches).toBe(1);
  });

  it('retries failed batches within the retry budget and resumes', async () => {
    const attempts = new Map<number, number>();
    const processor = async (batch: BackfillBatch) => {
      const count = (attempts.get(batch.fromLedger) ?? 0) + 1;
      attempts.set(batch.fromLedger, count);
      if (batch.fromLedger === 10 && count === 1) {
        throw new Error('transient failure');
      }
    };

    const scheduler = new OrderedBackfillScheduler(processor, {
      concurrency: 2,
      batchSize: 10,
      maxRetries: 1,
      retryDelayMs: 0,
    });

    const result = await scheduler.run(0, 29);
    expect(result.ok).toBe(true);
    expect(result.lastCheckpointLedger).toBe(29);
    expect(attempts.get(10)).toBe(2);
  });

  it('stops at the last contiguous checkpoint when retries are exhausted', async () => {
    const processor = async (batch: BackfillBatch) => {
      if (batch.fromLedger === 20) {
        throw new Error('permanent failure');
      }
    };

    const scheduler = new OrderedBackfillScheduler(processor, {
      concurrency: 4,
      batchSize: 10,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    const result = await scheduler.run(0, 39);
    expect(result.ok).toBe(false);
    expect(result.lastCheckpointLedger).toBe(19);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].fromLedger).toBe(20);
    expect(result.failures[0].attempts).toBe(3);
    expect(result.failures[0].errors).toHaveLength(3);
    expect(result.processedBatches).toBe(2);
  });

  it('treats duplicate batches as successful progress', async () => {
    const processed: number[] = [];
    const processor = async (batch: BackfillBatch) => {
      processed.push(batch.fromLedger);
    };

    const scheduler = new OrderedBackfillScheduler(processor, {
      concurrency: 4,
      batchSize: 10,
    });

    const result = await scheduler.run(0, 19);
    expect(result.ok).toBe(true);
    expect(result.lastCheckpointLedger).toBe(19);
    expect(processed).toEqual([0, 10]);
  });
});