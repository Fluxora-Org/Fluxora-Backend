import { describe, it, expect, jest } from '@jest/globals';
import {
  createPostgresChecker,
  createStellarRpcChecker,
  createRedisChecker,
  sanitiseErrorMessage,
} from './checkers.js';
import type { PostgresClient, StellarRpcClient, RedisClient } from './checkers.js';

// ── sanitiseErrorMessage ──────────────────────────────────────────────────────

describe('sanitiseErrorMessage', () => {
  it('redacts postgresql:// connection strings', () => {
    const msg = 'connect ECONNREFUSED postgresql://user:pass@localhost:5432/db';
    const result = sanitiseErrorMessage(msg);
    expect(result).not.toContain('user:pass');
    expect(result).not.toContain('localhost:5432');
    expect(result).toContain('[redacted-url]');
  });

  it('redacts redis:// connection strings', () => {
    const msg = 'Error: redis://admin:secret@redis-host:6379';
    const result = sanitiseErrorMessage(msg);
    expect(result).not.toContain('secret');
    expect(result).toContain('[redacted-url]');
  });

  it('redacts user:password@host patterns', () => {
    const msg = 'auth failed for user:password@myhost';
    const result = sanitiseErrorMessage(msg);
    expect(result).not.toContain('password');
    expect(result).toContain('[redacted-credentials]');
  });

  it('leaves plain error messages unchanged', () => {
    const msg = 'Connection timed out after 5000ms';
    expect(sanitiseErrorMessage(msg)).toBe(msg);
  });
});

// ── Postgres checker ──────────────────────────────────────────────────────────

describe('createPostgresChecker', () => {
  it('has name "postgres"', () => {
    const client: PostgresClient = { query: jest.fn<() => Promise<unknown>>().mockResolvedValue({}) };
    expect(createPostgresChecker(() => client).name).toBe('postgres');
  });

  it('returns healthy when SELECT 1 resolves', async () => {
    const client: PostgresClient = { query: jest.fn<() => Promise<unknown>>().mockResolvedValue({}) };
    const result = await createPostgresChecker(() => client).check();
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('returns error when query rejects with Error', async () => {
    const client: PostgresClient = {
      query: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('Connection refused')),
    };
    const result = await createPostgresChecker(() => client).check();
    expect(result.error).toBe('Connection refused');
  });

  it('returns error when query rejects with non-Error value', async () => {
    const client: PostgresClient = {
      query: jest.fn<() => Promise<unknown>>().mockRejectedValue('string error'),
    };
    const result = await createPostgresChecker(() => client).check();
    expect(result.error).toBe('string error');
  });

  it('returns timeout error when query hangs', async () => {
    const client: PostgresClient = {
      query: jest.fn<() => Promise<unknown>>().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      ),
    };
    const result = await createPostgresChecker(() => client, { timeoutMs: 50 }).check();
    expect(result.error).toMatch(/timed out/);
  }, 1000);

  it('returns pool exhaustion error when idle count is 0 and pool is full', async () => {
    const client: PostgresClient & { totalCount: number; idleCount: number } = {
      query: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
      totalCount: 10,
      idleCount: 0,
    };
    const result = await createPostgresChecker(() => client, { maxPoolSize: 10 }).check();
    expect(result.error).toMatch(/pool exhausted/i);
  });

  it('is healthy when pool has idle connections', async () => {
    const client: PostgresClient & { totalCount: number; idleCount: number } = {
      query: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
      totalCount: 10,
      idleCount: 2,
    };
    const result = await createPostgresChecker(() => client, { maxPoolSize: 10 }).check();
    expect(result.error).toBeUndefined();
  });

  it('returns degraded when latency exceeds threshold', async () => {
    const client: PostgresClient = {
      query: jest.fn<() => Promise<unknown>>().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 80)),
      ),
    };
    const result = await createPostgresChecker(() => client, { degradedLatencyMs: 10 }).check();
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBe(true);
  }, 2000);

  it('sanitises connection strings from error messages', async () => {
    const client: PostgresClient = {
      query: jest.fn<() => Promise<unknown>>().mockRejectedValue(
        new Error('connect ECONNREFUSED postgresql://user:secret@localhost:5432/db'),
      ),
    };
    const result = await createPostgresChecker(() => client).check();
    expect(result.error).not.toContain('secret');
    expect(result.error).toContain('[redacted-url]');
  });

  it('does not report degraded when latency is below threshold', async () => {
    const client: PostgresClient = { query: jest.fn<() => Promise<unknown>>().mockResolvedValue({}) };
    const result = await createPostgresChecker(() => client, { degradedLatencyMs: 60_000 }).check();
    expect(result.degraded).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

// ── Stellar RPC checker ───────────────────────────────────────────────────────

describe('createStellarRpcChecker', () => {
  it('has name "stellar_rpc"', () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockResolvedValue({ sequence: 1 }),
    };
    expect(createStellarRpcChecker(() => client).name).toBe('stellar_rpc');
  });

  it('returns healthy when getLatestLedger resolves with a sequence', async () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockResolvedValue({ sequence: 12345 }),
    };
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('returns error when getLatestLedger rejects with Error', async () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(
        new Error('RPC unreachable'),
      ),
    };
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).toBe('RPC unreachable');
  });

  it('returns error when getLatestLedger rejects with non-Error value', async () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue('rpc string error'),
    };
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).toBe('rpc string error');
  });

  it('returns timeout error when RPC hangs', async () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      ),
    };
    const result = await createStellarRpcChecker(() => client, { timeoutMs: 50 }).check();
    expect(result.error).toMatch(/timed out/);
  }, 1000);

  it('returns error for invalid ledger response (non-number sequence)', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<unknown>>().mockResolvedValue({ sequence: 'bad' }),
    } as unknown as StellarRpcClient;
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).toMatch(/invalid ledger/i);
  });

  it('returns error for null ledger response', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
    } as unknown as StellarRpcClient;
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).toMatch(/invalid ledger/i);
  });

  it('returns degraded when latency exceeds threshold', async () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ sequence: 1 }), 80)),
      ),
    };
    const result = await createStellarRpcChecker(() => client, { degradedLatencyMs: 10 }).check();
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBe(true);
  }, 2000);

  it('sanitises connection strings from error messages', async () => {
    const client: StellarRpcClient = {
      getLatestLedger: jest.fn<() => Promise<{ sequence: number }>>().mockRejectedValue(
        new Error('connect ECONNREFUSED redis://admin:secret@rpc-host:8000'),
      ),
    };
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).not.toContain('secret');
  });
});

// ── Redis checker ─────────────────────────────────────────────────────────────

describe('createRedisChecker', () => {
  it('has name "redis"', () => {
    const client: RedisClient = { ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG') };
    expect(createRedisChecker(() => client).name).toBe('redis');
  });

  it('returns healthy when PING returns PONG', async () => {
    const client: RedisClient = { ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG') };
    const result = await createRedisChecker(() => client).check();
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('accepts lowercase pong response', async () => {
    const client: RedisClient = { ping: jest.fn<() => Promise<string>>().mockResolvedValue('pong') };
    const result = await createRedisChecker(() => client).check();
    expect(result.error).toBeUndefined();
  });

  it('returns error when PING returns unexpected response', async () => {
    const client: RedisClient = { ping: jest.fn<() => Promise<string>>().mockResolvedValue('ERROR') };
    const result = await createRedisChecker(() => client).check();
    expect(result.error).toMatch(/unexpected ping response/i);
  });

  it('returns error when PING rejects with Error', async () => {
    const client: RedisClient = {
      ping: jest.fn<() => Promise<string>>().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const result = await createRedisChecker(() => client).check();
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('returns error when PING rejects with non-Error value', async () => {
    const client: RedisClient = {
      ping: jest.fn<() => Promise<string>>().mockRejectedValue('redis string error'),
    };
    const result = await createRedisChecker(() => client).check();
    expect(result.error).toBe('redis string error');
  });

  it('returns timeout error when PING hangs', async () => {
    const client: RedisClient = {
      ping: jest.fn<() => Promise<string>>().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      ),
    };
    const result = await createRedisChecker(() => client, { timeoutMs: 50 }).check();
    expect(result.error).toMatch(/timed out/);
  }, 1000);

  it('returns degraded when latency exceeds threshold', async () => {
    const client: RedisClient = {
      ping: jest.fn<() => Promise<string>>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('PONG'), 80)),
      ),
    };
    const result = await createRedisChecker(() => client, { degradedLatencyMs: 10 }).check();
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBe(true);
  }, 2000);

  it('sanitises redis:// connection strings from error messages', async () => {
    const client: RedisClient = {
      ping: jest.fn<() => Promise<string>>().mockRejectedValue(
        new Error('connect ECONNREFUSED redis://admin:topsecret@redis-host:6379'),
      ),
    };
    const result = await createRedisChecker(() => client).check();
    expect(result.error).not.toContain('topsecret');
    expect(result.error).toContain('[redacted-url]');
  });

  it('does not report degraded when latency is below threshold', async () => {
    const client: RedisClient = { ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG') };
    const result = await createRedisChecker(() => client, { degradedLatencyMs: 60_000 }).check();
    expect(result.degraded).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
