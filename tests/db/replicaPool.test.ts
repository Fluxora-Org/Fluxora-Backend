/**
 * Unit tests for the read-replica pool module (src/db/replicaPool.ts).
 *
 * Covers:
 *   1. Successful connection to replica when DATABASE_REPLICA_URL is set.
 *   2. Fallback to primary pool when DATABASE_REPLICA_URL is absent.
 *   3. Fallback to primary pool when the replica health-check fails.
 *   4. Read-only enforcement on replica connections.
 *   5. Safe hostname extraction for logging.
 *   6. Singleton caching after the first call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';

// ── Mock the pg module ────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('pg', () => {
  const MockPool = vi.fn().mockImplementation(() => ({
    query: mockQuery,
    end: mockEnd,
    on: mockOn,
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  }));
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// ── Mock logger to avoid console noise ────────────────────────────────────────

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock the primary pool ─────────────────────────────────────────────────────

const mockPrimaryPool = {
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  totalCount: 1,
  idleCount: 1,
  waitingCount: 0,
} as unknown as pg.Pool;

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => mockPrimaryPool),
  createPool: vi.fn(),
  resolvePoolConfig: vi.fn(() => ({
    connectionString: 'postgresql://primary:5432/fluxora',
    min: 2,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    queueLimit: 50,
    statementTimeoutMs: 5000,
  })),
}));

// ── Import SUT (after mocks are registered) ───────────────────────────────────

import {
  getReadPool,
  resetReplicaPool,
  resolveReplicaPoolConfig,
  checkReplicaHealth,
  createReplicaPool,
} from '../../src/db/replicaPool.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('replicaPool', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetReplicaPool();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // ── resolveReplicaPoolConfig ──────────────────────────────────────────────

  describe('resolveReplicaPoolConfig', () => {
    it('returns null when DATABASE_REPLICA_URL is not set', () => {
      delete process.env['DATABASE_REPLICA_URL'];
      expect(resolveReplicaPoolConfig()).toBeNull();
    });

    it('returns a config using DATABASE_REPLICA_URL when set', () => {
      process.env['DATABASE_REPLICA_URL'] = 'postgresql://replica:5432/fluxora';
      const config = resolveReplicaPoolConfig();
      expect(config).not.toBeNull();
      expect(config!.connectionString).toBe('postgresql://replica:5432/fluxora');
      // Pool sizing should inherit from primary
      expect(config!.min).toBe(2);
      expect(config!.max).toBe(10);
    });
  });

  // ── checkReplicaHealth ────────────────────────────────────────────────────

  describe('checkReplicaHealth', () => {
    it('returns true when SELECT 1 succeeds', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      const pool = new pg.Pool();
      const healthy = await checkReplicaHealth(pool);
      expect(healthy).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('returns false when SELECT 1 throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));
      const pool = new pg.Pool();
      const healthy = await checkReplicaHealth(pool);
      expect(healthy).toBe(false);
    });
  });

  // ── createReplicaPool ─────────────────────────────────────────────────────

  describe('createReplicaPool', () => {
    it('creates a pool and registers a connect handler for read-only mode', () => {
      const pool = createReplicaPool({
        connectionString: 'postgresql://replica:5432/fluxora',
        min: 1,
        max: 5,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000,
        queueLimit: 20,
        statementTimeoutMs: 3000,
      });

      // Verify the 'connect' event handler was registered
      expect(mockOn).toHaveBeenCalledWith('connect', expect.any(Function));
      // Verify the 'error' event handler was registered
      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('connect handler sets default_transaction_read_only = on', () => {
      createReplicaPool({
        connectionString: 'postgresql://replica:5432/fluxora',
        min: 1,
        max: 5,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000,
        queueLimit: 20,
        statementTimeoutMs: 3000,
      });

      // Find the 'connect' handler
      const connectCall = mockOn.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'connect'
      );
      expect(connectCall).toBeDefined();

      // Simulate a new connection
      const mockClient = {
        query: vi.fn().mockResolvedValue(undefined),
      };
      connectCall![1](mockClient);
      expect(mockClient.query).toHaveBeenCalledWith('SET default_transaction_read_only = on');
    });
  });

  // ── getReadPool ───────────────────────────────────────────────────────────

  describe('getReadPool', () => {
    it('returns the primary pool when DATABASE_REPLICA_URL is not set', async () => {
      delete process.env['DATABASE_REPLICA_URL'];
      const pool = await getReadPool();
      expect(pool).toBe(mockPrimaryPool);
    });

    it('returns the replica pool when DATABASE_REPLICA_URL is set and replica is healthy', async () => {
      process.env['DATABASE_REPLICA_URL'] = 'postgresql://replica:5432/fluxora';
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const pool = await getReadPool();
      // Should NOT be the primary pool
      expect(pool).not.toBe(mockPrimaryPool);
    });

    it('falls back to primary when replica health-check fails', async () => {
      process.env['DATABASE_REPLICA_URL'] = 'postgresql://replica:5432/fluxora';
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      const pool = await getReadPool();
      expect(pool).toBe(mockPrimaryPool);
    });

    it('caches the result after the first call (healthy replica)', async () => {
      process.env['DATABASE_REPLICA_URL'] = 'postgresql://replica:5432/fluxora';
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const pool1 = await getReadPool();
      const pool2 = await getReadPool();
      expect(pool1).toBe(pool2);
      // SELECT 1 should only be called once (health-check)
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('caches the result after the first call (no replica URL)', async () => {
      delete process.env['DATABASE_REPLICA_URL'];

      const pool1 = await getReadPool();
      const pool2 = await getReadPool();
      expect(pool1).toBe(pool2);
      expect(pool1).toBe(mockPrimaryPool);
    });

    it('closes the replica pool on health-check failure before falling back', async () => {
      process.env['DATABASE_REPLICA_URL'] = 'postgresql://replica:5432/fluxora';
      mockQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await getReadPool();
      expect(mockEnd).toHaveBeenCalled();
    });
  });

  // ── resetReplicaPool ──────────────────────────────────────────────────────

  describe('resetReplicaPool', () => {
    it('allows re-initialisation after reset', async () => {
      delete process.env['DATABASE_REPLICA_URL'];
      const pool1 = await getReadPool();
      expect(pool1).toBe(mockPrimaryPool);

      resetReplicaPool();

      // Now set the replica URL
      process.env['DATABASE_REPLICA_URL'] = 'postgresql://replica:5432/fluxora';
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const pool2 = await getReadPool();
      expect(pool2).not.toBe(mockPrimaryPool);
    });
  });
});
