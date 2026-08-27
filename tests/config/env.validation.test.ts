import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = process.env;

const MAINNET_CONTRACT = 'CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA';
const MAINNET_TOKEN = 'CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5';

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

function validProdEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://db.internal/fluxora',
    JWT_SECRET: 'prod-secret-key-that-is-at-least-32-chars-long',
    INDEXER_WORKER_TOKEN: 'prod-indexer-token-at-least-thirty-two-chars',
    STELLAR_NETWORK: 'mainnet',
    STELLAR_CONTRACT_ADDRESS: MAINNET_CONTRACT,
    STELLAR_TOKEN_ADDRESS: MAINNET_TOKEN,
    PGCRYPTO_KEY: 'prod-pgcrypto-key-min-thirty-two-chars',
    CORS_ALLOWED_ORIGINS: 'https://app.fluxora.example.com',
    ...overrides,
  };
}

async function importEnvWith(env: NodeJS.ProcessEnv) {
  vi.resetModules();
  process.env = env;
  return import('../../src/config/env.js');
}

describe('EnvSchema startup validation', () => {
  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('loads when all required vars are present', async () => {
    const { loadConfig } = await importEnvWith(validEnv());

    const config = loadConfig();

    expect(config.databaseUrl).toBe('postgresql://localhost/fluxora_test');
    expect(config.jwtSecret).toBe('a-very-long-secret-key-for-testing-only-12345');
    expect(config.indexerWorkerToken).toBe('indexer-worker-token-for-testing-only-12345');
  });

  it('throws EnvironmentError at module load when a required var is missing', async () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    await expect(importEnvWith(env)).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining(['DATABASE_URL: required']),
    });
  });

  it('rejects invalid integer values with a descriptive variable name', async () => {
    await expect(importEnvWith(validEnv({ PORT: 'not-an-integer' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('PORT'),
    });
  });

  it('uses defaults when optional vars are absent', async () => {
    const { loadConfig } = await importEnvWith(validEnv());

    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.redisEnabled).toBe(true);
    expect(config.maxRequestSizeBytes).toBe(1024 * 1024);
    expect(config.webhookPollIntervalMs).toBe(10000);
    // Tracing knobs must resolve to stable defaults so deploys that omit them
    // get deterministic config (not undefined).
    expect(config.tracingEnabled).toBe(false);
    expect(config.tracingSampleRate).toBe(1);
    expect(config.tracingSamplingStrategy).toBe('head');
    expect(config.tracingTailKeepErrors).toBe(true);
    expect(config.tracingOtelEnabled).toBe(false);
    expect(config.tracingLogEvents).toBe(false);
  });

  it('does not include secret values in validation messages', async () => {
    const secretValue = 'short-secret';

    await expect(importEnvWith(validEnv({ JWT_SECRET: secretValue }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('JWT_SECRET'),
    });

    try {
      await importEnvWith(validEnv({ JWT_SECRET: secretValue }));
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretValue);
    }
  });

  it('throws EnvironmentError when API_KEYS is set but API_KEY_PEPPER is missing', async () => {
    const env = validEnv({ API_KEYS: 'key1,key2' });
    delete env.API_KEY_PEPPER;

    await expect(importEnvWith(env)).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining([expect.stringContaining('API_KEY_PEPPER: API_KEY_PEPPER is required when API_KEYS is configured')]),
    });
  });

  it('loads successfully when both API_KEYS and API_KEY_PEPPER are provided', async () => {
    const env = validEnv({ 
      API_KEYS: 'key1,key2',
      API_KEY_PEPPER: 'a-very-long-pepper-key-for-testing-only-123'
    });

    const { loadConfig } = await importEnvWith(env);
    expect(() => loadConfig()).not.toThrow();
  });
});

describe('production env validation', () => {
  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('passes for a fully valid production env', async () => {
    const { loadConfig } = await importEnvWith(validProdEnv());

    const config = loadConfig();
    expect(config.nodeEnv).toBe('production');
    expect(config.stellarNetwork).toBe('mainnet');
    expect(config.logLevel).toBe('info');
  });

  it('fails when LOG_LEVEL is debug in production', async () => {
    await expect(importEnvWith(validProdEnv({ LOG_LEVEL: 'debug' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining(['LOG_LEVEL: LOG_LEVEL must not be "debug" in production']),
    });
  });

  it('fails when CORS_ALLOWED_ORIGINS is a wildcard in production', async () => {
    await expect(importEnvWith(validProdEnv({ CORS_ALLOWED_ORIGINS: '*' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining(['CORS_ALLOWED_ORIGINS: CORS_ALLOWED_ORIGINS must not contain a wildcard "*" origin in production']),
    });
  });

  it('fails when CORS_ALLOWED_ORIGINS contains a wildcard alongside other origins in production', async () => {
    await expect(
      importEnvWith(validProdEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com,*,https://admin.example.com' })),
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining(['CORS_ALLOWED_ORIGINS: CORS_ALLOWED_ORIGINS must not contain a wildcard "*" origin in production']),
    });
  });

  it('passes when CORS_ALLOWED_ORIGINS is explicit origins in production', async () => {
    const { loadConfig } = await importEnvWith(
      validProdEnv({ CORS_ALLOWED_ORIGINS: 'https://app.fluxora.example.com,https://admin.fluxora.example.com' }),
    );
    expect(() => loadConfig()).not.toThrow();
  });

  it('passes when CORS_ALLOWED_ORIGINS is unset in production', async () => {
    const env = validProdEnv();
    delete env.CORS_ALLOWED_ORIGINS;

    const { loadConfig } = await importEnvWith(env);
    expect(() => loadConfig()).not.toThrow();
  });

  it('fails when PGCRYPTO_KEY is missing in production', async () => {
    const env = validProdEnv();
    delete env.PGCRYPTO_KEY;

    await expect(importEnvWith(env)).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining(['PGCRYPTO_KEY: PGCRYPTO_KEY is required in production (minimum 32 characters)']),
    });
  });

  it('fails when PGCRYPTO_KEY is too short in production', async () => {
    await expect(importEnvWith(validProdEnv({ PGCRYPTO_KEY: 'too-short' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining(['PGCRYPTO_KEY: PGCRYPTO_KEY is required in production (minimum 32 characters)']),
    });
  });

  it('fails when multiple production invariants are violated', async () => {
    await expect(
      importEnvWith(
        validProdEnv({
          LOG_LEVEL: 'debug',
          CORS_ALLOWED_ORIGINS: '*',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
    });

    try {
      await importEnvWith(
        validProdEnv({
          LOG_LEVEL: 'debug',
          CORS_ALLOWED_ORIGINS: '*',
        }),
      );
    } catch (error) {
      const e = error as Error;
      expect(e.message).toContain('LOG_LEVEL');
      expect(e.message).toContain('CORS_ALLOWED_ORIGINS');
    }
  });
});
