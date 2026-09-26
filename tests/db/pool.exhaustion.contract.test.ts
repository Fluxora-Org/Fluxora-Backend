import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  PoolExhaustedError,
  query,
  resolvePoolConfig,
} from '../../src/db/pool.js';
import { dbPoolExhaustedTotal, deRegisterDbMetrics } from '../../src/metrics/dbMetrics.js';

function fakePool(waitingCount: number, queueLimit: number): pg.Pool {
  return {
    totalCount: 10,
    idleCount: 0,
    waitingCount,
    options: { max: 10 },
    query: vi.fn(),
    on: vi.fn(),
    _queueLimit: queueLimit,
  } as unknown as pg.Pool;
}

describe('database pool sizing and exhaustion contract', () => {
  afterEach(() => {
    delete process.env.DB_POOL_MIN;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_CONNECTION_TIMEOUT;
    delete process.env.DB_IDLE_TIMEOUT;
    delete process.env.POOL_QUEUE_LIMIT;
    deRegisterDbMetrics();
  });

  it('resolves bounded pool sizing and acquisition settings from configuration', () => {
    process.env.DB_POOL_MIN = '2';
    process.env.DB_POOL_MAX = '12';
    process.env.DB_CONNECTION_TIMEOUT = '2500';
    process.env.DB_IDLE_TIMEOUT = '45000';
    process.env.POOL_QUEUE_LIMIT = '8';

    expect(resolvePoolConfig()).toMatchObject({
      min: 2,
      max: 12,
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 45000,
      queueLimit: 8,
    });
  });

  it('fails fast with a typed error and increments the exhaustion metric', async () => {
    const pool = fakePool(8, 8);
    const before = (await dbPoolExhaustedTotal.get()).values[0]?.value ?? 0;

    await expect(query(pool, 'SELECT 1')).rejects.toBeInstanceOf(PoolExhaustedError);

    const after = (await dbPoolExhaustedTotal.get()).values[0]?.value ?? 0;
    expect(after).toBe(before + 1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('allows a request below the queue limit to acquire a connection', async () => {
    const pool = fakePool(7, 8);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    await expect(query(pool, 'SELECT 1')).resolves.toBeDefined();
    expect(pool.query).toHaveBeenCalledOnce();
  });
});
