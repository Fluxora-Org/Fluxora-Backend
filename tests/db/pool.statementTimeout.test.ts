/**
 * tests/db/pool.statementTimeout.test.ts
 *
 * Covers:
 *  - resolvePoolConfig reads STATEMENT_TIMEOUT_MS from env
 *  - createPool connect hook calls SET statement_timeout when > 0
 *  - createPool connect hook skips SET statement_timeout when = 0
 *  - query() throws QueryTimeoutError on PG error code 57014
 *  - query() does NOT throw QueryTimeoutError for other PG errors
 *  - errorHandler maps QueryTimeoutError to HTTP 504
 *  - Pool reconnect after timeout: connect hook re-applies statement_timeout
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type pg from 'pg';
import {
  resolvePoolConfig,
  createPool,
  query,
  QueryTimeoutError,
} from '../../src/db/pool.js';
import { deRegisterDbMetrics } from '../../src/metrics/dbMetrics.js';

// ── helpers ───────────────────────────────────────────────────────────────────

type PoolEventHandler = (arg?: unknown) => void;

function makeClient(queryImpl?: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>): pg.PoolClient {
  return {
    query: vi.fn().mockImplementation(queryImpl ?? (() => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }))),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function makePool(overrides: Partial<pg.Pool> = {}): pg.Pool {
  const handlers: Record<string, PoolEventHandler[]> = {};
  return {
    totalCount: 0,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 10 },
    query: vi.fn<() => Promise<pg.QueryResult>>().mockResolvedValue({
      rows: [],
      rowCount: 0,
      command: '',
      oid: 0,
      fields: [],
    }),
    on: vi.fn((event: string, handler: PoolEventHandler) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event]!.push(handler);
    }),
    emit: vi.fn((event: string, arg?: unknown) => {
      (handlers[event] ?? []).forEach((h) => h(arg));
      return true;
    }),
    end: vi.fn(),
    ...overrides,
  } as unknown as pg.Pool;
}

// ── resolvePoolConfig ─────────────────────────────────────────────────────────

describe('resolvePoolConfig — statementTimeoutMs', () => {
  const original = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, original);
  });

  it('defaults to 5000 ms', () => {
    delete process.env.STATEMENT_TIMEOUT_MS;
    expect(resolvePoolConfig().statementTimeoutMs).toBe(5_000);
  });

  it('reads STATEMENT_TIMEOUT_MS from env', () => {
    process.env.STATEMENT_TIMEOUT_MS = '10000';
    expect(resolvePoolConfig().statementTimeoutMs).toBe(10_000);
  });

  it('accepts 0 to disable the timeout', () => {
    process.env.STATEMENT_TIMEOUT_MS = '0';
    expect(resolvePoolConfig().statementTimeoutMs).toBe(0);
  });

  it('falls back to default for non-numeric value', () => {
    process.env.STATEMENT_TIMEOUT_MS = 'bad';
    expect(resolvePoolConfig().statementTimeoutMs).toBe(5_000);
  });
});

// ── createPool: connect hook ──────────────────────────────────────────────────

describe('createPool — connect hook applies statement_timeout', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('calls SET statement_timeout on new connection when timeout > 0', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1,
      max: 5,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 5000,
      queueLimit: 50,
      statementTimeoutMs: 3000,
    });

    // Simulate a new physical connection arriving
    (pool as unknown as { emit: (e: string, c: pg.PoolClient) => void }).emit('connect', client);

    expect(client.query).toHaveBeenCalledWith('SET statement_timeout = $1', [3000]);
    pool.end();
  });

  it('does NOT call SET statement_timeout when timeout = 0 (disabled)', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1,
      max: 5,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 5000,
      queueLimit: 50,
      statementTimeoutMs: 0,
    });

    (pool as unknown as { emit: (e: string, c: pg.PoolClient) => void }).emit('connect', client);

    expect(client.query).not.toHaveBeenCalled();
    pool.end();
  });

  it('re-applies statement_timeout on reconnect (multiple connect events)', () => {
    const client1 = makeClient();
    const client2 = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1,
      max: 5,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 5000,
      queueLimit: 50,
      statementTimeoutMs: 5000,
    });

    const emit = (pool as unknown as { emit: (e: string, c: pg.PoolClient) => void }).emit.bind(pool);
    emit('connect', client1);
    emit('connect', client2);

    expect(client1.query).toHaveBeenCalledWith('SET statement_timeout = $1', [5000]);
    expect(client2.query).toHaveBeenCalledWith('SET statement_timeout = $1', [5000]);
    pool.end();
  });
});

// ── query: QueryTimeoutError ──────────────────────────────────────────────────

describe('query — QueryTimeoutError on PG 57014', () => {
  it('throws QueryTimeoutError when PG returns error code 57014', async () => {
    const pgError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });

    await expect(query(pool, 'SELECT pg_sleep(10)')).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it('QueryTimeoutError has the correct message', async () => {
    const pgError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });

    await expect(query(pool, 'SELECT pg_sleep(10)')).rejects.toThrow(
      'Query exceeded statement_timeout limit',
    );
  });

  it('does NOT throw QueryTimeoutError for other PG error codes', async () => {
    const pgError = Object.assign(new Error('connection reset'), { code: '08006' });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });

    await expect(query(pool, 'SELECT 1')).rejects.not.toBeInstanceOf(QueryTimeoutError);
    await expect(query(pool, 'SELECT 1')).rejects.toThrow('connection reset');
  });

  it('query within timeout limit succeeds normally', async () => {
    const pool = makePool({ totalCount: 1, idleCount: 1, waitingCount: 0 });
    const result = await query(pool, 'SELECT 1');
    expect(result.rows).toEqual([]);
  });
});

// ── QueryTimeoutError class ───────────────────────────────────────────────────

describe('QueryTimeoutError', () => {
  it('has name QueryTimeoutError', () => {
    expect(new QueryTimeoutError().name).toBe('QueryTimeoutError');
  });

  it('is an instance of Error', () => {
    expect(new QueryTimeoutError()).toBeInstanceOf(Error);
  });
});

// ── errorHandler: 504 mapping ─────────────────────────────────────────────────

describe('errorHandler — QueryTimeoutError → 504', () => {
  it('returns 504 with GATEWAY_TIMEOUT code for QueryTimeoutError', async () => {
    const { errorHandler } = await import('../../src/middleware/errorHandler.js');
    const { errorResponse } = await import('../../src/utils/response.js');

    const err = new QueryTimeoutError();
    const req = { id: 'req-1' } as unknown as import('express').Request;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as import('express').Response;
    const next = vi.fn();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(json).toHaveBeenCalledWith(
      errorResponse('GATEWAY_TIMEOUT', 'Query timed out', undefined, 'req-1'),
    );
  });
});
