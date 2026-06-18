import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = process.env;

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/fluxora_test',
    JWT_SECRET: 'a-very-long-secret-key-for-testing-only-12345',
    INDEXER_WORKER_TOKEN: 'indexer-worker-token-for-testing-only-12345',
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
});
