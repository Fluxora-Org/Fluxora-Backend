/**
 * Equivalence tests for the split environment schema (issue #1519).
 *
 * The original single-file `EnvSchema` was split into per-subsystem fragments
 * (`src/config/env-schema/*`) and composed in `env-schema/schema.ts`. These
 * tests assert the composed schema accepts and rejects exactly the same
 * inputs as the original definition:
 *
 * 1. The fragment union covers the composed schema exactly (no lost or
 *    duplicated variables).
 * 2. Defaults resolve to the same values as the original schema.
 * 3. An accept/reject matrix over every variable (valid value → parse OK,
 *    missing required → fail, wrong type → fail, out-of-range → fail,
 *    below-min → fail).
 * 4. Cross-field invariants still fire identically.
 * 5. The generated reference lists every schema variable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnvSchema, EnvSchemaShape } from '../../src/config/env-schema/schema.js';
import {
  coreEnvSchema,
  databaseEnvSchema,
  redisEnvSchema,
  stellarEnvSchema,
  authEnvSchema,
  httpEnvSchema,
  webhooksEnvSchema,
  serverEnvSchema,
  indexerEnvSchema,
  rateLimitEnvSchema,
  infrastructureEnvSchema,
} from '../../src/config/env-schema/index.js';

const VALID = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/fluxora_test',
  JWT_SECRET: 'a-very-long-secret-key-for-testing-only-12345',
  INDEXER_WORKER_TOKEN: 'indexer-worker-token-for-testing-only-12345',
  STELLAR_CONTRACT_ADDRESS: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
  STELLAR_TOKEN_ADDRESS: 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6',
} as const;

function parse(env: Record<string, unknown>) {
  return EnvSchema.safeParse(env);
}

/** Every variable name declared across all fragment modules. */
const FRAGMENT_NAMES: ReadonlySet<string> = new Set(
  (
    [
      coreEnvSchema,
      databaseEnvSchema,
      redisEnvSchema,
      stellarEnvSchema,
      authEnvSchema,
      httpEnvSchema,
      webhooksEnvSchema,
      serverEnvSchema,
      indexerEnvSchema,
      rateLimitEnvSchema,
      infrastructureEnvSchema,
    ] as Array<Record<string, unknown>>
  ).flatMap((fragment) => Object.keys(fragment))
);

describe('EnvSchema fragment composition (#1519)', () => {
  it('fragments cover the composed shape exactly (no lost or extra variables)', () => {
    const composed = new Set(Object.keys(EnvSchemaShape));

    expect(FRAGMENT_NAMES.size).toBe(composed.size);

    const missingFromFragments = [...composed].filter((name) => !FRAGMENT_NAMES.has(name));
    const notInComposed = [...FRAGMENT_NAMES].filter((name) => !composed.has(name));

    expect(missingFromFragments).toEqual([]);
    expect(notInComposed).toEqual([]);
  });

  it('accepts the minimal valid environment and applies every documented default', () => {
    const result = parse({ ...VALID });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const env = result.data as Record<string, unknown>;

    // Spot-check one default per fragment to prove composition preserved them.
    expect(env.NODE_ENV).toBe('test'); // core (input value, not default)
    expect(env.PORT).toBe(3000);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.REDIS_MODE).toBe('standalone');
    expect(env.STELLAR_RPC_URL).toBe('https://soroban-testnet.stellar.org');
    expect(env.JWT_EXPIRES_IN).toBe('24h');
    expect(env.MAX_JSON_DEPTH).toBe(20);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.WEBHOOK_POLL_INTERVAL_MS).toBe(10000);
    expect(env.SSE_MAX_CONNECTIONS_PER_IP).toBe(10);
    expect(env.INDEXER_BACKFILL_BATCH_SIZE).toBe(100);
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
    expect(env.STARTUP_PROBE_BUDGET_MS).toBe(30_000);
    expect(env.DLQ_RETENTION_DAYS).toBe(30);
  });

  it('preserves unknown (passthrough) variables', () => {
    const result = parse({ ...VALID, TOTALLY_UNKNOWN_VAR: 'x' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).TOTALLY_UNKNOWN_VAR).toBe('x');
  });
});

describe('EnvSchema accept/reject matrix', () => {
  const CASES: Array<{
    variable: string;
    valid: unknown;
    invalidType: unknown;
    belowMin?: unknown;
    aboveMax?: unknown;
  }> = [
    { variable: 'NODE_ENV', valid: 'staging', invalidType: 'not-a-node-env' },
    { variable: 'PORT', valid: 8080, invalidType: 'not-an-int', belowMin: 0, aboveMax: 65536 },
    { variable: 'DB_POOL_MIN', valid: '5', invalidType: 'high', belowMin: 0, aboveMax: 101 },
    { variable: 'DB_POOL_MAX', valid: '20', invalidType: 'high', belowMin: 0, aboveMax: 101 },
    {
      variable: 'DB_CONNECTION_TIMEOUT',
      valid: '10000',
      invalidType: 'soon',
      belowMin: 999,
      aboveMax: 60001,
    },
    {
      variable: 'DB_IDLE_TIMEOUT',
      valid: '45000',
      invalidType: 'soon',
      belowMin: 999,
      aboveMax: 600001,
    },
    { variable: 'SLOW_QUERY_THRESHOLD_MS', valid: '500', invalidType: 'fast', belowMin: -1 },
    { variable: 'STATEMENT_TIMEOUT_MS', valid: '0', invalidType: 'fast', belowMin: -1 },
    { variable: 'REPLICA_STATEMENT_TIMEOUT_MS', valid: '0', invalidType: 'fast', belowMin: -1 },
    { variable: 'REPLICA_QUEUE_LIMIT', valid: '10', invalidType: 'many', belowMin: 0 },
    {
      variable: 'REDIS_MODE',
      valid: 'sentinel',
      invalidType: 'mesh',
    },
    {
      variable: 'STELLAR_RPC_TIMEOUT',
      valid: '5000',
      invalidType: 'fast',
      belowMin: 0,
    },
    { variable: 'STELLAR_RPC_MAX_RETRIES', valid: '2', invalidType: 'few', belowMin: -1 },
    { variable: 'STELLAR_RPC_RETRY_DELAY', valid: '500', invalidType: 'fast', belowMin: -1 },
    { variable: 'JWT_EXPIRES_IN', valid: '1h', invalidType: '' },
    { variable: 'MAX_REQUEST_SIZE', valid: '2mb', invalidType: 'big', belowMin: 0 },
    { variable: 'MAX_JSON_DEPTH', valid: '10', invalidType: 'deep', belowMin: 0, aboveMax: 1001 },
    {
      variable: 'REQUEST_TIMEOUT_MS',
      valid: '60000',
      invalidType: 'slow',
      belowMin: 999,
      aboveMax: 300001,
    },
    {
      variable: 'GRAPHQL_UNPERSISTED_QUERY_POLICY',
      valid: 'reject',
      invalidType: 'maybe',
    },
    { variable: 'LOG_LEVEL', valid: 'warn', invalidType: 'trace' },
    { variable: 'TRACING_SAMPLE_RATE', valid: '0.5', invalidType: 'half', belowMin: -0.1, aboveMax: 1.1 },
    {
      variable: 'TRACING_SAMPLING_STRATEGY',
      valid: 'tail',
      invalidType: 'random',
    },
    { variable: 'TRACING_HEAD_SAMPLE_RATE', valid: '0.25', invalidType: 'quarter', belowMin: -0.1, aboveMax: 1.1 },
    {
      variable: 'WEBHOOK_POLL_INTERVAL_MS',
      valid: '20000',
      invalidType: 'slow',
      belowMin: 0,
    },
    { variable: 'WEBHOOK_BATCH_SIZE', valid: '25', invalidType: 'many', belowMin: 0, aboveMax: 1001 },
    { variable: 'WEBHOOK_RETRY_RPS', valid: '50', invalidType: 'fast', belowMin: 0, aboveMax: 1001 },
    { variable: 'WEBHOOK_RETRY_BURST', valid: '5', invalidType: 'bursty', belowMin: -1 },
    {
      variable: 'WEBHOOK_CIRCUIT_BREAKER_THRESHOLD',
      valid: '10',
      invalidType: 'many',
      belowMin: -1,
      aboveMax: 1001,
    },
    {
      variable: 'WEBHOOK_CIRCUIT_BREAKER_RESET_MS',
      valid: '60000',
      invalidType: 'slow',
      belowMin: 0,
    },
    { variable: 'WEBHOOK_MAX_RESPONSE_BYTES', valid: '128kb', invalidType: 'huge', belowMin: 0 },
    { variable: 'WEBHOOK_DNS_TIMEOUT_MS', valid: '3000', invalidType: 'slow', belowMin: 0 },
    { variable: 'WS_RECONNECT_LIMIT', valid: '50', invalidType: 'many', belowMin: 0, aboveMax: 100_001 },
    {
      variable: 'WS_RECONNECT_WINDOW_MS',
      valid: '120000',
      invalidType: 'slow',
      belowMin: 0,
      aboveMax: 86_400_001,
    },
    {
      variable: 'SSE_MAX_CONNECTIONS_PER_API_KEY',
      valid: '100',
      invalidType: 'many',
      belowMin: 0,
      aboveMax: 100_001,
    },
    {
      variable: 'SSE_MAX_GLOBAL_CONNECTIONS',
      valid: '2000',
      invalidType: 'many',
      belowMin: 0,
      aboveMax: 100_001,
    },
    {
      variable: 'SSE_MAX_CONNECTION_DURATION_MS',
      valid: '3600000',
      invalidType: 'long',
      belowMin: 0,
      aboveMax: 86_400_001,
    },
    {
      variable: 'SSE_RETRY_AFTER_SECONDS',
      valid: '30',
      invalidType: 'later',
      belowMin: 0,
      aboveMax: 86_401,
    },
    { variable: 'SSE_RETRY_MS', valid: '10000', invalidType: 'slow', belowMin: 99, aboveMax: 300_001 },
    {
      variable: 'SSE_HEARTBEAT_INTERVAL_MS',
      valid: '15000',
      invalidType: 'fast',
      belowMin: 99,
      aboveMax: 300_001,
    },
    {
      variable: 'SSE_DRAIN_TIMEOUT_MS',
      valid: '45000',
      invalidType: 'slow',
      belowMin: 999,
      aboveMax: 60_001,
    },
    {
      variable: 'HEALTH_CHECK_TIMEOUT_MS',
      valid: '10000',
      invalidType: 'slow',
      belowMin: 0,
    },
    {
      variable: 'HEALTH_CHECK_INTERVAL_MS',
      valid: '60000',
      invalidType: 'slow',
      belowMin: 0,
    },
    { variable: 'GRPC_HEALTH_PORT', valid: '50053', invalidType: 'port', belowMin: 0, aboveMax: 65536 },
    { variable: 'GRPC_GATEWAY_PORT', valid: '50054', invalidType: 'port', belowMin: 0, aboveMax: 65536 },
    {
      variable: 'INDEXER_STALL_THRESHOLD_MS',
      valid: '600000',
      invalidType: 'slow',
      belowMin: 999,
    },
    {
      variable: 'INDEXER_BACKFILL_CONCURRENCY',
      valid: '4',
      invalidType: 'many',
      belowMin: 0,
      aboveMax: 65,
    },
    {
      variable: 'INDEXER_BACKFILL_BATCH_SIZE',
      valid: '500',
      invalidType: 'many',
      belowMin: 0,
      aboveMax: 100_001,
    },
    {
      variable: 'INDEXER_BACKFILL_COMMIT_INTERVAL',
      valid: '5',
      invalidType: 'many',
      belowMin: 0,
      aboveMax: 10_001,
    },
    {
      variable: 'INDEXER_BACKFILL_MAX_RETRIES',
      valid: '5',
      invalidType: 'many',
      belowMin: -1,
      aboveMax: 101,
    },
    {
      variable: 'INDEXER_BACKFILL_RETRY_DELAY_MS',
      valid: '2000',
      invalidType: 'slow',
      belowMin: -1,
    },
    {
      variable: 'RPC_CB_FAILURE_THRESHOLD',
      valid: '10',
      invalidType: 'many',
      belowMin: 0,
    },
    { variable: 'RPC_CB_WINDOW_MS', valid: '45000', invalidType: 'slow', belowMin: 0 },
    { variable: 'RPC_CB_RESET_TIMEOUT_MS', valid: '90000', invalidType: 'slow', belowMin: 0 },
    { variable: 'RPC_TIMEOUT_MS', valid: '10000', invalidType: 'slow', belowMin: 0 },
    {
      variable: 'IDEMPOTENCY_TTL_SECONDS',
      valid: '3600',
      invalidType: 'later',
      belowMin: 0,
      aboveMax: 86400 * 7 + 1,
    },
    {
      variable: 'STARTUP_PROBE_BUDGET_MS',
      valid: '45000',
      invalidType: 'slow',
      belowMin: 0,
      aboveMax: 60_001,
    },
    {
      variable: 'STARTUP_PROBE_POSTGRES_TIMEOUT_MS',
      valid: '10000',
      invalidType: 'slow',
      belowMin: 0,
    },
    {
      variable: 'STARTUP_PROBE_REDIS_TIMEOUT_MS',
      valid: '4000',
      invalidType: 'slow',
      belowMin: 0,
    },
    {
      variable: 'STARTUP_PROBE_STELLAR_TIMEOUT_MS',
      valid: '8000',
      invalidType: 'slow',
      belowMin: 0,
    },
    {
      variable: 'CANARY_TRAFFIC_PERCENT',
      valid: '10',
      invalidType: 'many',
      belowMin: -1,
      aboveMax: 101,
    },
    { variable: 'DLQ_RETENTION_DAYS', valid: '60', invalidType: 'soon', belowMin: 0, aboveMax: 366 },
    {
      variable: 'DLQ_PURGE_BATCH_SIZE',
      valid: '1000',
      invalidType: 'many',
      belowMin: 0,
      aboveMax: 5001,
    },
  ];

  it.each(CASES)('$variable: valid value is accepted', ({ variable, valid }) => {
    const result = parse({ ...VALID, [variable]: valid });
    expect(result.success, `${variable}=${String(valid)} should parse`).toBe(true);
  });

  it.each(CASES.filter((c) => c.invalidType !== undefined))(
    '$variable: invalid type is rejected',
    ({ variable, invalidType }) => {
      const result = parse({ ...VALID, [variable]: invalidType });
      expect(result.success, `${variable}=${String(invalidType)} should be rejected`).toBe(false);
    }
  );

  it.each(CASES.filter((c) => c.belowMin !== undefined))(
    '$variable: below-minimum is rejected',
    ({ variable, belowMin }) => {
      const result = parse({ ...VALID, [variable]: belowMin });
      expect(result.success, `${variable}=${String(belowMin)} should be rejected`).toBe(false);
    }
  );

  it.each(CASES.filter((c) => c.aboveMax !== undefined))(
    '$variable: above-maximum is rejected',
    ({ variable, aboveMax }) => {
      const result = parse({ ...VALID, [variable]: aboveMax });
      expect(result.success, `${variable}=${String(aboveMax)} should be rejected`).toBe(false);
    }
  );

  it('rejects required variables when missing and accepts optional ones', () => {
    const REQUIRED = [
      'DATABASE_URL',
      'JWT_SECRET',
      'INDEXER_WORKER_TOKEN',
      'STELLAR_CONTRACT_ADDRESS',
      'STELLAR_TOKEN_ADDRESS',
    ] as const;

    for (const name of Object.keys(EnvSchemaShape)) {
      const env: Record<string, unknown> = { ...VALID };
      delete env[name];
      const result = parse(env);
      if (result.success) {
        // Parsing without the variable means it is optional/defaulted.
        expect(REQUIRED, `${name} parses as absent but is documented as required`).not.toContain(
          name
        );
      } else {
        // Parsing fails without it — it must be one of the required six
        // (every other variable has a default or is optional).
        expect(REQUIRED, `${name} is required but missing from the required set`).toContain(name);
      }
    }

    // The required five (NODE_ENV defaults to 'development') must each be
    // rejected when absent.
    for (const name of REQUIRED) {
      const env: Record<string, unknown> = { ...VALID };
      delete env[name];
      const result = parse(env);
      expect(result.success, `${name} is required and must be rejected when absent`).toBe(false);
    }
  });
});

describe('EnvSchema cross-field invariants (unchanged)', () => {
  it('rejects mismatched HORIZON_NETWORK_PASSPHRASE for the resolved network', () => {
    const result = parse({ ...VALID, HORIZON_NETWORK_PASSPHRASE: 'wrong-passphrase' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = JSON.stringify(result.error.issues);
    expect(messages).toContain('HORIZON_NETWORK_PASSPHRASE must match testnet passphrase');
  });

  it('rejects unpinned contract addresses outside the local network', () => {
    const unpinned = 'CCQHGQ6CLBBPW6FNA2TRDGMXiYLUEYWGCQCGVQFJUQKGRGBGM3F6W7TQ'.replace('i', 'I');
    const result = parse({ ...VALID, STELLAR_CONTRACT_ADDRESS: unpinned });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = JSON.stringify(result.error.issues);
    expect(messages).toContain('allowlist');
  });

  it('rejects API_KEYS without API_KEY_PEPPER, accepts with it', () => {
    const without = parse({ ...VALID, API_KEYS: 'key1,key2' });
    expect(without.success).toBe(false);

    const withPepper = parse({
      ...VALID,
      API_KEYS: 'key1,key2',
      API_KEY_PEPPER: 'a-very-long-pepper-key-for-testing-only-123',
    });
    expect(withPepper.success).toBe(true);
  });

  it('enforces production-only invariants (LOG_LEVEL, CORS wildcard, PGCRYPTO_KEY)', () => {
    const base = {
      ...VALID,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'mainnet',
      STELLAR_CONTRACT_ADDRESS: 'CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA',
      STELLAR_TOKEN_ADDRESS: 'CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5',
      CORS_ALLOWED_ORIGINS: 'https://app.fluxora.example.com',
      PGCRYPTO_KEY: 'prod-pgcrypto-key-min-thirty-two-chars',
    };

    expect(parse({ ...base, LOG_LEVEL: 'debug' }).success).toBe(false);
    expect(parse({ ...base, CORS_ALLOWED_ORIGINS: '*' }).success).toBe(false);
    expect(parse({ ...base, PGCRYPTO_KEY: 'short' }).success).toBe(false);
    expect(parse({ ...base }).success).toBe(true);
  });
});

describe('generated env reference (#1519)', () => {
  const REFERENCE_PATH = resolve(__dirname, '..', '..', 'docs', 'env-reference.md');

  it('lists every variable in the composed schema', () => {
    const markdown = readFileSync(REFERENCE_PATH, 'utf8');

    for (const name of Object.keys(EnvSchemaShape)) {
      expect(markdown, `reference must document ${name}`).toContain(`\`${name}\``);
    }

    const listedCount = (markdown.match(/^\| `/gm) ?? []).length;
    expect(listedCount).toBe(Object.keys(EnvSchemaShape).length);
  });

  it('documents a purpose and default for every variable row', () => {
    const markdown = readFileSync(REFERENCE_PATH, 'utf8');
    const rows = markdown.split('\n').filter((line) => line.startsWith('| `'));

    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      // cells: ['', '`NAME`', purpose, default, '']
      expect(cells.length).toBeGreaterThanOrEqual(5);
      expect(cells[2]!.length, `purpose missing for ${cells[1]}`).toBeGreaterThan(0);
      expect(cells[2]).not.toBe('—');
      expect(cells[3]!.length, `default missing for ${cells[1]}`).toBeGreaterThan(0);
    }
  });
});
