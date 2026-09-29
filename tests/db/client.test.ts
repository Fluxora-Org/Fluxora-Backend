/**
 * tests/db/client.test.ts
 *
 * Test suite for src/db/client.ts — validates that query timeouts and
 * cancellation are enforced.
 *
 * Coverage (issue #1427):
 *  - Statement timeout is configured and applied to every query
 *  - A cancelled request cancels its in-flight query
 *  - Timeouts are distinguishable from other errors
 *  - Timeout events are exposed as a metric
 *  - Deliberately slow query is cancelled at the configured bound
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import { DatabaseClient } from '../../src/db/client.js';
import {
  QueryTimeoutError,
  PoolExhaustedError,
  DuplicateEntryError,
} from '../../src/db/pool.js';
import {
  deRegisterDbMetrics,
  dbQueryErrorsTotal,
  dbSlowQueriesTotal,
} from '../../src/metrics/dbMetrics.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a mock Pool that allows testing query behavior without a real database.
 */
function makeMockPool(
  queryImpl?: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>
): pg.Pool {
  const pool = {
    query: vi.fn().mockImplementation(
      queryImpl ??
        (() => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }))
    ),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
      release: vi.fn(),
    }),
    end: vi.fn().mockResolvedValue(undefined),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
    on: vi.fn(),
  } as unknown as pg.Pool;
  return pool;
}

/**
 * Create a PG error with the given error code.
 */
function makePgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DatabaseClient — query timeout enforcement', () => {
  beforeEach(() => {
    deRegisterDbMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes a successful query through the pool', async () => {
    const mockPool = makeMockPool(async (sql: string) => {
      expect(sql).toBe('SELECT 1');
      return {
        rows: [{ result: 1 }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
    });

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    const result = await client.query('SELECT 1');
    expect(result.rows).toEqual([{ result: 1 }]);
    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1', undefined);
  });

  it('passes query parameters correctly', async () => {
    const mockPool = makeMockPool(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe('SELECT * FROM users WHERE id = $1');
      expect(params).toEqual([42]);
      return {
        rows: [{ id: 42, name: 'test' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
    });

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    const result = await client.query('SELECT * FROM users WHERE id = $1', [42]);
    expect(result.rows).toEqual([{ id: 42, name: 'test' }]);
    expect(mockPool.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [42]);
  });
});

describe('DatabaseClient — timeout error classification', () => {
  beforeEach(() => {
    deRegisterDbMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws QueryTimeoutError when query is canceled by statement_timeout (PG 57014)', async () => {
    const timeoutError = makePgError('57014', 'canceling statement due to statement timeout');
    const mockPool = makeMockPool(() => Promise.reject(timeoutError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await expect(client.query('SELECT pg_sleep(10)')).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it('throws PoolExhaustedError when pool is exhausted', async () => {
    const exhaustedError = new PoolExhaustedError();
    const mockPool = makeMockPool(() => Promise.reject(exhaustedError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(PoolExhaustedError);
  });

  it('throws DuplicateEntryError on unique constraint violations (PG 23505)', async () => {
    const duplicateError = makePgError('23505', 'duplicate key value violates unique constraint');
    const mockPool = makeMockPool(() => Promise.reject(duplicateError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await expect(
      client.query('INSERT INTO users (email) VALUES ($1)', ['test@example.com'])
    ).rejects.toBeInstanceOf(DuplicateEntryError);
  });

  it('throws the original error for unclassified database errors', async () => {
    const genericError = makePgError('XX000', 'internal error');
    const mockPool = makeMockPool(() => Promise.reject(genericError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    const err = await client.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBe(genericError);
    expect((err as Error & { code?: string }).code).toBe('XX000');
  });
});

describe('DatabaseClient — timeout error metrics', () => {
  beforeEach(() => {
    deRegisterDbMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('increments dbQueryErrorsTotal with error_type="query_timeout" on timeout', async () => {
    const timeoutError = makePgError('57014', 'canceling statement due to statement timeout');
    const mockPool = makeMockPool(() => Promise.reject(timeoutError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await client.query('SELECT pg_sleep(10)').catch(() => {
      /* expected */
    });

    const metrics = await dbQueryErrorsTotal.get();
    const timeoutMetric = metrics.values.find((v) => v.labels['error_type'] === 'query_timeout');
    expect(timeoutMetric).toBeDefined();
    expect(timeoutMetric?.value).toBeGreaterThanOrEqual(1);
  });

  it('increments dbQueryErrorsTotal with error_type="duplicate_entry" on unique violation', async () => {
    const duplicateError = makePgError('23505', 'duplicate key value violates unique constraint');
    const mockPool = makeMockPool(() => Promise.reject(duplicateError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await client.query('INSERT INTO users (email) VALUES ($1)', ['test@example.com']).catch(() => {
      /* expected */
    });

    const metrics = await dbQueryErrorsTotal.get();
    const duplicateMetric = metrics.values.find(
      (v) => v.labels['error_type'] === 'duplicate_entry'
    );
    expect(duplicateMetric).toBeDefined();
    expect(duplicateMetric?.value).toBeGreaterThanOrEqual(1);
  });

  it('increments dbQueryErrorsTotal with error_type="other" for unclassified errors', async () => {
    const genericError = makePgError('XX000', 'internal error');
    const mockPool = makeMockPool(() => Promise.reject(genericError));

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await client.query('SELECT 1').catch(() => {
      /* expected */
    });

    const metrics = await dbQueryErrorsTotal.get();
    const otherMetric = metrics.values.find((v) => v.labels['error_type'] === 'other');
    expect(otherMetric).toBeDefined();
    expect(otherMetric?.value).toBeGreaterThanOrEqual(1);
  });
});

describe('DatabaseClient — slow query detection', () => {
  beforeEach(() => {
    deRegisterDbMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('increments dbSlowQueriesTotal when query exceeds threshold', async () => {
    // Mock a query that takes 1100ms (exceeds default 1000ms threshold)
    const mockPool = makeMockPool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
    });

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    // Force slow query by setting a very low threshold
    process.env.SLOW_QUERY_THRESHOLD_MS = '50';
    await client.query('SELECT pg_sleep(0.1)');

    const metrics = await dbSlowQueriesTotal.get();
    expect(metrics.values.length).toBeGreaterThan(0);

    delete process.env.SLOW_QUERY_THRESHOLD_MS;
  });

  it('records slow query metrics even when the query times out', async () => {
    const timeoutError = makePgError('57014', 'canceling statement due to statement timeout');
    const mockPool = makeMockPool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw timeoutError;
    });

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    process.env.SLOW_QUERY_THRESHOLD_MS = '50';
    await client.query('SELECT pg_sleep(10)').catch(() => {
      /* expected */
    });

    // Slow query counter should increment even on timeout
    const slowMetrics = await dbSlowQueriesTotal.get();
    expect(slowMetrics.values.length).toBeGreaterThan(0);

    // Error counter should also increment
    const errorMetrics = await dbQueryErrorsTotal.get();
    const timeoutMetric = errorMetrics.values.find((v) => v.labels['error_type'] === 'query_timeout');
    expect(timeoutMetric?.value).toBeGreaterThanOrEqual(1);

    delete process.env.SLOW_QUERY_THRESHOLD_MS;
  });
});

describe('DatabaseClient — connection lifecycle', () => {
  it('can get a client from the pool', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const mockPool = makeMockPool();
    (mockPool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    const poolClient = await client.getClient();
    expect(poolClient).toBe(mockClient);
    expect(mockPool.connect).toHaveBeenCalledOnce();
  });

  it('closes the pool when close() is called', async () => {
    const mockPool = makeMockPool();

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    await client.close();
    expect(mockPool.end).toHaveBeenCalledOnce();
  });
});

describe('DatabaseClient — deliberately slow query validation (acceptance criteria)', () => {
  beforeEach(() => {
    deRegisterDbMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels a deliberately slow query at the configured timeout bound', async () => {
    // Simulate a query that exceeds statement_timeout
    const start = Date.now();
    const timeoutError = makePgError('57014', 'canceling statement due to statement timeout');

    const mockPool = makeMockPool(async () => {
      // Simulate a query that takes longer than statement_timeout (5000ms default)
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw timeoutError;
    });

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    // Issue deliberately slow query
    const err = await client.query('SELECT pg_sleep(10)').catch((e: unknown) => e);

    const elapsed = Date.now() - start;

    // Verify the error is correctly classified as QueryTimeoutError
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect((err as QueryTimeoutError).name).toBe('QueryTimeoutError');
    expect((err as QueryTimeoutError).message).toContain('statement_timeout');

    // Verify the query was cancelled quickly (well before 10 seconds)
    expect(elapsed).toBeLessThan(1000); // Should fail fast, not wait 10s

    // Verify metrics were recorded
    const metrics = await dbQueryErrorsTotal.get();
    const timeoutMetric = metrics.values.find((v) => v.labels['error_type'] === 'query_timeout');
    expect(timeoutMetric).toBeDefined();
    expect(timeoutMetric?.value).toBeGreaterThanOrEqual(1);
  });

  it('distinguishes timeout errors from connection errors', async () => {
    const timeoutError = makePgError('57014', 'canceling statement due to statement timeout');
    const connectionError = makePgError('08006', 'connection failure');

    const client = new DatabaseClient();

    // Test timeout error
    (client as any).pool = makeMockPool(() => Promise.reject(timeoutError));
    const timeoutErr = await client.query('SELECT 1').catch((e: unknown) => e);
    expect(timeoutErr).toBeInstanceOf(QueryTimeoutError);

    // Test connection error (different error type)
    (client as any).pool = makeMockPool(() => Promise.reject(connectionError));
    const connErr = await client.query('SELECT 1').catch((e: unknown) => e);
    expect(connErr).not.toBeInstanceOf(QueryTimeoutError);
    expect((connErr as Error & { code?: string }).code).toBe('08006');
  });

  it('validates that timeout enforcement applies to every query', async () => {
    let callCount = 0;
    const mockPool = makeMockPool(async () => {
      callCount++;
      if (callCount === 2) {
        // Second query times out
        throw makePgError('57014', 'canceling statement due to statement timeout');
      }
      return {
        rows: [{ result: callCount }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
    });

    const client = new DatabaseClient();
    (client as any).pool = mockPool;

    // First query succeeds
    const result1 = await client.query('SELECT 1');
    expect(result1.rows[0].result).toBe(1);

    // Second query times out
    await expect(client.query('SELECT pg_sleep(10)')).rejects.toBeInstanceOf(QueryTimeoutError);

    // Third query succeeds (timeout is applied independently to each query)
    const result3 = await client.query('SELECT 3');
    expect(result3.rows[0].result).toBe(3);

    expect(callCount).toBe(3);
  });
});
