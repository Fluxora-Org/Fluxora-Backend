/**
 * Tests for replication-lag-based read routing.
 *
 * Acceptance criterion: "Lag beyond a configured bound routes reads
 * to the primary or fails explicitly."
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock factories before imports.
const { mockPrimaryQuery, mockReplicaQuery, mockLag } = vi.hoisted(() => {
  const mockPrimaryQuery = vi.fn().mockResolvedValue({ rows: [] });
  const mockReplicaQuery = vi.fn().mockResolvedValue({ rows: [] });
  const mockLag = vi.fn<[], Promise<number | null>>();
  return { mockPrimaryQuery, mockReplicaQuery, mockLag };
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

import {
  getReadPool,
  resetReplicaPool,
  setReplicaPool,
  checkReplicationLag,
} from '../../src/db/replicaPool.js';

// We spy on checkReplicationLag to simulate different lag values.
vi.mock('../../src/db/replicaPool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/replicaPool.js')>();
  return {
    ...actual,
    checkReplicationLag: mockLag,
  };
});

describe('getReadPool — lag-based primary fallback', () => {
  const fakeReplica = { query: mockReplicaQuery } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetReplicaPool();
    // Start with a healthy replica already initialised.
    setReplicaPool(fakeReplica, true);
  });

  afterEach(() => {
    resetReplicaPool();
    // Reset env var
    delete process.env['REPLICA_MAX_LAG_SECONDS'];
  });

  it('returns the replica pool when lag is within the threshold', async () => {
    mockLag.mockResolvedValue(5); // 5 s < 30 s default
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    expect(pool).toBe(fakeReplica);
  });

  it('falls back to primary when lag exceeds the configured threshold', async () => {
    mockLag.mockResolvedValue(45); // 45 s > 30 s
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    // Should be the primary pool, not the replica.
    expect(pool).not.toBe(fakeReplica);
  });

  it('returns the replica when lag equals exactly the threshold (boundary)', async () => {
    mockLag.mockResolvedValue(30); // equal — should NOT fall back
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    expect(pool).toBe(fakeReplica);
  });

  it('skips lag check and returns replica when REPLICA_MAX_LAG_SECONDS=0 (disabled)', async () => {
    process.env['REPLICA_MAX_LAG_SECONDS'] = '0';
    // Even with very high reported lag
    mockLag.mockResolvedValue(999);

    const pool = await getReadPool();
    expect(pool).toBe(fakeReplica);
    // checkReplicationLag should not have been called
    expect(mockLag).not.toHaveBeenCalled();
  });

  it('returns replica when lag check returns null (unavailable metric)', async () => {
    mockLag.mockResolvedValue(null);
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool();
    // null → can't determine lag → don't fall back unnecessarily
    expect(pool).toBe(fakeReplica);
  });

  it('still respects forcePrimary=true regardless of lag', async () => {
    mockLag.mockResolvedValue(0); // zero lag
    process.env['REPLICA_MAX_LAG_SECONDS'] = '30';

    const pool = await getReadPool({ forcePrimary: true });
    expect(pool).not.toBe(fakeReplica);
    expect(mockLag).not.toHaveBeenCalled();
  });
});
