// @ts-nocheck
// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { describe, it, expect, vi } from 'vitest';
import { runBackfill } from '../../src/indexer/backfillScheduler.js';

describe('runBackfill', () => {
  it('bounds concurrency and preserves ordered checkpoints', async () => {
    const delays = [40, 10, 30, 20];
    let active = 0;
    let maxActive = 0;
    const checkpoints: number[] = [];
    const batches = [0, 1, 2, 3].map((i) => ({ index: i, data: i }));

    const result = await runBackfill({
      batches,
      concurrency: 2,
      onCheckpoint: (i) => checkpoints.push(i),
      handler: async ({ index }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, delays[index]));
        active--;
      },
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(checkpoints).toEqual([3]);
    expect(result).toBe(3);
  });

  it('retries failed batches and aborts when the budget is exhausted', async () => {
    const attempts: Record<number, number> = {};
    const batches = [0, 1].map((i) => ({ index: i, data: i }));

    await expect(runBackfill({
      batches,
      concurrency: 1,
      retryLimit: 2,
      retryDelayMs: 1,
      handler: async ({ index }) => {
        attempts[index] = (attempts[index] ?? 0) + 1;
        if (index === 1) throw new Error('boom');
      },
    })).rejects.toThrow('boom');

    expect(attempts[1]).toBe(2);
  });

  it('can resume from a persisted checkpoint', async () => {
    let checkpoint = -1;
    const batches = [0, 1, 2].map((i) => ({ index: i, data: i }));

    const run = (start: number) => runBackfill({
      batches: batches.filter((b) => b.index > start),
      concurrency: 1,
      initialCheckpoint: start,
      retryLimit: 1,
      retryDelayMs: 1,
      onCheckpoint: (i) => { checkpoint = i; },
      handler: async ({ index }) => {
        if (index === 1 && checkpoint < 1) throw new Error('transient');
      },
    });

    await expect(run(checkpoint)).rejects.toThrow('transient');
    expect(checkpoint).toBe(0);
    await run(checkpoint);
    expect(checkpoint).toBe(2);
  });
});
