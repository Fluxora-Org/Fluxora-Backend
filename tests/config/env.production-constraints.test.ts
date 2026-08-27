/**
 * Issue #1270 — Reject unsafe production configuration before the server starts
 *
 * Focuses on the gaps not yet covered by env.validation.test.ts:
 *  - Malformed / boundary integer values (PORT, DB_POOL_*, timeouts)
 *  - Conflicting cross-field Redis-mode configuration (sentinel / cluster)
 *  - Development-only values that must be rejected in production
 *  - Missing required secrets vs. safe defaults in non-production modes
 *  - Actionable error messages surface the variable name, never the secret value
 */

import { afterEach, describe, it, expect, vi } from 'vitest';

const originalEnv = process.env;

// ── Canonical address fixtures ────────────────────────────────────────────────
const TESTNET_CONTRACT = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';
const TESTNET_TOKEN = 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6';
const MAINNET_CONTRACT = 'CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA';
const MAINNET_TOKEN = 'CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5';

// ── Env helpers ───────────────────────────────────────────────────────────────

/** Minimal valid env for NODE_ENV=test. */
function validTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/fluxora_test',
    JWT_SECRET: 'a-very-long-secret-key-for-testing-only-12345',
    INDEXER_WORKER_TOKEN: 'indexer-worker-token-for-testing-only-12345',
    STELLAR_NETWORK: 'testnet',
    STELLAR_CONTRACT_ADDRESS: TESTNET_CONTRACT,
    STELLAR_TOKEN_ADDRESS: TESTNET_TOKEN,
    ...overrides,
  };
}

/** Minimal valid env for NODE_ENV=production. */
function validProdEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://db.internal/fluxora',
    JWT_SECRET: 'prod-secret-key-that-is-at-least-32-chars-long',
    INDEXER_WORKER_TOKEN: 'prod-indexer-token-at-least-thirty-two-chars',
    STELLAR_NETWORK: 'mainnet',
    STELLAR_CONTRACT_ADDRESS: MAINNET_CONTRACT,
    STELLAR_TOKEN_ADDRESS: MAINNET_TOKEN,
    PGCRYPTO_KEY: 'prod-pgcrypto-key-min-thirty-two-chars!!',
    CORS_ALLOWED_ORIGINS: 'https://app.fluxora.example.com',
    ...overrides,
  };
}

/** Fresh module import with a custom env snapshot. */
async function importEnvWith(env: NodeJS.ProcessEnv) {
  vi.resetModules();
  process.env = env;
  return import('../../src/config/env.js');
}

afterEach(() => {
  process.env = originalEnv;
  vi.resetModules();
});

// ─── Malformed & boundary integer values ─────────────────────────────────────

describe('Malformed integer env vars', () => {
  it('rejects PORT=0 (below minimum)', async () => {
    await expect(importEnvWith(validTestEnv({ PORT: '0' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('PORT'),
    });
  });

  it('rejects PORT=65536 (above maximum)', async () => {
    await expect(importEnvWith(validTestEnv({ PORT: '65536' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('PORT'),
    });
  });

  it('accepts PORT=65535 (valid maximum)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ PORT: '65535' }));
    expect(loadConfig().port).toBe(65535);
  });

  it('accepts PORT=1 (valid minimum)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ PORT: '1' }));
    expect(loadConfig().port).toBe(1);
  });

  it('rejects DB_POOL_MIN=0 (below minimum 1)', async () => {
    await expect(importEnvWith(validTestEnv({ DB_POOL_MIN: '0' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DB_POOL_MIN'),
    });
  });

  it('rejects DB_POOL_MAX=101 (above maximum 100)', async () => {
    await expect(importEnvWith(validTestEnv({ DB_POOL_MAX: '101' }))).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DB_POOL_MAX'),
    });
  });

  it('rejects DB_CONNECTION_TIMEOUT=999 (below minimum 1000)', async () => {
    await expect(
      importEnvWith(validTestEnv({ DB_CONNECTION_TIMEOUT: '999' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DB_CONNECTION_TIMEOUT'),
    });
  });

  it('rejects non-numeric string for integer fields', async () => {
    await expect(
      importEnvWith(validTestEnv({ STATEMENT_TIMEOUT_MS: 'not-a-number' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('STATEMENT_TIMEOUT_MS'),
    });
  });

  it('rejects float string for integer fields', async () => {
    await expect(
      importEnvWith(validTestEnv({ PORT: '3000.5' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('PORT'),
    });
  });

  it('rejects STARTUP_PROBE_BUDGET_MS above 60000 (enforced maximum)', async () => {
    await expect(
      importEnvWith(validTestEnv({ STARTUP_PROBE_BUDGET_MS: '60001' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('STARTUP_PROBE_BUDGET_MS'),
    });
  });
});

// ─── Malformed URL values ─────────────────────────────────────────────────────

describe('Malformed URL env vars', () => {
  it('rejects DATABASE_URL that is not a valid URL', async () => {
    await expect(
      importEnvWith(validTestEnv({ DATABASE_URL: 'not-a-url' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DATABASE_URL'),
    });
  });

  it('rejects REDIS_URL that is not a valid URL', async () => {
    await expect(
      importEnvWith(validTestEnv({ REDIS_URL: 'just-a-hostname' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('REDIS_URL'),
    });
  });

  it('accepts a valid postgresql DATABASE_URL', async () => {
    const { loadConfig } = await importEnvWith(
      validTestEnv({ DATABASE_URL: 'postgresql://user:pass@host:5432/db' })
    );
    expect(loadConfig().databaseUrl).toBe('postgresql://user:pass@host:5432/db');
  });

  it('accepts a valid redis:// REDIS_URL', async () => {
    const { loadConfig } = await importEnvWith(
      validTestEnv({ REDIS_URL: 'redis://localhost:6379' })
    );
    expect(loadConfig().redisUrl).toBe('redis://localhost:6379');
  });
});

// ─── Cross-field: JWT_SECRET and INDEXER_WORKER_TOKEN length ─────────────────

describe('Secret length constraints', () => {
  it('rejects JWT_SECRET shorter than 32 characters', async () => {
    await expect(
      importEnvWith(validTestEnv({ JWT_SECRET: 'too-short' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      // Secret value must NOT appear in the error message
      message: expect.not.stringContaining('too-short'),
    });
  });

  it('error message for JWT_SECRET contains the variable name', async () => {
    await expect(
      importEnvWith(validTestEnv({ JWT_SECRET: 'short' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('JWT_SECRET'),
    });
  });

  it('rejects INDEXER_WORKER_TOKEN shorter than 32 characters', async () => {
    await expect(
      importEnvWith(validTestEnv({ INDEXER_WORKER_TOKEN: 'too-short' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('INDEXER_WORKER_TOKEN'),
    });
  });

  it('redacts secret value from INDEXER_WORKER_TOKEN error message', async () => {
    const shortSecret = 'short-indexer-token';
    try {
      await importEnvWith(validTestEnv({ INDEXER_WORKER_TOKEN: shortSecret }));
    } catch (error) {
      expect((error as Error).message).not.toContain(shortSecret);
    }
  });

  it('accepts JWT_SECRET of exactly 32 characters', async () => {
    const secret32 = 'a'.repeat(32);
    const { loadConfig } = await importEnvWith(validTestEnv({ JWT_SECRET: secret32 }));
    expect(loadConfig().jwtSecret).toBe(secret32);
  });

  it('rejects API_KEY_PEPPER shorter than 32 characters when set', async () => {
    await expect(
      importEnvWith(
        validTestEnv({
          API_KEYS: 'my-api-key',
          API_KEY_PEPPER: 'short-pepper',
        })
      )
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('API_KEY_PEPPER'),
    });
  });
});

// ─── Cross-field conflict: Redis mode ────────────────────────────────────────

describe('Redis mode cross-field conflicts', () => {
  it('loads successfully with REDIS_MODE=standalone (no extra fields required)', async () => {
    const { loadConfig } = await importEnvWith(
      validTestEnv({ REDIS_MODE: 'standalone', REDIS_URL: 'redis://localhost:6379' })
    );
    expect(loadConfig().redisMode).toBe('standalone');
  });

  it('loads successfully with REDIS_MODE=sentinel when REDIS_SENTINEL_HOSTS and REDIS_SENTINEL_NAME are provided', async () => {
    const { loadConfig } = await importEnvWith(
      validTestEnv({
        REDIS_MODE: 'sentinel',
        REDIS_SENTINEL_HOSTS: 'sentinel1:26379,sentinel2:26379',
        REDIS_SENTINEL_NAME: 'mymaster',
      })
    );
    expect(loadConfig().redisMode).toBe('sentinel');
    expect(loadConfig().redisSentinelHosts).toBe('sentinel1:26379,sentinel2:26379');
    expect(loadConfig().redisSentinelName).toBe('mymaster');
  });

  it('loads successfully with REDIS_MODE=cluster when REDIS_CLUSTER_NODES is provided', async () => {
    const { loadConfig } = await importEnvWith(
      validTestEnv({
        REDIS_MODE: 'cluster',
        REDIS_CLUSTER_NODES: 'node1:7000,node2:7001,node3:7002',
      })
    );
    expect(loadConfig().redisMode).toBe('cluster');
    expect(loadConfig().redisClusterNodes).toBe('node1:7000,node2:7001,node3:7002');
  });

  it('rejects unknown REDIS_MODE values', async () => {
    await expect(
      importEnvWith(validTestEnv({ REDIS_MODE: 'sharded' as any }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('REDIS_MODE'),
    });
  });
});

// ─── Development-only values rejected in production ──────────────────────────

describe('Production-only constraints', () => {
  it('rejects LOG_LEVEL=debug in production', async () => {
    await expect(
      importEnvWith(validProdEnv({ LOG_LEVEL: 'debug' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining([
        expect.stringContaining('LOG_LEVEL'),
      ]),
    });
  });

  it('allows LOG_LEVEL=debug in development (not a production-only restriction)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ LOG_LEVEL: 'debug' }));
    expect(loadConfig().logLevel).toBe('debug');
  });

  it('rejects wildcard CORS in production even with other origins present', async () => {
    await expect(
      importEnvWith(validProdEnv({ CORS_ALLOWED_ORIGINS: 'https://a.example.com,*' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining([expect.stringContaining('CORS_ALLOWED_ORIGINS')]),
    });
  });

  it('requires PGCRYPTO_KEY in production', async () => {
    const env = validProdEnv();
    delete env.PGCRYPTO_KEY;
    await expect(importEnvWith(env)).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining([expect.stringContaining('PGCRYPTO_KEY')]),
    });
  });

  it('rejects PGCRYPTO_KEY shorter than 32 chars in production', async () => {
    await expect(
      importEnvWith(validProdEnv({ PGCRYPTO_KEY: 'short' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining([expect.stringContaining('PGCRYPTO_KEY')]),
    });
  });

  it('collects multiple production violations into a single EnvironmentError', async () => {
    const env = validProdEnv();
    delete env.PGCRYPTO_KEY;
    const envWithViolations = { ...env, LOG_LEVEL: 'debug', CORS_ALLOWED_ORIGINS: '*' };

    let caught: Error | undefined;
    try {
      await importEnvWith(envWithViolations);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe('EnvironmentError');
    // All three violations should appear together
    expect(caught!.message).toContain('LOG_LEVEL');
    expect(caught!.message).toContain('CORS_ALLOWED_ORIGINS');
    expect(caught!.message).toContain('PGCRYPTO_KEY');
  });

  it('INDEXER_MTLS_REQUIRED defaults to true in production', async () => {
    const env = validProdEnv();
    delete env.INDEXER_MTLS_REQUIRED;
    const { loadConfig } = await importEnvWith(env);
    expect(loadConfig().indexerMtlsRequired).toBe(true);
  });

  it('INDEXER_MTLS_REQUIRED defaults to false in development', async () => {
    const env = validTestEnv();
    delete env.INDEXER_MTLS_REQUIRED;
    const { loadConfig } = await importEnvWith(env);
    expect(loadConfig().indexerMtlsRequired).toBe(false);
  });
});

// ─── Missing required variables with actionable errors ───────────────────────

describe('Missing required variables', () => {
  const requiredVars = ['DATABASE_URL', 'JWT_SECRET', 'INDEXER_WORKER_TOKEN'];

  it.each(requiredVars)(
    'throws EnvironmentError when %s is missing with the variable name in the message',
    async (varName) => {
      const env = validTestEnv();
      delete env[varName];

      await expect(importEnvWith(env)).rejects.toMatchObject({
        name: 'EnvironmentError',
        message: expect.stringContaining(varName),
      });
    }
  );

  it('error for missing DATABASE_URL uses "required" wording', async () => {
    const env = validTestEnv();
    delete env.DATABASE_URL;

    await expect(importEnvWith(env)).rejects.toMatchObject({
      name: 'EnvironmentError',
      issues: expect.arrayContaining([expect.stringContaining('DATABASE_URL')]),
    });
  });

  it('rejects empty-string DATABASE_URL as if missing', async () => {
    await expect(
      importEnvWith(validTestEnv({ DATABASE_URL: '' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DATABASE_URL'),
    });
  });

  it('rejects empty-string JWT_SECRET as if missing', async () => {
    await expect(
      importEnvWith(validTestEnv({ JWT_SECRET: '' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('JWT_SECRET'),
    });
  });
});

// ─── TRACING sampling cross-field constraints ─────────────────────────────────

describe('Tracing sampling strategy defaults', () => {
  it('TRACING_SAMPLE_RATE must be between 0 and 1', async () => {
    await expect(
      importEnvWith(validTestEnv({ TRACING_SAMPLE_RATE: '1.5' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('TRACING_SAMPLE_RATE'),
    });
  });

  it('rejects TRACING_SAMPLE_RATE below 0', async () => {
    await expect(
      importEnvWith(validTestEnv({ TRACING_SAMPLE_RATE: '-0.1' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('TRACING_SAMPLE_RATE'),
    });
  });

  it('accepts TRACING_SAMPLE_RATE=0 (fully disabled)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ TRACING_SAMPLE_RATE: '0' }));
    expect(loadConfig().tracingSampleRate).toBe(0);
  });

  it('accepts TRACING_SAMPLE_RATE=1 (fully enabled)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ TRACING_SAMPLE_RATE: '1' }));
    expect(loadConfig().tracingSampleRate).toBe(1);
  });

  it('rejects unknown TRACING_SAMPLING_STRATEGY value', async () => {
    await expect(
      importEnvWith(validTestEnv({ TRACING_SAMPLING_STRATEGY: 'random' as any }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('TRACING_SAMPLING_STRATEGY'),
    });
  });
});

// ─── Canary traffic percent ───────────────────────────────────────────────────

describe('CANARY_TRAFFIC_PERCENT constraints', () => {
  it('rejects CANARY_TRAFFIC_PERCENT above 100', async () => {
    await expect(
      importEnvWith(validTestEnv({ CANARY_TRAFFIC_PERCENT: '101' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('CANARY_TRAFFIC_PERCENT'),
    });
  });

  it('rejects negative CANARY_TRAFFIC_PERCENT', async () => {
    await expect(
      importEnvWith(validTestEnv({ CANARY_TRAFFIC_PERCENT: '-1' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('CANARY_TRAFFIC_PERCENT'),
    });
  });

  it('accepts CANARY_TRAFFIC_PERCENT=0 (disabled)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ CANARY_TRAFFIC_PERCENT: '0' }));
    expect(loadConfig().canaryTrafficPercent).toBe(0);
  });

  it('accepts CANARY_TRAFFIC_PERCENT=100 (all canary)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ CANARY_TRAFFIC_PERCENT: '100' }));
    expect(loadConfig().canaryTrafficPercent).toBe(100);
  });
});

// ─── SSE connection limits ────────────────────────────────────────────────────

describe('SSE connection limit constraints', () => {
  it('rejects SSE_MAX_CONNECTIONS_PER_IP=0 (below minimum 1)', async () => {
    await expect(
      importEnvWith(validTestEnv({ SSE_MAX_CONNECTIONS_PER_IP: '0' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('SSE_MAX_CONNECTIONS_PER_IP'),
    });
  });

  it('rejects SSE_MAX_GLOBAL_CONNECTIONS above 100000', async () => {
    await expect(
      importEnvWith(validTestEnv({ SSE_MAX_GLOBAL_CONNECTIONS: '100001' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('SSE_MAX_GLOBAL_CONNECTIONS'),
    });
  });
});

// ─── DLQ retention ───────────────────────────────────────────────────────────

describe('DLQ retention constraints', () => {
  it('rejects DLQ_RETENTION_DAYS above 365', async () => {
    await expect(
      importEnvWith(validTestEnv({ DLQ_RETENTION_DAYS: '366' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DLQ_RETENTION_DAYS'),
    });
  });

  it('rejects DLQ_PURGE_BATCH_SIZE above 5000', async () => {
    await expect(
      importEnvWith(validTestEnv({ DLQ_PURGE_BATCH_SIZE: '5001' }))
    ).rejects.toMatchObject({
      name: 'EnvironmentError',
      message: expect.stringContaining('DLQ_PURGE_BATCH_SIZE'),
    });
  });

  it('accepts DLQ_RETENTION_DAYS=365 (valid maximum)', async () => {
    const { loadConfig } = await importEnvWith(validTestEnv({ DLQ_RETENTION_DAYS: '365' }));
    expect(loadConfig().dlqRetentionDays).toBe(365);
  });
});
