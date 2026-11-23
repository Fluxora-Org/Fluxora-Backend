/**
 * Tests for replication-lag-based read routing.
 *
 * Acceptance criterion: "Lag beyond a configured bound routes reads
 * to the primary or fails explicitly."
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock factories before imports.
const { mockPrimaryQuery, mockReplicaQuery } = vi.hoisted(() => {
  const mockPrimaryQuery = vi.fn().mockResolvedValue({ rows: [] });
  const mockReplicaQuery = vi.fn().mockResolvedValue({ rows: [] });
  return { mockPrimaryQuery, mockReplicaQuery };
});

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({ query: mockPrimaryQuery })),
  createPool: vi.fn(),
  resolvePoolConfig: vi.fn(() => ({
    connectionString: 'postgresql://primary/test',
    min: 1, max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    queueLimit: 20,
    statementTimeoutMs: 3000,
  })),
  query: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {},
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/metrics/dbMetrics.js', () => ({
  dbReplicationLagSeconds: { set: vi.fn() },
}));

import { logger } from '../../src/lib/logger.js';
import {
  getReadPool,
  resetReplicaPool,
  setReplicaPool,
} from '../../src/db/replicaPool.js';

describe('getReadPool — lag-based primary fallback', () => {
  const fakeReplica = { query: mockReplicaQuery } as any;

  function setMeasuredLag(lagSeconds: number | null): void {
    mockReplicaQuery.mockResolvedValue({
      rows: [{ lag_seconds: lagSeconds }],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetReplicaPool();
    // Start with a healthy replica already initialised.
    setReplicaPool(fakeReplica, true);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetReplicaPool();
    // Reset env var
    delete process.env['REPLICA_MAX_LAG_SECONDS'];
  });

  it('returns the replica pool when lag is within the threshold', async () => {
    setMeasuredLag(5); // 5 s < 30 s default
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    expect(pool).toBe(fakeReplica);
  });

  it('falls back to primary when lag exceeds the configured threshold', async () => {
    setMeasuredLag(45); // 45 s > 30 s
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    // Should be the primary pool, not the replica.
    expect(pool).not.toBe(fakeReplica);
  });

  it('returns the replica when lag equals exactly the threshold (boundary)', async () => {
    setMeasuredLag(30); // equal — should NOT fall back
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    expect(pool).toBe(fakeReplica);
  });

  it('skips lag check and returns replica when REPLICA_MAX_LAG_SECONDS=0 (disabled)', async () => {
    process.env['REPLICA_MAX_LAG_SECONDS'] = '0';
    // Even with very high reported lag
    setMeasuredLag(999);

    const pool = await getReadPool();
    expect(pool).toBe(fakeReplica);
    // checkReplicationLag should not have queried the replica
    expect(mockReplicaQuery).not.toHaveBeenCalled();
  });

  it('returns replica when lag check returns null (unavailable metric)', async () => {
    setMeasuredLag(null);
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    // null → can't determine lag → don't fall back unnecessarily
    expect(pool).toBe(fakeReplica);
  });

  it('still respects forcePrimary=true regardless of lag', async () => {
    setMeasuredLag(0); // zero lag
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool({ forcePrimary: true });
    expect(pool).not.toBe(fakeReplica);
    expect(mockReplicaQuery).not.toHaveBeenCalled();
  });

  it('emits fallback warning once per transition and recovers after cache TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    // Transition 1: replica becomes stale
    setMeasuredLag(45);
    expect(await getReadPool()).not.toBe(fakeReplica);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Repeated call within cache TTL stays on primary without re-logging
    expect(await getReadPool()).not.toBe(fakeReplica);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Advance past 30 s lag-check cache TTL; lag recovers
    vi.advanceTimersByTime(30_000);
    setMeasuredLag(5);
    expect(await getReadPool()).toBe(fakeReplica);
    expect(logger.info).toHaveBeenCalledTimes(1);

    // Advance past 30 s TTL again; lag spikes again -> logs once for new transition
    vi.advanceTimersByTime(30_000);
    setMeasuredLag(60);
    expect(await getReadPool()).not.toBe(fakeReplica);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
