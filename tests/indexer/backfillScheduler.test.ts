// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBackfill } from '../../src/indexer/backfillScheduler.js';
import {
  indexerBackfillPaused,
  indexerBackfillYieldEventsTotal,
  resetBackfillYieldMetrics,
} from '../../src/metrics/indexerLag.js';

/** Read the `indexer_backfill_yield_events_total` counter for one direction. */
async function yieldEventCount(event: 'paused' | 'resumed'): Promise<number> {
  const { values } = await indexerBackfillYieldEventsTotal.get();
  return values.find((v) => v.labels.event === event)?.value ?? 0;
}

beforeEach(() => {
  resetBackfillYieldMetrics();
});

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
      onCheckpoint: (i) => { checkpoints.push(i); },
      handler: async ({ index }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, delays[index]));
        active--;
      },
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    // Checkpoints only ever advance, and the final one covers the whole run.
    // (The exact intermediate values depend on completion order.)
    expect(checkpoints.length).toBeGreaterThan(0);
    expect([...checkpoints].sort((a, b) => a - b)).toEqual(checkpoints);
    expect(checkpoints[checkpoints.length - 1]).toBe(3);
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
    let failedOnce = false;
    const batches = [0, 1, 2].map((i) => ({ index: i, data: i }));

    const run = (start: number) => runBackfill({
      batches: batches.filter((b) => b.index > start),
      concurrency: 1,
      initialCheckpoint: start,
      retryLimit: 1,
      retryDelayMs: 1,
      onCheckpoint: (i) => { checkpoint = i; },
      handler: async ({ index }) => {
        // Fail the first attempt at index 1 only; the resumed run must succeed.
        if (index === 1 && !failedOnce) {
          failedOnce = true;
          throw new Error('transient');
        }
      },
    });

    await expect(run(checkpoint)).rejects.toThrow('transient');
    expect(checkpoint).toBe(0);
    await run(checkpoint);
    expect(checkpoint).toBe(2);
  });
});

// ── Live-indexing yield rule ──────────────────────────────────────────────────
//
// The documented schedule: backfill pauses while live indexing lags
// (`lag >= maxLiveIndexingLag`), resumes automatically once the lag drops back
// below the threshold, and reports each decision through callbacks and metrics.
describe('runBackfill — yields to live indexing', () => {
  const makeBatches = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ index: i, data: i }));

  it('runs uninterrupted while the lag stays below the threshold', async () => {
    const processed: number[] = [];
    const onYield = vi.fn();
    const onResume = vi.fn();

    const result = await runBackfill({
      batches: makeBatches(3),
      concurrency: 1,
      liveIndexingLag: () => 5,
      maxLiveIndexingLag: 10,
      onYield,
      onResume,
      handler: async ({ index }) => {
        processed.push(index);
      },
    });

    expect(processed).toEqual([0, 1, 2]);
    expect(result).toBe(2);
    expect(onYield).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();

    const paused = await indexerBackfillPaused.get();
    expect(paused.values[0].value).toBe(0);
    expect(await yieldEventCount('paused')).toBe(0);
    expect(await yieldEventCount('resumed')).toBe(0);
  });

  it('pauses while live indexing lags and resumes automatically', async () => {
    let lag = 50;
    let pollsWhilePaused = 0;
    let pausedGaugeDuringYield: number | undefined;
    const processed: number[] = [];
    const pauses: number[] = [];
    const resumes: number[] = [];

    const result = await runBackfill({
      batches: makeBatches(3),
      concurrency: 1,
      liveIndexingLag: () => lag,
      maxLiveIndexingLag: 10,
      yieldPollIntervalMs: 1,
      onYield: (l) => pauses.push(l),
      onResume: (l) => resumes.push(l),
      sleep: async () => {
        // Observe the pause while it is in effect.
        pausedGaugeDuringYield = (await indexerBackfillPaused.get()).values[0].value;
        pollsWhilePaused++;
        // Live indexing catches up after a couple of poll intervals.
        lag = pollsWhilePaused >= 2 ? 0 : 50;
      },
      handler: async ({ index }) => {
        // No handler may run while the lag is at or above the threshold.
        expect(lag).toBeLessThan(10);
        processed.push(index);
      },
    });

    expect(processed).toEqual([0, 1, 2]);
    expect(result).toBe(2);
    expect(pauses).toEqual([50]);
    expect(resumes).toEqual([0]);
    expect(pollsWhilePaused).toBe(2);
    expect(pausedGaugeDuringYield).toBe(1);

    // Once complete the scheduler is no longer paused and both transitions
    // were recorded exactly once.
    const paused = await indexerBackfillPaused.get();
    expect(paused.values[0].value).toBe(0);
    expect(await yieldEventCount('paused')).toBe(1);
    expect(await yieldEventCount('resumed')).toBe(1);
  });

  it('reports one pause/resume even when workers are concurrent', async () => {
    let lag = 100;
    let polls = 0;
    const pauses: number[] = [];
    const resumes: number[] = [];

    const result = await runBackfill({
      batches: makeBatches(4),
      concurrency: 4,
      liveIndexingLag: () => lag,
      maxLiveIndexingLag: 10,
      yieldPollIntervalMs: 1,
      onYield: (l) => pauses.push(l),
      onResume: (l) => resumes.push(l),
      sleep: async () => {
        polls++;
        lag = 0;
      },
      handler: async () => {},
    });

    expect(result).toBe(3);
    expect(pauses).toEqual([100]);
    expect(resumes).toEqual([0]);
    expect(polls).toBe(1);
    expect(await yieldEventCount('paused')).toBe(1);
    expect(await yieldEventCount('resumed')).toBe(1);
  });

  it('pauses again after a later recovery', async () => {
    // Reads: pause, recover, pause, recover.
    const lagReads = [50, 0, 50, 0];
    let reads = 0;
    const pauses: number[] = [];
    const resumes: number[] = [];

    await runBackfill({
      batches: makeBatches(2),
      concurrency: 1,
      liveIndexingLag: () => lagReads[Math.min(reads++, lagReads.length - 1)],
      maxLiveIndexingLag: 10,
      yieldPollIntervalMs: 1,
      onYield: (l) => pauses.push(l),
      onResume: (l) => resumes.push(l),
      sleep: async () => {},
      handler: async () => {},
    });

    expect(pauses).toEqual([50, 50]);
    expect(resumes).toEqual([0, 0]);
    expect(await yieldEventCount('paused')).toBe(2);
    expect(await yieldEventCount('resumed')).toBe(2);
  });

  it('does not pause when no lag reader is configured', async () => {
    const onYield = vi.fn();

    const result = await runBackfill({
      batches: makeBatches(2),
      concurrency: 1,
      maxLiveIndexingLag: 10,
      onYield,
      handler: async () => {},
    });

    expect(result).toBe(1);
    expect(onYield).not.toHaveBeenCalled();
  });

  it('does not pause when the threshold is zero (yielding disabled)', async () => {
    const onYield = vi.fn();

    const result = await runBackfill({
      batches: makeBatches(2),
      concurrency: 1,
      liveIndexingLag: () => 100,
      maxLiveIndexingLag: 0,
      onYield,
      handler: async () => {},
    });

    expect(result).toBe(1);
    expect(onYield).not.toHaveBeenCalled();
  });

  it('does not stall when the lag reader throws', async () => {
    const result = await runBackfill({
      batches: makeBatches(1),
      concurrency: 1,
      liveIndexingLag: () => {
        throw new Error('metrics unavailable');
      },
      maxLiveIndexingLag: 10,
      handler: async () => {},
    });

    expect(result).toBe(0);
  });
});
