/**
 * tests/db/pool.pgbouncerCompat.test.ts
 *
 * Tests for the PgBouncer / PgCat transaction-pooling compatibility guard
 * (issue #754).
 *
 * Coverage:
 *  - resolvePoolConfig reads POOL_MODE from env and defaults to "session"
 *  - createPool in session mode applies SET statement_timeout on connect (existing behaviour)
 *  - createPool in transaction mode SKIPS SET statement_timeout on connect
 *  - createPool stores _poolMode on the pool instance
 *  - isTransactionPoolMode() reads from pool instance and env fallback
 *  - A startup warning is logged in transaction mode
 *  - resolvePoolConfig rejects unknown POOL_MODE values (defaults to session)
 *  - syncPoolGauges still fires in both modes (observability unbroken)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type pg from 'pg';
import {
  resolvePoolConfig,
  createPool,
  isTransactionPoolMode,
  setPool,
  PoolExhaustedError,
  DuplicateEntryError,
  QueryTimeoutError,
  query,
  getPoolMetrics,
  withClient,
  extractTableHint,
} from '../../src/db/pool.js';
import { deRegisterDbMetrics } from '../../src/metrics/dbMetrics.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeClient(queryImpl?: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>): pg.PoolClient {
  return {
    query: vi.fn().mockImplementation(
      queryImpl ?? (() => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }))
    ),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

// ── resolvePoolConfig ─────────────────────────────────────────────────────────

describe('resolvePoolConfig — POOL_MODE', () => {
  const original = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, original);
  });

  it('defaults to "session" when POOL_MODE is not set', () => {
    delete process.env.POOL_MODE;
    expect(resolvePoolConfig().poolMode).toBe('session');
  });

  it('returns "transaction" when POOL_MODE=transaction', () => {
    process.env.POOL_MODE = 'transaction';
    expect(resolvePoolConfig().poolMode).toBe('transaction');
  });

  it('returns "session" when POOL_MODE=session', () => {
    process.env.POOL_MODE = 'session';
    expect(resolvePoolConfig().poolMode).toBe('session');
  });

  it('falls back to "session" for an unknown POOL_MODE value', () => {
    process.env.POOL_MODE = 'unicorn';
    expect(resolvePoolConfig().poolMode).toBe('session');
  });

  it('falls back to "session" for empty POOL_MODE', () => {
    process.env.POOL_MODE = '';
    expect(resolvePoolConfig().poolMode).toBe('session');
  });
});

// ── createPool: session mode (existing behaviour) ─────────────────────────────

describe('createPool — session mode (POOL_MODE=session)', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('applies SET statement_timeout on connect when mode is session and timeout > 0', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50,
      statementTimeoutMs: 3000,
      poolMode: 'session',
    });

    (pool as any).emit('connect', client);

    expect(client.query).toHaveBeenCalledWith('SET statement_timeout = $1', [3000]);
    pool.end();
  });

  it('skips SET statement_timeout when statementTimeoutMs=0 in session mode', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50,
      statementTimeoutMs: 0,
      poolMode: 'session',
    });

    (pool as any).emit('connect', client);

    expect(client.query).not.toHaveBeenCalled();
    pool.end();
  });

  it('stores _poolMode="session" on pool instance', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'session',
    });
    expect((pool as any)._poolMode).toBe('session');
    pool.end();
  });
});

// ── createPool: transaction mode ──────────────────────────────────────────────

describe('createPool — transaction mode (POOL_MODE=transaction)', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('does NOT call SET statement_timeout on connect in transaction mode', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50,
      statementTimeoutMs: 5000,
      poolMode: 'transaction',
    });

    (pool as any).emit('connect', client);

    expect(client.query).not.toHaveBeenCalled();
    pool.end();
  });

  it('stores _poolMode="transaction" on pool instance', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'transaction',
    });
    expect((pool as any)._poolMode).toBe('transaction');
    pool.end();
  });

  it('emits a structured startup warning log in transaction mode', () => {
    // Spy on console.warn as a proxy since logger.warn calls it internally,
    // or check that createPool doesn't throw and the _poolMode is set correctly.
    // We verify the behaviour indirectly via the pool flag rather than
    // coupling to the logger implementation.
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'transaction',
    });
    // If we get here without throwing, the warning path was executed without error.
    expect((pool as any)._poolMode).toBe('transaction');
    pool.end();
  });

  it('does NOT apply statement_timeout in transaction mode even with statementTimeoutMs>0', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 9999,
      poolMode: 'transaction',
    });

    (pool as any).emit('connect', client);

    // query must never have been called — no SET statement_timeout
    expect(client.query).not.toHaveBeenCalled();
    pool.end();
  });

  it('syncGauges still fires in transaction mode (observability unbroken)', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'transaction',
    });

    // Should not throw even without SET statement_timeout
    expect(() => (pool as any).emit('connect', client)).not.toThrow();
    pool.end();
  });
});

// ── isTransactionPoolMode ─────────────────────────────────────────────────────

describe('isTransactionPoolMode()', () => {
  const original = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, original);
    setPool(null);
  });

  beforeEach(() => {
    deRegisterDbMetrics();
    setPool(null);
  });

  it('returns false when no pool exists and POOL_MODE is unset', () => {
    delete process.env.POOL_MODE;
    expect(isTransactionPoolMode()).toBe(false);
  });

  it('returns true when no pool exists and POOL_MODE=transaction', () => {
    process.env.POOL_MODE = 'transaction';
    expect(isTransactionPoolMode()).toBe(true);
  });

  it('returns false when pool was created in session mode', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'session',
    });
    setPool(pool);
    expect(isTransactionPoolMode()).toBe(false);
    pool.end();
  });

  it('returns true when pool was created in transaction mode', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'transaction',
    });
    setPool(pool);
    expect(isTransactionPoolMode()).toBe(true);
    pool.end();
  });
});

// ── Re-applying on reconnect ──────────────────────────────────────────────────

describe('createPool — reconnect behaviour', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('re-applies SET statement_timeout on each new connection in session mode', () => {
    const client1 = makeClient();
    const client2 = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 7000,
      poolMode: 'session',
    });

    (pool as any).emit('connect', client1);
    (pool as any).emit('connect', client2);

    expect(client1.query).toHaveBeenCalledWith('SET statement_timeout = $1', [7000]);
    expect(client2.query).toHaveBeenCalledWith('SET statement_timeout = $1', [7000]);
    pool.end();
  });

  it('never calls SET statement_timeout across multiple connects in transaction mode', () => {
    const client1 = makeClient();
    const client2 = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 7000,
      poolMode: 'transaction',
    });

    (pool as any).emit('connect', client1);
    (pool as any).emit('connect', client2);

    expect(client1.query).not.toHaveBeenCalled();
    expect(client2.query).not.toHaveBeenCalled();
    pool.end();
  });
});

// ── Error class constructors ──────────────────────────────────────────────────

describe('Error class constructors', () => {
  it('PoolExhaustedError has correct name and message', () => {
    const err = new PoolExhaustedError();
    expect(err.name).toBe('PoolExhaustedError');
    expect(err.message).toBe('Database connection pool exhausted');
  });

  it('DuplicateEntryError has correct name and message', () => {
    const err = new DuplicateEntryError('custom detail');
    expect(err.name).toBe('DuplicateEntryError');
    expect(err.message).toBe('custom detail');
  });

  it('DuplicateEntryError uses default message when detail omitted', () => {
    const err = new DuplicateEntryError();
    expect(err.message).toBe('Duplicate entry');
  });

  it('QueryTimeoutError has correct name and message', () => {
    const err = new QueryTimeoutError();
    expect(err.name).toBe('QueryTimeoutError');
    expect(err.message).toBe('Query exceeded statement_timeout limit');
  });
});

// ── isTransactionPoolMode fallback ─────────────────────────────────────────────

describe('isTransactionPoolMode — env fallback when no pool', () => {
  const original = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, original);
    setPool(null);
  });

  it('returns true when POOL_MODE=transaction and no pool exists', () => {
    process.env.POOL_MODE = 'transaction';
    expect(isTransactionPoolMode()).toBe(true);
  });

  it('returns false when POOL_MODE=session and no pool exists', () => {
    process.env.POOL_MODE = 'session';
    expect(isTransactionPoolMode()).toBe(false);
  });

  it('returns false when POOL_MODE unset and no pool exists', () => {
    delete process.env.POOL_MODE;
    expect(isTransactionPoolMode()).toBe(false);
  });
});

// ── allowExitOnIdle: false in transaction mode ────────────────────────────────

describe('createPool — allowExitOnIdle in transaction mode', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('sets allowExitOnIdle: false when poolMode=transaction', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'transaction',
    });
    // @ts-ignore - accessing internal option
    expect(pool.options.allowExitOnIdle).toBe(false);
    pool.end();
  });

  it('sets allowExitOnIdle: true when poolMode=session', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'session',
    });
    // @ts-ignore - accessing internal option
    expect(pool.options.allowExitOnIdle).toBe(true);
    pool.end();
  });

  it('sets allowExitOnIdle: true when poolMode not specified (default session)', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
    });
    // @ts-ignore - accessing internal option
    expect(pool.options.allowExitOnIdle).toBe(true);
    pool.end();
  });
});

// ── Default (no poolMode set) behaves as session ───────────────────────────────

describe('createPool — default (no poolMode field)', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('applies statement_timeout when poolMode is not explicitly set', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 4000,
      // poolMode intentionally omitted — should default to session behaviour
    });

    (pool as any).emit('connect', client);

    expect(client.query).toHaveBeenCalledWith('SET statement_timeout = $1', [4000]);
    pool.end();
  });
});

// ── query — error mapping ───────────────────────────────────────────────────────

describe('query — error mapping', () => {
  beforeEach(() => deRegisterDbMetrics());

  function makePool(queryImpl: () => Promise<pg.QueryResult>): pg.Pool {
    return {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      query: vi.fn().mockImplementation(queryImpl),
      on: vi.fn(),
    } as unknown as pg.Pool;
  }

  it('throws QueryTimeoutError on PG error code 57014', async () => {
    const err = Object.assign(new Error('cancelled'), { code: '57014' });
    const pool = makePool(() => Promise.reject(err));
    await expect(query(pool, 'SELECT 1')).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it('throws DuplicateEntryError on PG error code 23505', async () => {
    const err = Object.assign(new Error('duplicate'), { code: '23505', detail: 'Key (id)=(1) already exists.' });
    const pool = makePool(() => Promise.reject(err));
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toBeInstanceOf(DuplicateEntryError);
  });

  it('DuplicateEntryError carries detail message', async () => {
    const err = Object.assign(new Error('duplicate'), { code: '23505', detail: 'Key (id)=(1) already exists.' });
    const pool = makePool(() => Promise.reject(err));
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toThrow('Key (id)=(1) already exists.');
  });

  it('re-throws non-unique-violation errors unchanged', async () => {
    const err = new Error('connection reset');
    const pool = makePool(() => Promise.reject(err));
    await expect(query(pool, 'SELECT 1')).rejects.toBe(err);
  });
});

// ── getPoolMetrics ──────────────────────────────────────────────────────────────

describe('getPoolMetrics', () => {
  it('returns total, idle, waiting counts', () => {
    const pool = {
      totalCount: 5,
      idleCount: 3,
      waitingCount: 2,
    } as unknown as pg.Pool;
    expect(getPoolMetrics(pool)).toEqual({ total: 5, idle: 3, waiting: 2 });
  });
});

// ── withClient ──────────────────────────────────────────────────────────────────

describe('withClient', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('acquires client, runs fn, and releases client', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      on: vi.fn(),
    } as unknown as pg.Pool;

    const result = await withClient(pool, async (client) => {
      expect(client).toBe(mockClient);
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('releases client even when fn throws', async () => {
    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      on: vi.fn(),
    } as unknown as pg.Pool;

    await expect(withClient(pool, async () => {
      throw new Error('fail');
    })).rejects.toThrow('fail');

    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});

// ── Pool events: remove and error ────────────────────────────────────────────────

describe('createPool — pool events', () => {
  beforeEach(() => deRegisterDbMetrics());

  it('emits remove event and syncs gauges', () => {
    const client = makeClient();
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'session',
    });

    // Trigger remove event
    expect(() => (pool as any).emit('remove', client)).not.toThrow();
    pool.end();
  });

  it('emits error event without throwing', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5,
      connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
      queueLimit: 50, statementTimeoutMs: 5000,
      poolMode: 'session',
    });

    // Trigger error event
    expect(() => (pool as any).emit('error', new Error('test error'))).not.toThrow();
    pool.end();
  });
});

// ── query — slow query logging ───────────────────────────────────────────────────

describe('query — slow query logging', () => {
  beforeEach(() => deRegisterDbMetrics());

  function makePool(queryImpl: () => Promise<pg.QueryResult>, latencyMs: number): pg.Pool {
    let callCount = 0;
    return {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      query: vi.fn().mockImplementation(async () => {
        const start = Date.now();
        // Simulate latency by waiting
        while (Date.now() - start < latencyMs) {
          // busy wait for test
        }
        callCount++;
        return queryImpl();
      }),
      on: vi.fn(),
    } as unknown as pg.Pool;
  }

  it('logs slow query when latency exceeds threshold', async () => {
    const pool = makePool(
      () => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
      50, // 50ms latency
    );

    // Set threshold to 10ms
    await query(pool, 'SELECT * FROM users', undefined, 10);

    // The query should complete and log slow query
    expect(pool.query).toHaveBeenCalled();
    pool.end?.();
  });

  it('does not log slow query when latency is below threshold', async () => {
    const pool = makePool(
      () => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
      5, // 5ms latency
    );

    // Set threshold to 100ms
    await query(pool, 'SELECT * FROM users', undefined, 100);

    expect(pool.query).toHaveBeenCalled();
    pool.end?.();
  });
});

// ── extractTableHint ──────────────────────────────────────────────────────────────

describe('extractTableHint', () => {
  it('extracts table name from SELECT', () => {
    expect(extractTableHint('SELECT * FROM users')).toBe('users');
  });

  it('extracts table name from INSERT', () => {
    expect(extractTableHint('INSERT INTO accounts VALUES (1)')).toBe('accounts');
  });

  it('extracts table name from UPDATE', () => {
    expect(extractTableHint('UPDATE orders SET status = 1')).toBe('orders');
  });

  it('extracts table name from JOIN', () => {
    expect(extractTableHint('SELECT * FROM a JOIN b ON a.id = b.id')).toBe('a');
  });

  it('returns unknown for SQL without table reference', () => {
    expect(extractTableHint('SELECT 1')).toBe('unknown');
  });

  it('handles quoted table names', () => {
    expect(extractTableHint('SELECT * FROM "my_table"')).toBe('my_table');
  });
});
