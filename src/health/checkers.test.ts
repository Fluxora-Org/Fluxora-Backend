import { describe, it, expect, jest } from '@jest/globals';
import { createPostgresChecker, createStellarRpcChecker } from './checkers';
import type { PostgresClient, StellarRpcClient } from './checkers';

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

  it('returns error for invalid ledger response', async () => {
    const client = {
      getLatestLedger: jest.fn<() => Promise<unknown>>().mockResolvedValue({ sequence: 'bad' }),
    } as unknown as StellarRpcClient;
    const result = await createStellarRpcChecker(() => client).check();
    expect(result.error).toMatch(/invalid ledger/i);
  });
});
