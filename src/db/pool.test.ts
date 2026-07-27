import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import {
  resolvePoolConfig,
  createPool,
  getPool,
  setPool,
  query,
  getPoolMetrics,
  extractTableHint,
  withClient,
  PoolExhaustedError,
  DuplicateEntryError,
  QueryTimeoutError,
} from './pool';
import type pg from 'pg';

// ── resolvePoolConfig ─────────────────────────────────────────────────────────

describe('resolvePoolConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, original);
  });

  it('uses defaults when env vars are absent', () => {
    delete process.env.DB_POOL_MIN;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_CONNECTION_TIMEOUT;
    delete process.env.DB_IDLE_TIMEOUT;
    const cfg = resolvePoolConfig();
    expect(cfg.min).toBe(2);
    expect(cfg.max).toBe(10);
    expect(cfg.connectionTimeoutMillis).toBe(5_000);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
  });

  it('reads values from env vars', () => {
    process.env.DB_POOL_MIN = '3';
    process.env.DB_POOL_MAX = '20';
    process.env.DB_CONNECTION_TIMEOUT = '3000';
    process.env.DB_IDLE_TIMEOUT = '60000';
    const cfg = resolvePoolConfig();
    expect(cfg.min).toBe(3);
    expect(cfg.max).toBe(20);
    expect(cfg.connectionTimeoutMillis).toBe(3_000);
    expect(cfg.idleTimeoutMillis).toBe(60_000);
  });

  it('falls back to default for non-numeric env var', () => {
    process.env.DB_POOL_MAX = 'bad';
    expect(resolvePoolConfig().max).toBe(10);
  });
});

// ── getPool / setPool ─────────────────────────────────────────────────────────

describe('getPool / setPool', () => {
  afterEach(() => setPool(null));

  it('returns the same instance on repeated calls', () => {
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
    a.end();
  });

  it('setPool replaces the singleton', () => {
    const fake = {} as pg.Pool;
    setPool(fake);
    expect(getPool()).toBe(fake);
  });
});

// ── query helper ──────────────────────────────────────────────────────────────

function makePool(overrides: Partial<pg.Pool> = {}): pg.Pool {
  return {
    totalCount: 0,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 10 },
    query: vi.fn<() => Promise<pg.QueryResult>>().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
    on: vi.fn(),
    ...overrides,
  } as unknown as pg.Pool;
}

describe('query', () => {
  it('returns query result on success', async () => {
    const pool = makePool();
    const result = await query(pool, 'SELECT 1');
    expect(result.rows).toEqual([]);
  });

  it('throws PoolExhaustedError when waiting queue reaches the queue limit', async () => {
    const pool = makePool({ totalCount: 10, idleCount: 0, waitingCount: 50 });
    await expect(query(pool, 'SELECT 1', undefined, 50)).rejects.toBeInstanceOf(PoolExhaustedError);
  });

  it('throws DuplicateEntryError on unique constraint violation', async () => {
    const pgError = Object.assign(new Error('dup'), { code: '23505', detail: 'Key already exists' });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toBeInstanceOf(DuplicateEntryError);
  });

  it('DuplicateEntryError carries the pg detail message', async () => {
    const pgError = Object.assign(new Error('dup'), { code: '23505', detail: 'Key (id)=(1) already exists.' });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toThrow('Key (id)=(1) already exists.');
  });

  it('re-throws non-unique-violation errors unchanged', async () => {
    const err = new Error('connection reset');
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(err),
    });
    await expect(query(pool, 'SELECT 1')).rejects.toBe(err);
  });

  it('logs a warning for slow queries (latency > 1000ms)', async () => {
    let call = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 1000 : 2001));
    const pool = makePool();
    await query(pool, 'SELECT slow');
    vi.spyOn(Date, 'now').mockRestore();
  });
});

// ── getPoolMetrics ────────────────────────────────────────────────────────────

describe('getPoolMetrics', () => {
  it('returns total, idle, waiting counts', () => {
    const pool = makePool({ totalCount: 5, idleCount: 3, waitingCount: 2 });
    expect(getPoolMetrics(pool)).toEqual({ total: 5, idle: 3, waiting: 2 });
  });
});

// ── createPool ────────────────────────────────────────────────────────────────

describe('createPool', () => {
  it('creates a pool with the given config', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5, connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
    });
    expect(pool).toBeDefined();
    pool.end();
  });

  it('pool error event is handled without throwing', () => {
    const pool = createPool({
      connectionString: 'postgresql://localhost/test',
      min: 1, max: 5, connectionTimeoutMillis: 1000, idleTimeoutMillis: 5000,
    });
    expect(() => pool.emit('error', new Error('test error'))).not.toThrow();
    pool.end();
  });
});

// ── extractTableHint ─────────────────────────────────────────────────────────────

describe('extractTableHint', () => {
  it('extracts table name from SELECT', () => {
    expect(extractTableHint('SELECT * FROM users')).toBe('users');
  });

  it('extracts table name from INSERT', () => {
    expect(extractTableHint('INSERT INTO accounts (id) VALUES ($1)')).toBe('accounts');
  });

  it('extracts table name from UPDATE', () => {
    expect(extractTableHint('UPDATE orders SET status = $1')).toBe('orders');
  });

  it('extracts table name from JOIN', () => {
    expect(extractTableHint('SELECT * FROM a JOIN b ON a.id = b.id')).toBe('a');
  });

  it('returns unknown for SQL without table reference', () => {
    expect(extractTableHint('SELECT 1')).toBe('unknown');
  });
});

// ── query helper: error mapping ──────────────────────────────────────────────────

describe('query — error mapping', () => {
  function makePool(overrides: Partial<pg.Pool> = {}): pg.Pool {
    return {
      totalCount: 0,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      query: vi.fn<() => Promise<pg.QueryResult>>().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
      on: vi.fn(),
      ...overrides,
    } as unknown as pg.Pool;
  }

  it('throws QueryTimeoutError on PG error code 57014', async () => {
    const pgError = Object.assign(new Error('cancelled'), { code: '57014' });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });
    await expect(query(pool, 'SELECT 1')).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it('throws DuplicateEntryError on PG error code 23505', async () => {
    const pgError = Object.assign(new Error('dup'), { code: '23505', detail: 'Key (id)=(1) already exists.' });
    const pool = makePool({
      query: vi.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toBeInstanceOf(DuplicateEntryError);
  });
});

// ── query helper: slow query logging ─────────────────────────────────────────────

describe('query — slow query logging', () => {
  function makePool(overrides: Partial<pg.Pool> = {}): pg.Pool {
    return {
      totalCount: 0,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      query: vi.fn<() => Promise<pg.QueryResult>>().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
      on: vi.fn(),
      ...overrides,
    } as unknown as pg.Pool;
  }

  it('logs slow query when latency exceeds threshold', async () => {
    let call = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 1000 : 2001));
    const pool = makePool();
    await query(pool, 'SELECT * FROM large_table', undefined, 500);
    nowSpy.mockRestore();
  });
});

// ── withClient ───────────────────────────────────────────────────────────────────

describe('withClient', () => {
  it('acquires client, runs fn, and releases client', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as pg.Pool;

    const result = await withClient(mockPool, async (client) => {
      const res = await client.query('SELECT 1');
      return res.rows[0];
    });

    expect(result).toEqual({ id: 1 });
    expect(mockPool.connect).toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('releases client even when fn throws', async () => {
    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as pg.Pool;

    await expect(withClient(mockPool, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(mockClient.release).toHaveBeenCalled();
  });
});
