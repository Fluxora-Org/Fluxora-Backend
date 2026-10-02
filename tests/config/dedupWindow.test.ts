/**
 * DEDUP_WINDOW_SECONDS schema tests (issue #1433).
 *
 * The deduplication window must be configured through the env schema with a
 * documented default and bounds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = process.env;

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/fluxora_test',
    JWT_SECRET: 'a-very-long-secret-key-for-testing-only-12345',
    INDEXER_WORKER_TOKEN: 'indexer-worker-token-for-testing-only-12345',
    STELLAR_CONTRACT_ADDRESS: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
    STELLAR_TOKEN_ADDRESS: 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6',
    ...overrides,
  };
}

async function importEnvWith(env: NodeJS.ProcessEnv) {
  vi.resetModules();
  process.env = env;
  return import('../../src/config/env.js');
}

describe('DEDUP_WINDOW_SECONDS', () => {
  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('defaults to 86400 seconds (24h)', async () => {
    const { loadConfig } = await importEnvWith(validEnv());
    expect(loadConfig().dedupWindowSeconds).toBe(86400);
  });

  it('accepts an explicit window', async () => {
    const { loadConfig } = await importEnvWith(validEnv({ DEDUP_WINDOW_SECONDS: '3600' }));
    expect(loadConfig().dedupWindowSeconds).toBe(3600);
  });

  it.each(['0', '-1', '604801', 'abc', '1.5'])('rejects invalid value %s', async (value) => {
    await expect(importEnvWith(validEnv({ DEDUP_WINDOW_SECONDS: value }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DEDUP_WINDOW_SECONDS'),
    });
  });

  it('accepts the 7-day upper bound', async () => {
    const { loadConfig } = await importEnvWith(validEnv({ DEDUP_WINDOW_SECONDS: '604800' }));
    expect(loadConfig().dedupWindowSeconds).toBe(604800);
  });
});
