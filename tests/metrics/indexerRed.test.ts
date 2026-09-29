/**
 * Indexer RED collector — partial batch failures.
 *
 * The failure state this file exists to pin down: a replay batch that did work
 * but was rolled back before `COMMIT` (a cooperative stop requested mid-batch)
 * throws nothing, so a whole-batch-only error counter stays at zero while rows
 * are being dropped. The collector must reflect that state, the error rate must
 * count it, and every label it publishes must stay inside a bounded vocabulary.
 *
 * Every assertion reads the *published* value — either the collector snapshot
 * (`Counter.get()`) or the `/metrics` exposition text (`registry.metrics()`) —
 * rather than a spy, so the series an operator would actually scrape is what is
 * under test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { registry } from '../../src/metrics.js';
import { countMetricSeries } from '../../src/metrics/cardinality.js';
import {
  indexerBatchesProcessedTotal,
  indexerBatchDurationSeconds,
  indexerBatchErrorsTotal,
  recordIndexerBatchFailure,
  recordIndexerBatchPartialFailure,
  recordIndexerBatchSuccess,
  resetIndexerRedMetrics,
  type IndexerBatchOutcome,
} from '../../src/metrics/indexerRed.js';
import {
  IndexerService,
  _resetStopReplay,
  replayLock,
  replayState,
  requestStopReplay,
} from '../../src/indexer/service.js';
import { NoOpLeaderElection } from '../../src/indexer/leaderElection.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type AnyCollector = {
  get: () => Promise<{
    values: Array<{
      metricName?: string;
      labels: Record<string, string>;
      value: number;
    }>;
  }>;
};

/** Sum every series of a counter whose labels match all of `labels`. */
async function counterValue(counter: AnyCollector, labels: Record<string, string>): Promise<number> {
  const snapshot = await counter.get();
  return snapshot.values
    .filter((series) => Object.entries(labels).every(([key, value]) => series.labels[key] === value))
    .reduce((total, series) => total + series.value, 0);
}

function processed(outcome: IndexerBatchOutcome): Promise<number> {
  return counterValue(indexerBatchesProcessedTotal, { outcome });
}

function errors(labels: Record<string, string>): Promise<number> {
  return counterValue(indexerBatchErrorsTotal, labels);
}

/**
 * The error ratio exactly as `docs/observability.md` documents it:
 *
 *   sum(rate(indexer_batch_errors_total[5m]))
 *     / sum(rate(indexer_batches_processed_total[5m]))
 *
 * Counters are read at a single instant, which is the limit of what a single
 * scrape can show, and is enough to prove the numerator includes partial
 * failures.
 */
async function documentedErrorRatio(): Promise<number> {
  const numerator = await errors({});
  const denominator = await counterValue(indexerBatchesProcessedTotal, {});
  return denominator === 0 ? 0 : numerator / denominator;
}

/** The published `/metrics` text, as the `/metrics` route serves it. */
function publishedText(): Promise<string> {
  return registry.metrics();
}

/**
 * The published sample line for `metricName` whose labels include all of
 * `labels`. Matches on label *content* rather than on an exact line, so the
 * registry-wide `service` label the exposition adds does not have to be
 * hard-coded here — the value under test is the one at the end of the line.
 */
async function publishedSample(
  metricName: string,
  labels: Record<string, string>,
): Promise<string | undefined> {
  const text = await publishedText();
  return text
    .split('\n')
    .find(
      (line) =>
        line.startsWith(`${metricName}{`) &&
        Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`)),
    );
}

/** Every published sample line of `metricName`. */
async function publishedSamples(metricName: string): Promise<string[]> {
  const text = await publishedText();
  return text.split('\n').filter((line) => line.startsWith(`${metricName}{`));
}

/** The numeric value at the end of a published sample line. */
function sampleValue(line: string | undefined): number {
  expect(line).toBeDefined();
  return Number(line?.split(/\s+/).pop());
}

// ── Replay harness: drives the real batch loop over a scripted pool ──────────

const REPLAY_REQUEST = { contract_id: 'CCONTRACT123', ledger: 1 } as const;

type PoolScript = {
  /** Total source rows reported by the COUNT query. */
  count?: number;
  /** Result rows for each successive fetch query, in order. */
  batches?: Record<string, unknown>[][];
  /** Request a cooperative stop on the Nth fetch (1-indexed). */
  stopOnFetchNumber?: number;
  /** Throw from the batch INSERT instead of committing. */
  failInsert?: Error;
};

function row(id: string): Record<string, unknown> {
  return {
    event_id: id,
    contract_id: 'CCONTRACT123',
    ledger: 1,
    event_type: 'stream.created',
    event_data: {},
    block_height: 1,
    transaction_hash: `tx-${id}`,
  };
}

function makePool(script: PoolScript): Pool {
  const batches = script.batches ?? [];
  let fetchCall = 0;
  const fakeClient = {
    query(sql: string, _params?: unknown[]) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (script.failInsert && sql.includes('INSERT INTO contract_events')) {
        return Promise.reject(script.failInsert);
      }
      if (sql.includes('COUNT')) {
        return Promise.resolve({ rows: [{ count: String(script.count ?? 0) }] });
      }
      if (sql.includes('FROM replay_cursors') && sql.includes('completed_at IS NULL')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO replay_cursors')) {
        return Promise.resolve({
          rows: [
            {
              id: 'cur-1',
              contract_id: 'CCONTRACT123',
              ledger: 1,
              from_block: null,
              to_block: null,
              total_rows: script.count ?? 0,
              last_committed_offset: 0,
              started_at: new Date(),
              completed_at: null,
            },
          ],
        });
      }
      if (sql.includes('historical_events') && sql.includes('ORDER BY')) {
        const rows = batches[fetchCall++] ?? [];
        if (script.stopOnFetchNumber !== undefined && fetchCall === script.stopOnFetchNumber) {
          requestStopReplay();
        }
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    },
    release() {},
  };
  return { connect: () => Promise.resolve(fakeClient) } as unknown as Pool;
}

function makeService(pool: Pool): IndexerService {
  return new IndexerService(pool, 250, 0, 0, undefined, new NoOpLeaderElection(), 10);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('indexer RED collector — partial batch failures', () => {
  beforeEach(() => {
    resetIndexerRedMetrics();
  });

  afterEach(() => {
    _resetStopReplay();
    replayLock.release();
    resetIndexerRedMetrics();
  });

  it('records a partial failure as an error so the error ratio is non-zero', async () => {
    recordIndexerBatchSuccess('CCONTRACT123', 0.1);
    recordIndexerBatchSuccess('CCONTRACT123', 0.2);
    recordIndexerBatchPartialFailure('CCONTRACT123', 0.4, 'batch_aborted');

    // The batch is in the denominator exactly once, under its own outcome.
    expect(await processed('partial')).toBe(1);
    expect(await processed('success')).toBe(2);
    expect(await processed('error')).toBe(0);

    // …and in the numerator: the documented error ratio counts it.
    expect(await documentedErrorRatio()).toBeCloseTo(1 / 3);
    expect(await documentedErrorRatio()).toBeGreaterThan(0);

    // The same, read from the published exposition.
    const processedLine = await publishedSample('indexer_batches_processed_total', {
      outcome: 'partial',
    });
    expect(processedLine).toMatch(
      /^indexer_batches_processed_total\{.*outcome="partial".*\} 1$/,
    );
    const errorLine = await publishedSample('indexer_batch_errors_total', {
      error_type: 'batch_aborted',
    });
    expect(errorLine).toMatch(
      /^indexer_batch_errors_total\{.*error_source="local".*error_type="batch_aborted".*\} 1$/,
    );
  });

  it('keeps partial and wholly-failed batches distinguishable', async () => {
    recordIndexerBatchPartialFailure('CCONTRACT123', 0.4, 'batch_aborted');
    recordIndexerBatchFailure('CCONTRACT123', 0.5, new Error('boom'));

    expect(await processed('partial')).toBe(1);
    expect(await processed('error')).toBe(1);
    // Two distinct error series: the partial is identifiable by its error_type.
    expect(await errors({ error_type: 'batch_aborted' })).toBe(1);
    expect(await errors({ error_type: 'unknown' })).toBe(1);
    expect(await documentedErrorRatio()).toBe(1);
  });

  it('drives the replay abort path and publishes a partial failure, not a success', async () => {
    // A cooperative stop is requested on the first fetch, so the batch is
    // rolled back before COMMIT: rows dropped, ledger range not advanced.
    const service = makeService(
      makePool({ count: 3, batches: [[row('a')]], stopOnFetchNumber: 1 }),
    );

    await service.replayEvents({ ...REPLAY_REQUEST });

    // Nothing was committed and nothing threw, so the collector must NOT report
    // a success…
    expect(await processed('success')).toBe(0);
    expect(await processed('error')).toBe(0);
    // …it reports a partial failure, and the error rate is non-zero.
    expect(await processed('partial')).toBe(1);
    expect(await errors({ error_type: 'batch_aborted' })).toBe(1);
    expect(await documentedErrorRatio()).toBe(1);

    // Read back from the published exposition: the partial series is there and
    // carries the value 1…
    expect(
      await publishedSample('indexer_batches_processed_total', { outcome: 'partial' }),
    ).toMatch(/^indexer_batches_processed_total\{.*outcome="partial".*\} 1$/);
    expect(
      sampleValue(
        await publishedSample('indexer_batch_errors_total', { error_type: 'batch_aborted' }),
      ),
    ).toBe(1);
    // …and no success series was published for the dropped batch.
    const successLines = (await publishedSamples('indexer_batches_processed_total')).filter((line) =>
      line.includes('outcome="success"'),
    );
    expect(successLines).toEqual([]);

    // The work was done, so its duration is observed under the partial outcome.
    const duration = await indexerBatchDurationSeconds.get();
    const partialObservations = duration.values
      .filter(
        (series) =>
          series.labels['outcome'] === 'partial' &&
          series.metricName === 'indexer_batch_duration_seconds_count',
      )
      .reduce((total, series) => total + series.value, 0);
    expect(partialObservations).toBe(1);

    // The run stopped at the batch boundary with lock and state released.
    expect(replayLock.isHeld()).toBe(false);
    expect(replayState.getState().isReplaying).toBe(false);
  });

  it('still records a wholly-failed batch as outcome="error"', async () => {
    const service = makeService(
      makePool({
        count: 3,
        batches: [[row('a')]],
        // SQLSTATE 23505 — a unique violation, recognised by the classifier.
        failInsert: Object.assign(new Error('duplicate key value'), { code: '23505' }),
      }),
    );

    await expect(service.replayEvents({ ...REPLAY_REQUEST })).rejects.toThrow('duplicate key value');

    expect(await processed('error')).toBe(1);
    expect(await processed('partial')).toBe(0);
    expect(await processed('success')).toBe(0);
    expect(await errors({ error_type: 'db_error' })).toBe(1);

    const errorLine = await publishedSample('indexer_batches_processed_total', { outcome: 'error' });
    expect(errorLine).toMatch(/^indexer_batches_processed_total\{.*outcome="error".*\} 1$/);
  });

  it('bounds label cardinality: truncates contract ids and rejects unknown reasons', async () => {
    const longContract = `C${'x'.repeat(500)}`;
    recordIndexerBatchPartialFailure(longContract, 0.1, 'batch_aborted');
    // A widened/untyped caller passing something outside the closed union must
    // not be able to mint a new series.
    recordIndexerBatchPartialFailure(longContract, 0.1, 'secret-token-abc' as never);

    const text = await publishedText();

    // The 501-character id collapses onto a single 64-character series.
    const contractLabel = (await indexerBatchesProcessedTotal.get()).values[0]?.labels[
      'contract_id'
    ];
    expect(contractLabel).toBe(longContract.slice(0, 64));
    expect(contractLabel).toHaveLength(64);
    expect(countMetricSeries(text, 'indexer_batches_processed_total')).toBe(1);
    expect(countMetricSeries(text, 'indexer_batch_errors_total')).toBe(2);

    // The unrecognised reason collapsed onto the closed-union fallback rather
    // than being published verbatim.
    expect(await errors({ error_type: 'unknown' })).toBe(1);
    expect(text).not.toContain('secret-token-abc');
  });

  it('never publishes a raw error message or a thrown non-error value', async () => {
    const secret = 'postgres://user:hunter2@db/internal';
    recordIndexerBatchFailure('CCONTRACT123', 0.1, new Error(secret));
    recordIndexerBatchFailure('CCONTRACT123', 0.1, 'plain thrown string');
    recordIndexerBatchFailure('CCONTRACT123', 0.1, null);

    const text = await publishedText();
    expect(text).not.toContain(secret);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('plain thrown string');
    // Every failure landed on one bounded error_type from the closed union.
    expect(countMetricSeries(text, 'indexer_batch_errors_total')).toBe(1);
    expect(await errors({ error_source: 'local', error_type: 'unknown' })).toBe(3);
  });
});
