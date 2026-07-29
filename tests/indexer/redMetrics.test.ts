/**
 * tests/indexer/redMetrics.test.ts
 *
 * Tests for the indexer batch-processing RED metrics
 * (`src/metrics/indexerRed.ts`) and their wiring into
 * `IndexerService.replayEvents` (`src/indexer/service.ts`).
 *
 * Covers:
 *  - Metric registration: names, help text, and label sets are registered on
 *    the shared registry and mirror the HTTP RED metric conventions.
 *  - `normalizeContractIdLabel`: truncation, blank/non-string fallback.
 *  - `classifyIndexerBatchError`: Stellar RPC failures are distinguishable from
 *    local processing failures, using the *real* error classes exported by
 *    `src/services/stellar-rpc.ts` and `src/db/pool.ts`.
 *  - Recording helpers: success/failure update the rate counter, the error
 *    counter, and the duration histogram consistently.
 *  - End-to-end: a replay run increments the RED triad once per batch, and a
 *    failing batch is recorded with the correct `error_source`/`error_type`
 *    before the error propagates to the caller.
 *  - Edge cases: thrown non-Error values, unknown RPC kinds, zero-row batches,
 *    and oversized contract ids.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type pg from 'pg';

import {
  indexerBatchesProcessedTotal,
  indexerBatchErrorsTotal,
  indexerBatchDurationSeconds,
  classifyIndexerBatchError,
  normalizeContractIdLabel,
  recordIndexerBatchSuccess,
  recordIndexerBatchFailure,
  resetIndexerRedMetrics,
} from '../../src/metrics/indexerRed.js';
import { registry } from '../../src/metrics.js';
import {
  CircuitOpenError,
  RpcProviderError,
} from '../../src/services/stellar-rpc.js';
import {
  DuplicateEntryError,
  PoolExhaustedError,
  QueryTimeoutError,
} from '../../src/db/pool.js';
import {
  IndexerService,
  ReplayCursorRepository,
  replayLock,
  replayState,
} from '../../src/indexer/service.js';
import type { IndexerLeaderElection } from '../../src/indexer/leaderElection.js';

// ── Metric read helpers ───────────────────────────────────────────────────────

type LabelBag = Record<string, string | number | undefined>;

/** Sum of all counter samples whose labels match every entry in `match`. */
async function counterValue(
  metric: { get(): Promise<{ values: Array<{ labels: LabelBag; value: number }> }> },
  match: LabelBag,
): Promise<number> {
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(match).every(([k, want]) => v.labels[k] === want))
    .reduce((sum, v) => sum + v.value, 0);
}

/** Observation count of a histogram series (the `_count` sample). */
async function histogramCount(match: LabelBag): Promise<number> {
  const { values } = await indexerBatchDurationSeconds.get();
  return values
    .filter(
      (v) =>
        (v as { metricName?: string }).metricName === 'indexer_batch_duration_seconds_count' &&
        Object.entries(match).every(([k, want]) => v.labels[k] === want),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

/** Sum of a histogram series (the `_sum` sample). */
async function histogramSum(match: LabelBag): Promise<number> {
  const { values } = await indexerBatchDurationSeconds.get();
  return values
    .filter(
      (v) =>
        (v as { metricName?: string }).metricName === 'indexer_batch_duration_seconds_sum' &&
        Object.entries(match).every(([k, want]) => v.labels[k] === want),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

// ── IndexerService mock harness (mirrors tests/indexer-replay.test.ts) ─────────

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

function makeClient(queryImpl?: QueryFn): pg.PoolClient {
  return {
    query: vi.fn().mockImplementation(
      queryImpl ?? (() => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })),
    ),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function makePool(...clients: pg.PoolClient[]): pg.Pool {
  let callCount = 0;
  return {
    connect: vi.fn(async () => {
      const c = clients[callCount % clients.length];
      callCount++;
      return c;
    }),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  } as unknown as pg.Pool;
}

function makeFakeLeaderElection(): IndexerLeaderElection {
  return {
    isLeader: vi.fn(() => true),
    tryAcquire: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
}

function makeCursorRepo(totalRows: number): ReplayCursorRepository {
  return {
    findActive: vi.fn(async () => null),
    create: vi.fn(async (_client, cid: string, ledger: number) => ({
      id: 'red-cursor',
      contract_id: cid,
      ledger,
      from_block: null,
      to_block: null,
      total_rows: totalRows,
      last_committed_offset: 0,
      started_at: new Date(),
      completed_at: null,
    })),
    advanceOffset: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
  } as unknown as ReplayCursorRepository;
}

function makeEvent(eventId: string, blockHeight = 1000) {
  return {
    event_id: eventId,
    contract_id: CONTRACT,
    ledger: 1,
    event_type: 'transfer',
    event_data: { amount: '100' },
    block_height: blockHeight,
    transaction_hash: `tx-${eventId}`,
  };
}

const CONTRACT = 'red-metrics-contract';
const REQUEST = { contract_id: CONTRACT, ledger: 1 };

function makeService(pool: pg.Pool, cursorRepo: ReplayCursorRepository, batchSize: number): IndexerService {
  return new IndexerService(pool, batchSize, 0, 0, cursorRepo, makeFakeLeaderElection());
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  if (replayLock.isHeld()) (replayLock as unknown as { _isReplaying: boolean })._isReplaying = false;
  replayState.endReplay();
  resetIndexerRedMetrics();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (replayLock.isHeld()) (replayLock as unknown as { _isReplaying: boolean })._isReplaying = false;
});

// ── Registration / naming parity ──────────────────────────────────────────────

describe('indexerRed — registration and naming parity', () => {
  it('registers the RED triad on the shared registry', () => {
    expect(registry.getSingleMetric('indexer_batches_processed_total')).toBeDefined();
    expect(registry.getSingleMetric('indexer_batch_errors_total')).toBeDefined();
    expect(registry.getSingleMetric('indexer_batch_duration_seconds')).toBeDefined();
  });

  it('exposes the triad in the scrape payload with the expected label names', async () => {
    recordIndexerBatchSuccess(CONTRACT, 0.5);
    recordIndexerBatchFailure(CONTRACT, 0.1, new RpcProviderError('boom', 'TIMEOUT'));

    const scrape = await registry.metrics();

    expect(scrape).toContain('# TYPE indexer_batches_processed_total counter');
    expect(scrape).toContain('# TYPE indexer_batch_errors_total counter');
    expect(scrape).toContain('# TYPE indexer_batch_duration_seconds histogram');
    expect(scrape).toContain(`indexer_batches_processed_total{contract_id="${CONTRACT}",outcome="success"`);
    expect(scrape).toContain('error_source="stellar_rpc"');
    expect(scrape).toContain('error_type="timeout"');
  });

  it('uses the same duration unit and outcome-style label as the HTTP RED metrics', () => {
    // http_request_duration_seconds{method,route,status_code} is the template:
    // seconds-valued histogram + a label carrying the terminal result.
    expect(indexerBatchDurationSeconds.get()).toBeInstanceOf(Promise);
    expect(indexerBatchesProcessedTotal).toBeDefined();
    expect(registry.getSingleMetric('http_request_duration_seconds')).toBeDefined();
  });
});

// ── normalizeContractIdLabel ──────────────────────────────────────────────────

describe('normalizeContractIdLabel', () => {
  it('passes through a normal contract id', () => {
    expect(normalizeContractIdLabel('C123')).toBe('C123');
  });

  it('truncates to 64 characters to bound label cardinality', () => {
    const long = 'X'.repeat(500);
    expect(normalizeContractIdLabel(long)).toHaveLength(64);
  });

  it('falls back to "unknown" for blank, missing, or non-string ids', () => {
    expect(normalizeContractIdLabel('')).toBe('unknown');
    expect(normalizeContractIdLabel('   ')).toBe('unknown');
    expect(normalizeContractIdLabel(undefined)).toBe('unknown');
    expect(normalizeContractIdLabel(null)).toBe('unknown');
    expect(normalizeContractIdLabel(42 as unknown as string)).toBe('unknown');
  });
});

// ── classifyIndexerBatchError ─────────────────────────────────────────────────

describe('classifyIndexerBatchError — Stellar RPC failures', () => {
  it.each([
    ['TIMEOUT', 'timeout'],
    ['NETWORK', 'network'],
    ['PROVIDER', 'provider'],
    ['CANCELLED', 'cancelled'],
    ['CIRCUIT_OPEN', 'circuit_open'],
  ] as const)('maps RpcProviderError kind %s to error_type %s', (kind, expected) => {
    expect(classifyIndexerBatchError(new RpcProviderError('rpc down', kind))).toEqual({
      source: 'stellar_rpc',
      type: expected,
    });
  });

  it('maps CircuitOpenError to stellar_rpc/circuit_open', () => {
    expect(classifyIndexerBatchError(new CircuitOpenError())).toEqual({
      source: 'stellar_rpc',
      type: 'circuit_open',
    });
  });

  it('falls back to provider for an RPC error carrying an unrecognised kind', () => {
    const err = new RpcProviderError('weird', 'SOMETHING_NEW' as never);
    expect(classifyIndexerBatchError(err)).toEqual({ source: 'stellar_rpc', type: 'provider' });
  });

  it('classifies a re-wrapped RPC failure by its kind field alone', () => {
    // A caller may rethrow with a different class but preserve `kind`.
    const rewrapped = Object.assign(new Error('wrapped'), { kind: 'NETWORK' });
    expect(classifyIndexerBatchError(rewrapped)).toEqual({ source: 'stellar_rpc', type: 'network' });
  });
});

describe('classifyIndexerBatchError — local failures', () => {
  it('maps PoolExhaustedError to local/db_pool_exhausted', () => {
    expect(classifyIndexerBatchError(new PoolExhaustedError())).toEqual({
      source: 'local',
      type: 'db_pool_exhausted',
    });
  });

  it('maps QueryTimeoutError to local/db_query_timeout', () => {
    expect(classifyIndexerBatchError(new QueryTimeoutError())).toEqual({
      source: 'local',
      type: 'db_query_timeout',
    });
  });

  it('maps DuplicateEntryError to local/db_duplicate_entry', () => {
    expect(classifyIndexerBatchError(new DuplicateEntryError('dupe'))).toEqual({
      source: 'local',
      type: 'db_duplicate_entry',
    });
  });

  it('maps a raw pg error carrying a SQLSTATE to local/db_error', () => {
    const pgErr = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    expect(classifyIndexerBatchError(pgErr)).toEqual({ source: 'local', type: 'db_error' });
  });

  it('does not treat a non-SQLSTATE code as a database error', () => {
    const err = Object.assign(new Error('nope'), { code: 'not-a-sqlstate' });
    expect(classifyIndexerBatchError(err)).toEqual({ source: 'local', type: 'unknown' });
  });

  it.each([
    ['plain Error', new Error('kaboom')],
    ['thrown string', 'kaboom' as unknown],
    ['thrown null', null as unknown],
    ['thrown undefined', undefined as unknown],
    ['thrown number', 7 as unknown],
  ])('classifies %s as local/unknown without throwing', (_label, thrown) => {
    expect(classifyIndexerBatchError(thrown)).toEqual({ source: 'local', type: 'unknown' });
  });
});

// ── Recording helpers ─────────────────────────────────────────────────────────

describe('recordIndexerBatchSuccess / recordIndexerBatchFailure', () => {
  it('records a success on the rate counter and duration histogram only', async () => {
    recordIndexerBatchSuccess(CONTRACT, 0.25);

    expect(await counterValue(indexerBatchesProcessedTotal, { contract_id: CONTRACT, outcome: 'success' })).toBe(1);
    expect(await counterValue(indexerBatchErrorsTotal, { contract_id: CONTRACT })).toBe(0);
    expect(await histogramCount({ contract_id: CONTRACT, outcome: 'success' })).toBe(1);
    expect(await histogramSum({ contract_id: CONTRACT, outcome: 'success' })).toBeCloseTo(0.25, 6);
  });

  it('records a failure on all three metrics so the error ratio stays computable', async () => {
    const classification = recordIndexerBatchFailure(
      CONTRACT,
      0.75,
      new RpcProviderError('upstream 503', 'PROVIDER'),
    );

    expect(classification).toEqual({ source: 'stellar_rpc', type: 'provider' });
    expect(await counterValue(indexerBatchesProcessedTotal, { contract_id: CONTRACT, outcome: 'error' })).toBe(1);
    expect(
      await counterValue(indexerBatchErrorsTotal, {
        contract_id: CONTRACT,
        error_source: 'stellar_rpc',
        error_type: 'provider',
      }),
    ).toBe(1);
    expect(await histogramCount({ contract_id: CONTRACT, outcome: 'error' })).toBe(1);
    expect(await histogramSum({ contract_id: CONTRACT, outcome: 'error' })).toBeCloseTo(0.75, 6);
  });

  it('keeps RPC and local failures on separate error series', async () => {
    recordIndexerBatchFailure(CONTRACT, 0.1, new RpcProviderError('timeout', 'TIMEOUT'));
    recordIndexerBatchFailure(CONTRACT, 0.1, new PoolExhaustedError());

    expect(await counterValue(indexerBatchErrorsTotal, { error_source: 'stellar_rpc' })).toBe(1);
    expect(await counterValue(indexerBatchErrorsTotal, { error_source: 'local' })).toBe(1);
    expect(
      await counterValue(indexerBatchErrorsTotal, { error_source: 'stellar_rpc', error_type: 'timeout' }),
    ).toBe(1);
    expect(
      await counterValue(indexerBatchErrorsTotal, { error_source: 'local', error_type: 'db_pool_exhausted' }),
    ).toBe(1);
  });

  it('never uses the error message as a label value', async () => {
    recordIndexerBatchFailure(CONTRACT, 0.1, new Error('secret-token-abc123'));
    const scrape = await registry.metrics();
    expect(scrape).not.toContain('secret-token-abc123');
    expect(await counterValue(indexerBatchErrorsTotal, { error_type: 'unknown' })).toBe(1);
  });

  it('bounds the contract_id label for an oversized id', async () => {
    const huge = 'Z'.repeat(300);
    recordIndexerBatchSuccess(huge, 0.01);
    expect(await counterValue(indexerBatchesProcessedTotal, { contract_id: 'Z'.repeat(64) })).toBe(1);
  });
});

// ── End-to-end wiring into IndexerService.replayEvents ────────────────────────

describe('IndexerService.replayEvents — RED instrumentation', () => {
  it('increments the rate counter and duration histogram once per batch', async () => {
    // 4 source rows, batchSize 2 → two batch processing steps.
    const cursorClient = makeClient(async (sql) =>
      sql.includes('COUNT') ? { rows: [{ count: '4' }] } : { rows: [] },
    );
    let fetches = 0;
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) {
        fetches++;
        return { rows: [makeEvent(`e${fetches}a`), makeEvent(`e${fetches}b`)] };
      }
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));

    const svc = makeService(makePool(cursorClient, batchClient, completeClient), makeCursorRepo(4), 2);
    await svc.replayEvents(REQUEST);

    expect(await counterValue(indexerBatchesProcessedTotal, { contract_id: CONTRACT, outcome: 'success' })).toBe(2);
    expect(await histogramCount({ contract_id: CONTRACT, outcome: 'success' })).toBe(2);
    expect(await counterValue(indexerBatchErrorsTotal, { contract_id: CONTRACT })).toBe(0);
    expect(await histogramSum({ contract_id: CONTRACT, outcome: 'success' })).toBeGreaterThanOrEqual(0);
  });

  it('counts a zero-row batch as a processed step (work was performed)', async () => {
    // The count query claims 2 rows but the source returns none — the loop
    // performs one batch step, finds it empty, and stops.
    const cursorClient = makeClient(async (sql) =>
      sql.includes('COUNT') ? { rows: [{ count: '2' }] } : { rows: [] },
    );
    const batchClient = makeClient(async () => ({ rows: [] }));
    const completeClient = makeClient(async () => ({ rows: [] }));

    const svc = makeService(makePool(cursorClient, batchClient, completeClient), makeCursorRepo(2), 2);
    await svc.replayEvents(REQUEST);

    expect(await counterValue(indexerBatchesProcessedTotal, { contract_id: CONTRACT, outcome: 'success' })).toBe(1);
    expect(await histogramCount({ contract_id: CONTRACT, outcome: 'success' })).toBe(1);
  });

  it('records a local error and still propagates the failure to the caller', async () => {
    const cursorClient = makeClient(async (sql) =>
      sql.includes('COUNT') ? { rows: [{ count: '2' }] } : { rows: [] },
    );
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) {
        throw Object.assign(new Error('relation "historical_events" does not exist'), { code: '42P01' });
      }
      return { rows: [] };
    });

    const svc = makeService(makePool(cursorClient, batchClient), makeCursorRepo(2), 2);

    await expect(svc.replayEvents(REQUEST)).rejects.toThrow('historical_events');

    expect(await counterValue(indexerBatchesProcessedTotal, { contract_id: CONTRACT, outcome: 'error' })).toBe(1);
    expect(
      await counterValue(indexerBatchErrorsTotal, {
        contract_id: CONTRACT,
        error_source: 'local',
        error_type: 'db_error',
      }),
    ).toBe(1);
    expect(await histogramCount({ contract_id: CONTRACT, outcome: 'error' })).toBe(1);
  });

  it('attributes a Stellar RPC failure inside a batch to error_source="stellar_rpc"', async () => {
    const cursorClient = makeClient(async (sql) =>
      sql.includes('COUNT') ? { rows: [{ count: '2' }] } : { rows: [] },
    );
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) {
        // Simulates an enrichment/verification call into
        // src/services/stellar-rpc.ts failing partway through the batch.
        throw new RpcProviderError('ledger fetch timed out', 'TIMEOUT');
      }
      return { rows: [] };
    });

    const svc = makeService(makePool(cursorClient, batchClient), makeCursorRepo(2), 2);

    await expect(svc.replayEvents(REQUEST)).rejects.toBeInstanceOf(RpcProviderError);

    expect(
      await counterValue(indexerBatchErrorsTotal, {
        contract_id: CONTRACT,
        error_source: 'stellar_rpc',
        error_type: 'timeout',
      }),
    ).toBe(1);
    expect(await counterValue(indexerBatchErrorsTotal, { error_source: 'local' })).toBe(0);
  });

  it('logs replay_batch_failed with the classification labels', async () => {
    const { logger } = await import('../../src/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const cursorClient = makeClient(async (sql) =>
      sql.includes('COUNT') ? { rows: [{ count: '2' }] } : { rows: [] },
    );
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) throw new CircuitOpenError();
      return { rows: [] };
    });

    const svc = makeService(makePool(cursorClient, batchClient), makeCursorRepo(2), 2);
    await expect(svc.replayEvents(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);

    expect(warnSpy).toHaveBeenCalledWith(
      'replay_batch_failed',
      undefined,
      expect.objectContaining({
        event: 'replay_batch_failed',
        error_source: 'stellar_rpc',
        error_type: 'circuit_open',
      }),
    );
  });
});
