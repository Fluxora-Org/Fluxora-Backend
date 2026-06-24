import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { checkReplicaHealth, ReplicaRouter } from '../../src/db/replicaPool.js';
import { deRegisterBusinessMetrics } from '../../src/metrics/businessMetrics.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeClient(lagMs: string | null): pg.PoolClient {
  return {
    query: vi.fn(async () => ({ rows: [{ lag_ms: lagMs }] })),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function makeErrClient(error: Error): pg.PoolClient {
  return {
    query: vi.fn(async () => { throw error; }),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function makePool(client: pg.PoolClient): pg.Pool {
  return { connect: vi.fn(async () => client) } as unknown as pg.Pool;
}

const THRESHOLD = 5_000;

// ── checkReplicaHealth ────────────────────────────────────────────────────────

describe('checkReplicaHealth', () => {
  beforeEach(() => { deRegisterBusinessMetrics(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns healthy when lag is below threshold', async () => {
    const client = makeClient('1000');
    const result = await checkReplicaHealth(client, THRESHOLD);
    expect(result.healthy).toBe(true);
    expect(result.lagMs).toBe(1000);
    expect(result.reason).toBeUndefined();
  });

  it('returns healthy when lag equals threshold exactly', async () => {
    const client = makeClient(String(THRESHOLD));
    const result = await checkReplicaHealth(client, THRESHOLD);
    expect(result.healthy).toBe(true);
    expect(result.lagMs).toBe(THRESHOLD);
  });

  it('returns unhealthy when lag exceeds threshold', async () => {
    const client = makeClient('10000');
    const result = await checkReplicaHealth(client, THRESHOLD);
    expect(result.healthy).toBe(false);
    expect(result.lagMs).toBe(10_000);
    expect(result.reason).toMatch(/exceeds threshold/);
  });

  it('returns unhealthy with lagMs=-1 when replica has never replayed WAL (NULL)', async () => {
    const client = makeClient(null);
    const result = await checkReplicaHealth(client, THRESHOLD);
    expect(result.healthy).toBe(false);
    expect(result.lagMs).toBe(-1);
    expect(result.reason).toMatch(/not yet replayed any WAL/);
  });

  it('returns unhealthy with lagMs=-1 when query throws', async () => {
    const client = makeErrClient(new Error('connection refused'));
    const result = await checkReplicaHealth(client, THRESHOLD);
    expect(result.healthy).toBe(false);
    expect(result.lagMs).toBe(-1);
    expect(result.reason).toMatch(/lag probe failed/);
  });
});

// ── ReplicaRouter ─────────────────────────────────────────────────────────────

describe('ReplicaRouter', () => {
  beforeEach(() => { deRegisterBusinessMetrics(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns primary when no replica is configured', async () => {
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: null, lagThresholdMs: THRESHOLD });
    expect(await router.getReadPool()).toBe(primary);
    expect(router.isReplicaHealthy()).toBe(true);
  });

  it('returns replica pool when lag is below threshold', async () => {
    const client = makeClient('500');
    const replica = makePool(client);
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: replica, lagThresholdMs: THRESHOLD });

    expect(await router.getReadPool()).toBe(replica);
    expect(router.isReplicaHealthy()).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('fails over to primary when lag exceeds threshold', async () => {
    const client = makeClient('99999');
    const replica = makePool(client);
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: replica, lagThresholdMs: THRESHOLD });

    expect(await router.getReadPool()).toBe(primary);
    expect(router.isReplicaHealthy()).toBe(false);
  });

  it('fails over to primary when replica is unreachable', async () => {
    const errClient = makeErrClient(new Error('ECONNREFUSED'));
    const replica = makePool(errClient);
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: replica, lagThresholdMs: THRESHOLD });

    expect(await router.getReadPool()).toBe(primary);
    expect(router.isReplicaHealthy()).toBe(false);
  });

  it('recovers to replica once lag drops back below threshold', async () => {
    const highLagClient = makeClient('99999');
    const replicaPool = { connect: vi.fn(async () => highLagClient) } as unknown as pg.Pool;
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: replicaPool, lagThresholdMs: THRESHOLD });

    // First call — over threshold, failover
    await router.getReadPool();
    expect(router.isReplicaHealthy()).toBe(false);

    // Replica catches up
    const lowLagClient = makeClient('200');
    (replicaPool as unknown as { connect: ReturnType<typeof vi.fn> }).connect.mockResolvedValue(lowLagClient);

    // Second call — healthy again
    const pool = await router.getReadPool();
    expect(pool).toBe(replicaPool);
    expect(router.isReplicaHealthy()).toBe(true);
  });

  it('does not double-count failover counter on sustained lag', async () => {
    const { replicaFailoversTotal } = await import('../../src/metrics/businessMetrics.js');
    const incSpy = vi.spyOn(replicaFailoversTotal, 'inc');

    const client = makeClient('99999');
    const replica = makePool(client);
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: replica, lagThresholdMs: THRESHOLD });

    await router.getReadPool(); // first breach
    await router.getReadPool(); // still lagging
    await router.getReadPool(); // still lagging

    // Counter incremented exactly once
    expect(incSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the probe client even when the lag probe throws', async () => {
    const errClient = makeErrClient(new Error('network timeout'));
    const replica = { connect: vi.fn(async () => errClient) } as unknown as pg.Pool;
    const primary = makePool(makeClient('0'));
    const router = new ReplicaRouter({ primaryPool: primary, replicaPool: replica, lagThresholdMs: THRESHOLD });

    await router.getReadPool();
    expect(errClient.release).toHaveBeenCalledOnce();
  });
});
