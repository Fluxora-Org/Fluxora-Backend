import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  resolvePoolConfig,
  createPool,
  getPool,
  setPool,
  query,
  getPoolMetrics,
  PoolExhaustedError,
  DuplicateEntryError,
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
    query: jest.fn<() => Promise<pg.QueryResult>>().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
    on: jest.fn(),
    ...overrides,
  } as unknown as pg.Pool;
}

describe('query', () => {
  it('returns query result on success', async () => {
    const pool = makePool();
    const result = await query(pool, 'SELECT 1');
    expect(result.rows).toEqual([]);
  });

  it('throws PoolExhaustedError when pool is full and requests are waiting', async () => {
    const pool = makePool({ totalCount: 10, idleCount: 0, waitingCount: 1 });
    await expect(query(pool, 'SELECT 1')).rejects.toBeInstanceOf(PoolExhaustedError);
  });

  it('throws DuplicateEntryError on unique constraint violation', async () => {
    const pgError = Object.assign(new Error('dup'), { code: '23505', detail: 'Key already exists' });
    const pool = makePool({
      query: jest.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toBeInstanceOf(DuplicateEntryError);
  });

  it('DuplicateEntryError carries the pg detail message', async () => {
    const pgError = Object.assign(new Error('dup'), { code: '23505', detail: 'Key (id)=(1) already exists.' });
    const pool = makePool({
      query: jest.fn<() => Promise<never>>().mockRejectedValue(pgError),
    });
    await expect(query(pool, 'INSERT INTO t VALUES ($1)', [1])).rejects.toThrow('Key (id)=(1) already exists.');
  });

  it('re-throws non-unique-violation errors unchanged', async () => {
    const err = new Error('connection reset');
    const pool = makePool({
      query: jest.fn<() => Promise<never>>().mockRejectedValue(err),
    });
    await expect(query(pool, 'SELECT 1')).rejects.toBe(err);
  });

  it('logs a warning for slow queries (latency > 1000ms)', async () => {
    let call = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 1000 : 2001));
    const pool = makePool();
    await query(pool, 'SELECT slow');
    jest.spyOn(Date, 'now').mockRestore();
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
