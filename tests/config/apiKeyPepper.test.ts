import { describe, it, expect, afterEach } from 'vitest';
import { ConfigError, loadConfig, resetConfig } from '../../src/config/env.js';

const originalEnv = { ...process.env };

function restoreEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, originalEnv);
  resetConfig();
}

function setBaseEnv(): void {
  process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
  process.env.JWT_SECRET = 'a'.repeat(32);
  process.env.INDEXER_WORKER_TOKEN = 'b'.repeat(32);
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.STELLAR_CONTRACT_ADDRESS = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';
  process.env.STELLAR_TOKEN_ADDRESS = 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6';
}

describe('API_KEY_PEPPER configuration', () => {
  afterEach(restoreEnv);

  it('rejects too-short API_KEY_PEPPER', () => {
    restoreEnv();
    setBaseEnv();
    process.env.NODE_ENV = 'development';
    process.env.API_KEY_PEPPER = 'short';

    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('requires API_KEY_PEPPER in production', () => {
    restoreEnv();
    setBaseEnv();
    process.env.NODE_ENV = 'production';
    delete process.env.API_KEY_PEPPER;

    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('exposes API_KEY_PEPPER when configured', () => {
    restoreEnv();
    setBaseEnv();
    process.env.NODE_ENV = 'development';
    process.env.API_KEY_PEPPER = 'p'.repeat(32);

    expect(loadConfig().apiKeyPepper).toBe('p'.repeat(32));
  });
});
