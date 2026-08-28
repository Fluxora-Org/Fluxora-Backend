import { z } from 'zod';
import { warn } from '../lib/logger.js';
import { type StellarNetwork, STELLAR_NETWORKS, type ContractAddresses } from './stellar.js';
import {
  getPinnedAddressNetwork,
  isValidStellarContractAddress,
  STELLAR_CONTRACT_ALLOWLIST,
  STELLAR_NETWORK_PASSPHRASES,
  type PinnedStellarAddressKind,
  type PinnedStellarNetwork,
} from './stellarContracts.js';
export { STELLAR_NETWORKS, type StellarNetwork, type ContractAddresses } from './stellar.js';
export {
  STELLAR_CONTRACT_ALLOWLIST,
  STELLAR_NETWORK_PASSPHRASES,
  isValidStellarContractAddress,
} from './stellarContracts.js';

type NodeEnv = 'development' | 'staging' | 'production' | 'test';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_ENV_NAMES = new Set([
  'JWT_SECRET',
  'JWT_SECRET_PREVIOUS',
  'INDEXER_WORKER_TOKEN',
  'WEBHOOK_SECRET',
  'WEBHOOK_SECRET_PREVIOUS',
  'PARTNER_API_TOKEN',
  'ADMIN_API_TOKEN',
  'ADMIN_API_KEY',
  'API_KEYS',
  'API_KEY_PEPPER',
  'FLUXORA_WEBHOOK_SECRET',
  'FLUXORA_WEBHOOK_SECRET_PREVIOUS',
]);

function parseInteger(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return value;
  return Number.parseInt(value, 10);
}

function parseBoolean(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}

function parseNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function byteSizeToNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return value;

  const amount = Number.parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  return Math.floor(amount * (multipliers[unit] ?? 1));
}

function urlString(name: string) {
  return z
    .string()
    .min(1, `${name} is required`)
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, `${name} must be a valid URL`);
}

function optionalUrlString(name: string) {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(1, `${name} cannot be empty`)
      .refine((value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      }, `${name} must be a valid URL`)
      .optional()
  );
}

function integerEnv(name: string, min: number, max?: number) {
  const schema = z.preprocess(
    parseInteger,
    z.number().int(`${name} must be an integer`).min(min, `${name} must be at least ${min}`)
  );
  return max === undefined
    ? schema
    : schema.pipe(z.number().max(max, `${name} must be at most ${max}`));
}

function booleanEnv() {
  return z.preprocess(parseBoolean, z.boolean());
}

function optionalString(name: string) {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1, `${name} cannot be empty`).optional()
  );
}

function requiredStellarContractAddress(name: string) {
  return z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .regex(/^C[A-Z2-7]{55}$/, `${name} must be a Stellar contract StrKey beginning with C`)
    .refine(isValidStellarContractAddress, `${name} must be a valid Stellar contract StrKey`);
}

function resolvedStellarNetwork(env: {
  NODE_ENV: NodeEnv;
  STELLAR_NETWORK?: StellarNetwork;
}): StellarNetwork {
  return env.STELLAR_NETWORK ?? (env.NODE_ENV === 'production' ? 'mainnet' : 'testnet');
}

function validatePinnedAddress(
  ctx: z.RefinementCtx,
  network: StellarNetwork,
  kind: PinnedStellarAddressKind,
  path: 'STELLAR_CONTRACT_ADDRESS' | 'STELLAR_TOKEN_ADDRESS',
  address: string
): void {
  if (network === 'local') return;

  const pinnedNetwork = getPinnedAddressNetwork(kind, address);

  if (pinnedNetwork === network) return;

  ctx.addIssue({
    code: 'custom',
    path: [path],
    message:
      pinnedNetwork === null
        ? `${path} is not in the known-good ${network} ${kind} address allowlist`
        : `${path} is pinned for ${pinnedNetwork} but STELLAR_NETWORK resolves to ${network}`,
  });
}

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
    PORT: integerEnv('PORT', 1, 65535).default(3000),

    DATABASE_URL: urlString('DATABASE_URL'),
    DATABASE_REPLICA_URL: optionalUrlString('DATABASE_REPLICA_URL'),
    DB_POOL_MIN: integerEnv('DB_POOL_MIN', 1, 100).default(2),
    DB_POOL_MAX: integerEnv('DB_POOL_MAX', 1, 100).default(10),
    DB_CONNECTION_TIMEOUT: integerEnv('DB_CONNECTION_TIMEOUT', 1000, 60000).default(5000),
    DB_IDLE_TIMEOUT: integerEnv('DB_IDLE_TIMEOUT', 1000, 600000).default(30000),
    SLOW_QUERY_THRESHOLD_MS: integerEnv('SLOW_QUERY_THRESHOLD_MS', 0).default(1000),
    STATEMENT_TIMEOUT_MS: integerEnv('STATEMENT_TIMEOUT_MS', 0).default(5000),
    /** Replica statement timeout in ms. Defaults to STATEMENT_TIMEOUT_MS when absent. 0 = disabled. */
    REPLICA_STATEMENT_TIMEOUT_MS: integerEnv('REPLICA_STATEMENT_TIMEOUT_MS', 0).optional(),
    /** Max requests allowed to queue on the replica pool before fast-failing. */
    REPLICA_QUEUE_LIMIT: integerEnv('REPLICA_QUEUE_LIMIT', 1).default(25),

    REDIS_URL: urlString('REDIS_URL').default('redis://localhost:6379'),
    REDIS_ENABLED: booleanEnv().default(true),
    REDIS_MODE: z.enum(['standalone', 'sentinel', 'cluster']).default('standalone'),
    // Comma-separated list of sentinel nodes: host:port,host:port
    REDIS_SENTINEL_HOSTS: optionalString('REDIS_SENTINEL_HOSTS'),
    // Sentinel master name (required when REDIS_MODE=sentinel)
    REDIS_SENTINEL_NAME: optionalString('REDIS_SENTINEL_NAME'),
    // Comma-separated list of cluster nodes: host:port,host:port
    REDIS_CLUSTER_NODES: optionalString('REDIS_CLUSTER_NODES'),

    STELLAR_NETWORK: z.enum(['testnet', 'mainnet', 'local']).optional(),
    STELLAR_CONTRACT_ADDRESS: requiredStellarContractAddress('STELLAR_CONTRACT_ADDRESS'),
    STELLAR_TOKEN_ADDRESS: requiredStellarContractAddress('STELLAR_TOKEN_ADDRESS'),
    HORIZON_URL: optionalUrlString('HORIZON_URL'),
    HORIZON_NETWORK_PASSPHRASE: optionalString('HORIZON_NETWORK_PASSPHRASE'),
    CONTRACT_ADDRESS_STREAMING: optionalString('CONTRACT_ADDRESS_STREAMING'),
    STELLAR_RPC_URL: urlString('STELLAR_RPC_URL').default('https://soroban-testnet.stellar.org'),
    STELLAR_RPC_TIMEOUT: integerEnv('STELLAR_RPC_TIMEOUT', 1).default(10000),
    STELLAR_RPC_MAX_RETRIES: integerEnv('STELLAR_RPC_MAX_RETRIES', 0).default(3),
    STELLAR_RPC_RETRY_DELAY: integerEnv('STELLAR_RPC_RETRY_DELAY', 0).default(1000),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_SECRET_PREVIOUS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32, 'JWT_SECRET_PREVIOUS must be at least 32 characters').optional()
    ),
    PGCRYPTO_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32, 'PGCRYPTO_KEY must be at least 32 characters').optional()
    ),
    PGCRYPTO_KEY_PREVIOUS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32, 'PGCRYPTO_KEY_PREVIOUS must be at least 32 characters').optional()
    ),
    JWT_EXPIRES_IN: z.string().min(1, 'JWT_EXPIRES_IN cannot be empty').default('24h'),
    API_KEYS: z.string().optional(),
    /**
     * Server-side pepper mixed into every API-key hash. Keeping it out of the
     * database means a leaked `api_keys` table cannot be brute-forced offline.
     * Optional so non-API-key deployments still boot; required at runtime by the
     * hashing helpers, which fail closed when it is absent.
     */
    API_KEY_PEPPER: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32, 'API_KEY_PEPPER must be at least 32 characters').optional()
    ),
    INDEXER_WORKER_TOKEN: z.string().min(32, 'INDEXER_WORKER_TOKEN must be at least 32 characters'),
    ADMIN_API_KEY: optionalString('ADMIN_API_KEY'),

    /** OIDC issuer base URL, e.g. https://accounts.example.com. JWKS is fetched
     *  from `${OIDC_ISSUER_URL}/.well-known/jwks.json`. Unset disables OIDC login. */
    OIDC_ISSUER_URL: optionalUrlString('OIDC_ISSUER_URL'),
    /** Expected `aud` (client_id) claim on OIDC ID tokens. */
    OIDC_AUDIENCE: optionalString('OIDC_AUDIENCE'),

    MAX_REQUEST_SIZE: z
      .preprocess(
        byteSizeToNumber,
        z
          .number()
          .int('MAX_REQUEST_SIZE must resolve to whole bytes')
          .positive('MAX_REQUEST_SIZE must be positive')
      )
      .default(1024 * 1024),
    MAX_JSON_DEPTH: integerEnv('MAX_JSON_DEPTH', 1, 1000).default(20),
    REQUEST_TIMEOUT_MS: integerEnv('REQUEST_TIMEOUT_MS', 1000, 300000).default(30000),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    METRICS_ENABLED: booleanEnv().default(true),
    CORS_ALLOWED_ORIGINS: optionalString('CORS_ALLOWED_ORIGINS'),

    /**
     * Tracing / OpenTelemetry knobs.
     * Present in EnvSchema so `toConfig()` always receives validated defaults
     * rather than `undefined` (which previously made startup config non-deterministic
     * across deploys that omit these vars).
     */
    TRACING_ENABLED: booleanEnv().default(false),
    TRACING_SAMPLE_RATE: z.preprocess(parseNumber, z.number().min(0).max(1)).default(1),
    TRACING_SAMPLING_STRATEGY: z
      .enum(['head', 'tail', 'always', 'never'])
      .default('head'),
    TRACING_HEAD_SAMPLE_RATE: z
      .preprocess(parseNumber, z.number().min(0).max(1))
      .optional(),
    TRACING_TAIL_KEEP_ERRORS: booleanEnv().default(true),
    TRACING_PER_ROUTE_OVERRIDES: optionalString('TRACING_PER_ROUTE_OVERRIDES'),
    TRACING_OTEL_ENABLED: booleanEnv().default(false),
    TRACING_LOG_EVENTS: booleanEnv().default(false),

    WEBHOOK_URL: optionalUrlString('WEBHOOK_URL'),
    WEBHOOK_SECRET: optionalString('WEBHOOK_SECRET'),
    WEBHOOK_SECRET_PREVIOUS: optionalString('WEBHOOK_SECRET_PREVIOUS'),
    FLUXORA_WEBHOOK_SECRET: optionalString('FLUXORA_WEBHOOK_SECRET'),
    FLUXORA_WEBHOOK_SECRET_PREVIOUS: optionalString('FLUXORA_WEBHOOK_SECRET_PREVIOUS'),
    WEBHOOK_POLL_INTERVAL_MS: integerEnv('WEBHOOK_POLL_INTERVAL_MS', 1).default(10000),
    WEBHOOK_BATCH_SIZE: integerEnv('WEBHOOK_BATCH_SIZE', 1, 1000).default(10),
    WEBHOOK_RETRY_RPS: integerEnv('WEBHOOK_RETRY_RPS', 1, 1000).default(10),
    WEBHOOK_RETRY_BURST: integerEnv('WEBHOOK_RETRY_BURST', 0).default(0),
    WEBHOOK_CIRCUIT_BREAKER_THRESHOLD: integerEnv(
      'WEBHOOK_CIRCUIT_BREAKER_THRESHOLD',
      0,
      1000
    ).default(0),
    WEBHOOK_CIRCUIT_BREAKER_RESET_MS: integerEnv('WEBHOOK_CIRCUIT_BREAKER_RESET_MS', 1).default(
      300_000
    ),
    WEBHOOK_ALLOWED_HOSTS: optionalString('WEBHOOK_ALLOWED_HOSTS'),
    WEBHOOK_MAX_RESPONSE_BYTES: z
      .preprocess(
        byteSizeToNumber,
        z
          .number()
          .int('WEBHOOK_MAX_RESPONSE_BYTES must resolve to whole bytes')
          .positive('WEBHOOK_MAX_RESPONSE_BYTES must be positive')
      )
      .default(64 * 1024),
    WEBHOOK_DNS_TIMEOUT_MS: integerEnv('WEBHOOK_DNS_TIMEOUT_MS', 1).default(2000),

    ENABLE_STREAM_VALIDATION: booleanEnv().default(true),
    ENABLE_RATE_LIMIT: booleanEnv().optional(),
    REQUIRE_PARTNER_AUTH: booleanEnv().default(false),
    PARTNER_API_TOKEN: optionalString('PARTNER_API_TOKEN'),
    REQUIRE_ADMIN_AUTH: booleanEnv().default(false),
    ADMIN_API_TOKEN: optionalString('ADMIN_API_TOKEN'),
    WS_AUTH_REQUIRED: booleanEnv().default(false),
    SSE_MAX_CONNECTIONS_PER_IP: integerEnv('SSE_MAX_CONNECTIONS_PER_IP', 1, 100_000).default(10),
    SSE_MAX_CONNECTIONS_PER_API_KEY: integerEnv(
      'SSE_MAX_CONNECTIONS_PER_API_KEY',
      1,
      100_000
    ).default(50),
    SSE_MAX_GLOBAL_CONNECTIONS: integerEnv('SSE_MAX_GLOBAL_CONNECTIONS', 1, 100_000).default(1000),
    SSE_MAX_CONNECTION_DURATION_MS: integerEnv(
      'SSE_MAX_CONNECTION_DURATION_MS',
      1,
      86_400_000
    ).default(30 * 60 * 1000),
    SSE_RETRY_AFTER_SECONDS: integerEnv('SSE_RETRY_AFTER_SECONDS', 1, 86_400).default(15),
    /** Milliseconds the browser EventSource waits before reconnecting (sent as SSE retry: directive). */
    SSE_RETRY_MS: integerEnv('SSE_RETRY_MS', 100, 300_000).default(5000),
    /** Interval in milliseconds between SSE heartbeat comments per connection. */
    SSE_HEARTBEAT_INTERVAL_MS: integerEnv('SSE_HEARTBEAT_INTERVAL_MS', 100, 300_000).default(
      30_000
    ),
    /** Milliseconds to wait for each SSE connection to drain during shutdown before force-closing. */
    SSE_DRAIN_TIMEOUT_MS: integerEnv('SSE_DRAIN_TIMEOUT_MS', 1_000, 60_000).default(30_000),
    INDEXER_ENABLED: booleanEnv().default(false),
    WORKER_ENABLED: booleanEnv().default(false),
    /** Per-checker timeout for HealthCheckManager. Must be strictly greater than 0. */
    HEALTH_CHECK_TIMEOUT_MS: integerEnv('HEALTH_CHECK_TIMEOUT_MS', 1).default(5000),
    /** Interval between background health-check runs. Must be strictly greater than 0. */
    HEALTH_CHECK_INTERVAL_MS: integerEnv('HEALTH_CHECK_INTERVAL_MS', 1).default(30000),
    /** Enables the grpc.health.v1.Health service for Kubernetes-native gRPC probes. */
    GRPC_HEALTH_ENABLED: booleanEnv().default(false),
    /** Port the gRPC health service binds to when enabled. Separate from PORT (HTTP). */
    GRPC_HEALTH_PORT: integerEnv('GRPC_HEALTH_PORT', 1, 65535).default(50051),
    /** Enables the optional gRPC transcoding gateway for indexer communication. Default off. */
    GRPC_GATEWAY_ENABLED: booleanEnv().default(false),
    /** Port the gRPC indexer gateway binds to when enabled. */
    GRPC_GATEWAY_PORT: integerEnv('GRPC_GATEWAY_PORT', 1, 65535).default(50052),
    /** When true, reject non-TLS indexer worker connections (fail-closed). Defaults to true in production, false otherwise. */
    INDEXER_MTLS_REQUIRED: booleanEnv().optional(),
    INDEXER_STALL_THRESHOLD_MS: integerEnv('INDEXER_STALL_THRESHOLD_MS', 1000).default(
      5 * 60 * 1000
    ),
    /** Maximum number of backfill batches processed concurrently. */
    INDEXER_BACKFILL_CONCURRENCY: integerEnv('INDEXER_BACKFILL_CONCURRENCY', 1, 64).default(1),
    /** Number of ledger ranges in a single backfill batch. */
    INDEXER_BACKFILL_BATCH_SIZE: integerEnv('INDEXER_BACKFILL_BATCH_SIZE', 1, 100000).default(100),
    /** Require backfill checkpoints to advance in ledger order. */
    INDEXER_BACKFILL_STRICT_ORDER: booleanEnv().default(true),
    /** Number of ordered batches completed before the checkpoint advances. */
    INDEXER_BACKFILL_COMMIT_INTERVAL: integerEnv('INDEXER_BACKFILL_COMMIT_INTERVAL', 1, 10000).default(1),
    /** Maximum retries for a failed backfill batch. */
    INDEXER_BACKFILL_MAX_RETRIES: integerEnv('INDEXER_BACKFILL_MAX_RETRIES', 0, 100).default(3),
    /** Delay between backfill batch retries. */
    INDEXER_BACKFILL_RETRY_DELAY_MS: integerEnv('INDEXER_BACKFILL_RETRY_DELAY_MS', 0).default(1000),
    INDEXER_LAST_SUCCESSFUL_SYNC_AT: optionalString('INDEXER_LAST_SUCCESSFUL_SYNC_AT'),
    DEPLOYMENT_CHECKLIST_VERSION: z.string().min(1).default('2026-03-27'),
    ADMIN_STATE_FILE: optionalString('ADMIN_STATE_FILE'),
    RPC_CB_FAILURE_THRESHOLD: integerEnv('RPC_CB_FAILURE_THRESHOLD', 1).default(5),
    RPC_CB_WINDOW_MS: integerEnv('RPC_CB_WINDOW_MS', 1).default(30000),
    RPC_CB_RESET_TIMEOUT_MS: integerEnv('RPC_CB_RESET_TIMEOUT_MS', 1).default(60000),
    RPC_TIMEOUT_MS: integerEnv('RPC_TIMEOUT_MS', 1).default(5000),
    IDEMPOTENCY_TTL_SECONDS: integerEnv('IDEMPOTENCY_TTL_SECONDS', 1, 86400 * 7).default(86400),

    RATE_LIMIT_ENABLED: booleanEnv().default(true),
    RATE_LIMIT_IP_WINDOW_MS: integerEnv('RATE_LIMIT_IP_WINDOW_MS', 1).optional(),
    RATE_LIMIT_IP_MAX: integerEnv('RATE_LIMIT_IP_MAX', 1).optional(),
    RATE_LIMIT_APIKEY_WINDOW_MS: integerEnv('RATE_LIMIT_APIKEY_WINDOW_MS', 1).optional(),
    RATE_LIMIT_APIKEY_MAX: integerEnv('RATE_LIMIT_APIKEY_MAX', 1).optional(),
    RATE_LIMIT_ADMIN_WINDOW_MS: integerEnv('RATE_LIMIT_ADMIN_WINDOW_MS', 1).optional(),
    RATE_LIMIT_ADMIN_MAX: integerEnv('RATE_LIMIT_ADMIN_MAX', 1).optional(),
    RATE_LIMIT_TRUST_PROXY: booleanEnv().default(true),
    RATE_LIMIT_ALLOWLIST_IPS: optionalString('RATE_LIMIT_ALLOWLIST_IPS'),
    AWS_REGION: optionalString('AWS_REGION'),
    AWS_DEFAULT_REGION: optionalString('AWS_DEFAULT_REGION'),

    // S3 Backup Retention Configuration
    S3_BACKUP_BUCKET: optionalString('S3_BACKUP_BUCKET'),
    S3_BACKUP_PREFIX: optionalString('S3_BACKUP_PREFIX'),

    FLUXORA_SHUTDOWN: booleanEnv().optional(),

    /**
     * Tiered startup dependency probing.
     *
     * STARTUP_PROBE_BUDGET_MS          — total wall-clock budget for soft-tier
     *                                    retries (Redis, Stellar RPC) before the
     *                                    service falls back to degraded mode.
     *                                    Default: 30 000 ms. Maximum: 60 000 ms.
     * STARTUP_PROBE_POSTGRES_TIMEOUT_MS — per-attempt timeout for the single
     *                                    Postgres (hard-tier) probe.
     *                                    Default: 5 000 ms.
     * STARTUP_PROBE_REDIS_TIMEOUT_MS   — per-attempt timeout for each Redis
     *                                    (soft-tier) retry attempt.
     *                                    Default: 3 000 ms.
     * STARTUP_PROBE_STELLAR_TIMEOUT_MS — per-attempt timeout for each Stellar
     *                                    RPC (soft-tier) retry attempt.
     *                                    Default: 5 000 ms.
     */
    STARTUP_PROBE_BUDGET_MS: integerEnv('STARTUP_PROBE_BUDGET_MS', 1, 60_000).default(30_000),
    STARTUP_PROBE_POSTGRES_TIMEOUT_MS: integerEnv('STARTUP_PROBE_POSTGRES_TIMEOUT_MS', 1).default(
      5_000
    ),
    STARTUP_PROBE_REDIS_TIMEOUT_MS: integerEnv('STARTUP_PROBE_REDIS_TIMEOUT_MS', 1).default(3_000),
    STARTUP_PROBE_STELLAR_TIMEOUT_MS: integerEnv('STARTUP_PROBE_STELLAR_TIMEOUT_MS', 1).default(
      5_000
    ),

    /**
     * Percentage of traffic (0–100) to route through the canary code path.
     * 0 disables canary tagging entirely (default). Set to e.g. 10 to tag
     * 10 % of clients deterministically as canary based on a SHA-256 hash
     * of their identity (API key or IP).
     */
    CANARY_TRAFFIC_PERCENT: integerEnv('CANARY_TRAFFIC_PERCENT', 0, 100).default(0),

    /**
     * Retention period in days for dead_letter_queue entries.
     * Entries in a terminal state (status = 'replayed' or permanently failed)
     * older than this many days are eligible for automatic purge.
     * Defaults to 30 days.  Set to 0 to disable the purge job entirely.
     */
    DLQ_RETENTION_DAYS: integerEnv('DLQ_RETENTION_DAYS', 1, 365).default(30),

    /**
     * Maximum rows to delete per batch in the DLQ retention purge job.
     * Keeps lock duration short on the dead_letter_queue table.
     * Defaults to 500.
     */
    DLQ_PURGE_BATCH_SIZE: integerEnv('DLQ_PURGE_BATCH_SIZE', 1, 5000).default(500),
  })
  .passthrough()
  .superRefine((env, ctx) => {
    const stellarNetwork = resolvedStellarNetwork(env);
    const expectedPassphrase = STELLAR_NETWORK_PASSPHRASES[stellarNetwork];

    if (
      env.HORIZON_NETWORK_PASSPHRASE !== undefined &&
      env.HORIZON_NETWORK_PASSPHRASE !== expectedPassphrase
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['HORIZON_NETWORK_PASSPHRASE'],
        message: `HORIZON_NETWORK_PASSPHRASE must match ${stellarNetwork} passphrase`,
      });
    }

    validatePinnedAddress(
      ctx,
      stellarNetwork,
      'contract',
      'STELLAR_CONTRACT_ADDRESS',
      env.STELLAR_CONTRACT_ADDRESS
    );
    validatePinnedAddress(
      ctx,
      stellarNetwork,
      'token',
      'STELLAR_TOKEN_ADDRESS',
      env.STELLAR_TOKEN_ADDRESS
    );

    const hasApiKeys = env.API_KEYS !== undefined && env.API_KEYS.trim().length > 0;
    if (hasApiKeys && env.API_KEY_PEPPER === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_KEY_PEPPER'],
        message: 'API_KEY_PEPPER is required when API_KEYS is configured',
      });
    }

    if (env.NODE_ENV === 'production') {
      if (env.LOG_LEVEL === 'debug') {
        ctx.addIssue({
          code: 'custom',
          path: ['LOG_LEVEL'],
          message: 'LOG_LEVEL must not be "debug" in production',
        });
      }

      if (env.CORS_ALLOWED_ORIGINS !== undefined && env.CORS_ALLOWED_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS must not contain a wildcard "*" origin in production',
        });
      }

      if (env.PGCRYPTO_KEY === undefined || env.PGCRYPTO_KEY.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['PGCRYPTO_KEY'],
          message: 'PGCRYPTO_KEY is required in production (minimum 32 characters)',
        });
      }
    }
  });

type ParsedEnv = z.infer<typeof EnvSchema>;

/**
 * Global configuration interface for the Fluxora API.
 */
export interface Config {
  port: number;
  nodeEnv: NodeEnv;
  apiVersion: string;

  databaseUrl: string;
  /** Optional read-replica connection string. When set, SELECT queries on
   *  streams are routed through a dedicated replica pool. */
  databaseReplicaUrl?: string | undefined;
  databasePoolMin: number;
  databasePoolMax: number;
  databaseConnectionTimeout: number;
  databaseIdleTimeout: number;
  slowQueryThresholdMs: number;
  statementTimeoutMs: number;
  /** statement_timeout for replica connections (ms). Defaults to statementTimeoutMs. 0 = disabled. */
  replicaStatementTimeoutMs: number;
  /** Max queued requests on the replica pool before fast-failing. */
  replicaQueueLimit: number;

  redisUrl: string;
  redisEnabled: boolean;
  redisMode: 'standalone' | 'sentinel' | 'cluster';
  redisSentinelHosts?: string | undefined;
  redisSentinelName?: string | undefined;
  redisClusterNodes?: string | undefined;

  stellarNetwork: StellarNetwork;
  stellarRpcUrl: string;
  horizonUrl: string;
  horizonNetworkPassphrase: string;
  contractAddresses: ContractAddresses;

  jwtSecret: string;
  jwtSecretPrevious?: string | undefined;
  pgcryptoKey?: string | undefined;
  pgcryptoKeyPrevious?: string | undefined;
  jwtExpiresIn: string;
  apiKeys: string[];
  /** Server-side pepper for API-key hashing. Never logged. */
  apiKeyPepper?: string | undefined;
  indexerWorkerToken: string;

  /** OIDC issuer base URL. Undefined means OIDC login is disabled. */
  oidcIssuerUrl?: string | undefined;
  /** Expected `aud` (client_id) claim for OIDC ID tokens. */
  oidcAudience?: string | undefined;

  maxRequestSizeBytes: number;
  maxJsonDepth: number;
  requestTimeoutMs: number;

  logLevel: LogLevel;
  metricsEnabled: boolean;

  tracingEnabled: boolean;
  tracingSampleRate: number;
  tracingSamplingStrategy: 'head' | 'tail' | 'always' | 'never';
  tracingHeadSampleRate?: number | undefined;
  tracingTailKeepErrors: boolean;
  tracingPerRouteOverrides?: string | undefined;
  tracingOtelEnabled: boolean;
  tracingLogEvents: boolean;

  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  webhookSecretPrevious?: string | undefined;
  webhookPollIntervalMs: number;
  webhookBatchSize: number;
  webhookRetryRps: number;
  webhookAllowedHosts?: string[] | undefined;

  enableStreamValidation: boolean;
  enableRateLimit: boolean;
  idempotencyTtlSeconds: number;
  requirePartnerAuth: boolean;
  partnerApiToken?: string | undefined;
  requireAdminAuth: boolean;
  adminApiToken?: string | undefined;
  sseMaxConnectionsPerIp: number;
  sseMaxConnectionsPerApiKey: number;
  sseMaxGlobalConnections: number;
  sseMaxConnectionDurationMs: number;
  sseRetryAfterSeconds: number;
  /** Milliseconds the browser EventSource waits before reconnecting (sent as SSE retry: directive). */
  sseRetryMs: number;
  /** Interval in milliseconds between per-connection SSE heartbeat comments. */
  sseHeartbeatIntervalMs: number;
  /** Milliseconds to wait for each SSE connection to drain during shutdown before force-closing. */
  sseDrainTimeoutMs: number;
  indexerEnabled: boolean;
  workerEnabled: boolean;
  /** Per-checker timeout for HealthCheckManager, in ms. */
  healthCheckTimeoutMs: number;
  /** Interval between background health-check runs, in ms. */
  healthCheckIntervalMs: number;
  /** Enables the grpc.health.v1.Health service (k8s-native gRPC probes). */
  grpcHealthEnabled: boolean;
  /** Port the gRPC health service binds to when enabled. */
  grpcHealthPort: number;
  /** Enables the optional gRPC transcoding gateway for indexer communication. */
  grpcGatewayEnabled: boolean;
  /** Port the gRPC indexer gateway binds to when enabled. */
  grpcGatewayPort: number;
  /** When true, reject non-TLS indexer worker connections (fail-closed). */
  indexerMtlsRequired: boolean;
  /** Maximum number of backfill batches processed concurrently. */
  indexerBackfillConcurrency: number;
  /** Number of ledger ranges in a single backfill batch. */
  indexerBackfillBatchSize: number;
  /** Require backfill checkpoints to advance in ledger order. */
  indexerBackfillStrictOrder: boolean;
  /** Number of ordered batches completed before the checkpoint advances. */
  indexerBackfillCommitInterval: number;
  /** Maximum retries for a failed backfill batch. */
  indexerBackfillMaxRetries: number;
  /** Delay between backfill batch retries. */
  indexerBackfillRetryDelayMs: number;
  indexerStallThresholdMs: number;
  indexerLastSuccessfulSyncAt?: string | undefined;
  deploymentChecklistVersion: string;

  // S3 Backup Retention
  s3BackupBucket?: string | undefined;
  s3BackupPrefix?: string | undefined;

  /**
   * Tiered startup dependency probing.
   *
   * See `probeStartupDependencies()` in `src/config/health.ts` for details on
   * the two-tier (hard / soft) probe strategy.
   */
  /** Total wall-clock budget for soft-tier retries (Redis, Stellar RPC), ms. */
  startupProbeBudgetMs: number;
  /** Per-attempt timeout for the single Postgres (hard-tier) probe, ms. */
  startupProbePostgresTimeoutMs: number;
  /** Per-attempt timeout for each Redis (soft-tier) retry attempt, ms. */
  startupProbeRedisTimeoutMs: number;
  /** Per-attempt timeout for each Stellar RPC (soft-tier) retry attempt, ms. */
  startupProbeStellarTimeoutMs: number;

  /**
   * Percentage of traffic (0–100) to tag as canary.
   * 0 means no canary tagging. Sourced from CANARY_TRAFFIC_PERCENT.
   */
  canaryTrafficPercent: number;

  /**
   * Retention period in days for dead_letter_queue entries in terminal state.
   * Defaults to 30. Set to 0 to disable the DLQ retention purge job.
   */
  dlqRetentionDays: number;

  /**
   * Maximum rows to delete per batch in the DLQ retention purge job.
   * Defaults to 500.
   */
  dlqPurgeBatchSize: number;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string | string[]) {
    const issues = Array.isArray(message) ? message : [message];
    super(`Invalid environment configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export class EnvironmentError extends ConfigError {
  constructor(message: string | string[]) {
    super(Array.isArray(message) ? message : [message]);
    this.name = 'EnvironmentError';
  }
}

function formatPath(issue: z.ZodIssue): string {
  const key = issue.path[0];
  return typeof key === 'string' && key.length > 0 ? key : 'ENV';
}

function issueMessage(issue: z.ZodIssue): string {
  const name = formatPath(issue);
  if (issue.code === 'invalid_type' && (issue as { input?: unknown }).input === undefined) {
    return `${name}: required`;
  }

  const message = SECRET_ENV_NAMES.has(name)
    ? issue.message.replace(/".*?"/g, '"[redacted]"')
    : issue.message;
  return `${name}: ${message}`;
}

function parseEnv(env: NodeJS.ProcessEnv): ParsedEnv {
  try {
    return EnvSchema.parse(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new EnvironmentError(error.issues.map(issueMessage));
    }
    throw error;
  }
}

function resolveNetwork(env: ParsedEnv): StellarNetwork {
  return resolvedStellarNetwork(env);
}

function resolveContractAddresses(network: StellarNetwork, env: ParsedEnv): ContractAddresses {
  return {
    streaming: env.STELLAR_CONTRACT_ADDRESS,
    contract: env.STELLAR_CONTRACT_ADDRESS,
    token: env.STELLAR_TOKEN_ADDRESS,
  };
}

function toConfig(env: ParsedEnv): Config {
  const stellarNetwork = resolveNetwork(env);
  const networkDefaults = STELLAR_NETWORKS[stellarNetwork];
  const isProduction = env.NODE_ENV === 'production';

  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    apiVersion: '0.1.0',

    databaseUrl: env.DATABASE_URL,
    databaseReplicaUrl: env.DATABASE_REPLICA_URL,
    databasePoolMin: env.DB_POOL_MIN,
    databasePoolMax: env.DB_POOL_MAX,
    databaseConnectionTimeout: env.DB_CONNECTION_TIMEOUT,
    databaseIdleTimeout: env.DB_IDLE_TIMEOUT,
    slowQueryThresholdMs: env.SLOW_QUERY_THRESHOLD_MS,
    statementTimeoutMs: env.STATEMENT_TIMEOUT_MS,
    replicaStatementTimeoutMs: env.REPLICA_STATEMENT_TIMEOUT_MS ?? env.STATEMENT_TIMEOUT_MS,
    replicaQueueLimit: env.REPLICA_QUEUE_LIMIT,

    redisUrl: env.REDIS_URL,
    redisEnabled: env.REDIS_ENABLED,
    redisMode: env.REDIS_MODE,
    redisSentinelHosts: env.REDIS_SENTINEL_HOSTS,
    redisSentinelName: env.REDIS_SENTINEL_NAME,
    redisClusterNodes: env.REDIS_CLUSTER_NODES,

    stellarNetwork,
    stellarRpcUrl: env.STELLAR_RPC_URL,
    horizonUrl: env.HORIZON_URL ?? networkDefaults.horizonUrl,
    horizonNetworkPassphrase: env.HORIZON_NETWORK_PASSPHRASE ?? networkDefaults.passphrase,
    contractAddresses: resolveContractAddresses(stellarNetwork, env),

    jwtSecret: env.JWT_SECRET,
    jwtSecretPrevious: env.JWT_SECRET_PREVIOUS,
    pgcryptoKey: env.PGCRYPTO_KEY,
    pgcryptoKeyPrevious: env.PGCRYPTO_KEY_PREVIOUS,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    apiKeys: (env.API_KEYS ?? (env.NODE_ENV === 'test' ? 'test-api-key' : ''))
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
    apiKeyPepper: env.API_KEY_PEPPER,
    indexerWorkerToken: env.INDEXER_WORKER_TOKEN,

    oidcIssuerUrl: env.OIDC_ISSUER_URL,
    oidcAudience: env.OIDC_AUDIENCE,

    maxRequestSizeBytes: env.MAX_REQUEST_SIZE,
    maxJsonDepth: env.MAX_JSON_DEPTH,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,

    logLevel: env.LOG_LEVEL,
    metricsEnabled: env.METRICS_ENABLED,

    tracingEnabled: env.TRACING_ENABLED,
    tracingSampleRate: env.TRACING_SAMPLE_RATE,
    tracingSamplingStrategy: env.TRACING_SAMPLING_STRATEGY,
    tracingHeadSampleRate: env.TRACING_HEAD_SAMPLE_RATE,
    tracingTailKeepErrors: env.TRACING_TAIL_KEEP_ERRORS,
    tracingPerRouteOverrides: env.TRACING_PER_ROUTE_OVERRIDES,
    tracingOtelEnabled: env.TRACING_OTEL_ENABLED,
    tracingLogEvents: env.TRACING_LOG_EVENTS,

    webhookUrl: env.WEBHOOK_URL,
    webhookSecret: env.WEBHOOK_SECRET,
    webhookSecretPrevious: env.WEBHOOK_SECRET_PREVIOUS,
    webhookPollIntervalMs: env.WEBHOOK_POLL_INTERVAL_MS,
    webhookBatchSize: env.WEBHOOK_BATCH_SIZE,
    webhookRetryRps: env.WEBHOOK_RETRY_RPS,
    webhookAllowedHosts: env.WEBHOOK_ALLOWED_HOSTS
      ? env.WEBHOOK_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(h => h.length > 0)
      : undefined,

    enableStreamValidation: env.ENABLE_STREAM_VALIDATION,
    enableRateLimit: env.ENABLE_RATE_LIMIT ?? !isProduction,
    idempotencyTtlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
    requirePartnerAuth: env.REQUIRE_PARTNER_AUTH,
    partnerApiToken: env.PARTNER_API_TOKEN,
    requireAdminAuth: env.REQUIRE_ADMIN_AUTH,
    adminApiToken: env.ADMIN_API_TOKEN,
    sseMaxConnectionsPerIp: env.SSE_MAX_CONNECTIONS_PER_IP,
    sseMaxConnectionsPerApiKey: env.SSE_MAX_CONNECTIONS_PER_API_KEY,
    sseMaxGlobalConnections: env.SSE_MAX_GLOBAL_CONNECTIONS,
    sseMaxConnectionDurationMs: env.SSE_MAX_CONNECTION_DURATION_MS,
    sseRetryAfterSeconds: env.SSE_RETRY_AFTER_SECONDS,
    sseRetryMs: env.SSE_RETRY_MS,
    sseHeartbeatIntervalMs: env.SSE_HEARTBEAT_INTERVAL_MS,
    sseDrainTimeoutMs: env.SSE_DRAIN_TIMEOUT_MS,
    indexerEnabled: env.INDEXER_ENABLED,
    workerEnabled: env.WORKER_ENABLED,
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS,
    grpcHealthEnabled: env.GRPC_HEALTH_ENABLED,
    grpcHealthPort: env.GRPC_HEALTH_PORT,
    grpcGatewayEnabled: env.GRPC_GATEWAY_ENABLED,
    grpcGatewayPort: env.GRPC_GATEWAY_PORT,
    indexerMtlsRequired: env.INDEXER_MTLS_REQUIRED ?? isProduction,
    indexerBackfillConcurrency: env.INDEXER_BACKFILL_CONCURRENCY,
    indexerBackfillBatchSize: env.INDEXER_BACKFILL_BATCH_SIZE,
    indexerBackfillStrictOrder: env.INDEXER_BACKFILL_STRICT_ORDER,
    indexerBackfillCommitInterval: env.INDEXER_BACKFILL_COMMIT_INTERVAL,
    indexerBackfillMaxRetries: env.INDEXER_BACKFILL_MAX_RETRIES,
    indexerBackfillRetryDelayMs: env.INDEXER_BACKFILL_RETRY_DELAY_MS,
    indexerStallThresholdMs: env.INDEXER_STALL_THRESHOLD_MS,
    indexerLastSuccessfulSyncAt: env.INDEXER_LAST_SUCCESSFUL_SYNC_AT,
    deploymentChecklistVersion: env.DEPLOYMENT_CHECKLIST_VERSION,

    s3BackupBucket: env.S3_BACKUP_BUCKET,
    s3BackupPrefix: env.S3_BACKUP_PREFIX,

    startupProbeBudgetMs: env.STARTUP_PROBE_BUDGET_MS,
    startupProbePostgresTimeoutMs: env.STARTUP_PROBE_POSTGRES_TIMEOUT_MS,
    startupProbeRedisTimeoutMs: env.STARTUP_PROBE_REDIS_TIMEOUT_MS,
    startupProbeStellarTimeoutMs: env.STARTUP_PROBE_STELLAR_TIMEOUT_MS,

    canaryTrafficPercent: env.CANARY_TRAFFIC_PERCENT,

    dlqRetentionDays: env.DLQ_RETENTION_DAYS,
    dlqPurgeBatchSize: env.DLQ_PURGE_BATCH_SIZE,
  };
}

/**
 * Parse process.env during module load so invalid deployments fail before the
 * server can bind a socket. The parsed value is intentionally not exported.
 */
parseEnv(process.env);

export function loadConfig(): Config {
  return toConfig(parseEnv(process.env));
}

let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    throw new ConfigError('Configuration not initialized. Call initialize() first.');
  }
  return configInstance;
}

export function initializeConfig(): Config {
  if (configInstance) {
    return configInstance;
  }

  configInstance = loadConfig();
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}

/**
 * Reset the startup env snapshot back to null.
 *
 * **FOR TESTING ONLY.** Allows each test to exercise
 * `captureStartupEnvSnapshot()` / `reloadHotConfig()` in isolation without
 * full module reloading. Never call this in production code.
 *
 * @internal
 */
export function resetStartupEnvSnapshot(): void {
  startupEnvSnapshot = null;
  lastHotConfig = null;
  reloadGeneration = 0;
}

// ─── Hot-reload support ───────────────────────────────────────────────────────

/**
 * The subset of configuration values that can be changed at runtime by
 * sending SIGHUP to the process. All other variables require a full restart.
 */
export interface HotConfig {
  rateLimitIpWindowMs: number | undefined;
  rateLimitIpMax: number | undefined;
  rateLimitApikeyWindowMs: number | undefined;
  rateLimitApikeyMax: number | undefined;
  rateLimitAdminWindowMs: number | undefined;
  rateLimitAdminMax: number | undefined;
  tracingSampleRate: number;
  tracingEnabled: boolean;
  logLevel: LogLevel;
  featureFlagsJson: string | undefined;
  featureFlagsFile: string | undefined;
}

/**
 * Result of a full config-refresh cycle (parse + apply).
 * Used by the SIGHUP handler and tests to assert deterministic outcomes.
 */
export interface ConfigRefreshResult {
  /** Frozen HotConfig snapshot that was applied. */
  hot: HotConfig;
  /** Monotonic generation counter; increments on every successful refresh. */
  generation: number;
  /** Restart-only keys that differ from the startup snapshot (never applied). */
  restartOnlyChanges: readonly RestartOnlyKey[];
  /** Whether the refresh applied a config that differs from the previous one. */
  changed: boolean;
  /** Wall-clock duration of the refresh in milliseconds. */
  durationMs: number;
}

/**
 * The set of env-var keys whose change requires a full process restart.
 * If any of these change between the startup snapshot and a SIGHUP, a WARN
 * is emitted but the new value is intentionally not applied.
 */
const RESTART_ONLY_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'INDEXER_WORKER_TOKEN',
] as const;
type RestartOnlyKey = (typeof RESTART_ONLY_KEYS)[number];

/** Snapshot of restart-only env values captured at process startup. */
let startupEnvSnapshot: Readonly<Record<RestartOnlyKey, string | undefined>> | null = null;

/**
 * Last successfully built HotConfig. Exposed so request paths (rate limiter,
 * tracing, logger) and the SIGHUP handler share one deterministic snapshot
 * across retries and deploys — not a fresh parse of process.env each time.
 */
let lastHotConfig: HotConfig | null = null;

/** Monotonic generation counter for successful reloads (observability + tests). */
let reloadGeneration = 0;

/**
 * Serialize concurrent SIGHUP / refresh calls so only one apply runs at a time.
 * Node is single-threaded, but nested/re-entrant signal handlers and tests
 * that fire multiple refreshes in one tick still need a clear total order.
 */
let reloadInFlight: Promise<ConfigRefreshResult> | null = null;

/**
 * Capture the current values of restart-only env variables.
 * Call this once during startup, before any SIGHUP handler is registered.
 * Subsequent calls are no-ops (the first snapshot is preserved).
 */
export function captureStartupEnvSnapshot(): void {
  if (startupEnvSnapshot !== null) return;
  const snapshot = {} as Record<RestartOnlyKey, string | undefined>;
  for (const key of RESTART_ONLY_KEYS) {
    snapshot[key] = process.env[key];
  }
  startupEnvSnapshot = Object.freeze(snapshot);
}

/**
 * Return the last HotConfig produced by `reloadHotConfig()` / `refreshHotConfig()`,
 * or `null` if no reload has run yet. Callers that need stable mid-request
 * views of hot config should prefer this over re-parsing process.env.
 */
export function getLastHotConfig(): HotConfig | null {
  return lastHotConfig;
}

/** Monotonic generation of the last successful hot-config build (0 = never). */
export function getHotConfigGeneration(): number {
  return reloadGeneration;
}

/** Stable serialization of a HotConfig for equality / change detection. */
function hotConfigFingerprint(hot: HotConfig): string {
  return [
    hot.rateLimitIpWindowMs ?? '',
    hot.rateLimitIpMax ?? '',
    hot.rateLimitApikeyWindowMs ?? '',
    hot.rateLimitApikeyMax ?? '',
    hot.rateLimitAdminWindowMs ?? '',
    hot.rateLimitAdminMax ?? '',
    hot.tracingSampleRate,
    hot.tracingEnabled ? '1' : '0',
    hot.logLevel,
    hot.featureFlagsJson ?? '',
    hot.featureFlagsFile ?? '',
  ].join('\u0001');
}

/**
 * Parse optional positive integers for rate-limit fields.
 * Empty, non-numeric, zero, and negative values → undefined (use defaults).
 * Leading/trailing whitespace is tolerated via parseInt.
 */
function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseFloat01(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function parseBoolHot(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseLogLevelHot(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw !== undefined && (VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return fallback;
}

/**
 * Detect restart-only key drift vs the startup snapshot.
 * Emits one WARN per changed key (variable NAME only — never the value).
 */
function detectRestartOnlyChanges(): RestartOnlyKey[] {
  if (startupEnvSnapshot === null) {
    captureStartupEnvSnapshot();
  }
  const changed: RestartOnlyKey[] = [];
  for (const key of RESTART_ONLY_KEYS) {
    const original = startupEnvSnapshot![key];
    const current = process.env[key];
    if (current !== original) {
      changed.push(key);
      warn(`SIGHUP: restart-only variable ${key} changed — restart required to apply`, {
        variable: key,
      });
    }
  }
  return changed;
}

/**
 * Parse the whitelisted hot-reloadable keys from `process.env` and return a
 * fully-built `HotConfig` object.
 *
 * If any restart-only key has changed since startup, a WARN is logged for each
 * changed key. The new value is NOT applied — callers receive only the
 * hot-reloadable portion.
 *
 * The build is atomic: the returned object is fully constructed before it is
 * returned to the caller; no intermediate state is ever visible.
 *
 * Determinism guarantees:
 * - Same `process.env` → same frozen HotConfig fields (stable defaults).
 * - The latest successful build is stored and exposed via `getLastHotConfig()`.
 * - Generation counter increments so deploys/retries can observe apply order.
 *
 * Requires `captureStartupEnvSnapshot()` to have been called first. If it has
 * not been called yet, a snapshot is taken implicitly now so that the function
 * still works in isolation (e.g. in tests).
 */
export function reloadHotConfig(): HotConfig {
  detectRestartOnlyChanges();

  const newConfig: HotConfig = {
    rateLimitIpWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_WINDOW_MS),
    rateLimitIpMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_MAX),
    rateLimitApikeyWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_WINDOW_MS),
    rateLimitApikeyMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_MAX),
    rateLimitAdminWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS),
    rateLimitAdminMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_MAX),
    tracingSampleRate: parseFloat01(process.env.TRACING_SAMPLE_RATE, 1),
    tracingEnabled: parseBoolHot(process.env.TRACING_ENABLED, false),
    logLevel: parseLogLevelHot(process.env.LOG_LEVEL, 'info'),
    featureFlagsJson: process.env.FEATURE_FLAGS_JSON || undefined,
    featureFlagsFile: process.env.FEATURE_FLAGS_FILE || undefined,
  };

  const frozen = Object.freeze(newConfig);
  lastHotConfig = frozen;
  reloadGeneration += 1;
  return frozen;
}

/**
 * Full config-refresh path used by the SIGHUP handler.
 *
 * Builds a HotConfig, then invokes the provided apply callbacks in a fixed
 * order. Concurrent callers share one in-flight promise so rapid SIGHUPs
 * (or deploy-time retries) collapse to a single deterministic apply.
 *
 * Auth note: this path never reloads secrets/tokens. Restart-only keys are
 * detected and reported but never applied.
 *
 * @param apply - Side-effect callbacks (rate limits, flags, log level, metrics).
 *                Thrown errors propagate so the SIGHUP handler can log failure
 *                without killing the process.
 */
export async function refreshHotConfig(apply?: {
  /** Two-phase commit style (preferred): return a commit fn from preparation. */
  prepareRateLimits?: (hot: HotConfig) => () => void;
  prepareFeatureFlags?: (hot: HotConfig) => () => void;
  prepareLogLevel?: (level: LogLevel) => () => void;
  /** Legacy direct-apply style (still supported). */
  applyRateLimits?: (hot: HotConfig) => void;
  applyFeatureFlags?: () => void;
  applyLogLevel?: (level: LogLevel) => void;
  onSuccess?: (result: ConfigRefreshResult) => void;
  onFailure?: (error: unknown, durationMs: number) => void;
}): Promise<ConfigRefreshResult> {
  // Coalesce concurrent callers onto one in-flight apply. Work is deferred to a
  // microtask so `reloadInFlight` is assigned before any body runs — otherwise a
  // fully-synchronous async IIFE would finish (and clear the flag) before the
  // assignment, breaking both coalescing and sequential change detection.
  if (reloadInFlight) {
    return reloadInFlight;
  }

  const started = Date.now();
  const run = Promise.resolve()
    .then((): ConfigRefreshResult => {
      const previous = lastHotConfig;
      const restartOnlyChanges = detectRestartOnlyChanges();

      const hot: HotConfig = Object.freeze({
        rateLimitIpWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_WINDOW_MS),
        rateLimitIpMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_MAX),
        rateLimitApikeyWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_WINDOW_MS),
        rateLimitApikeyMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_MAX),
        rateLimitAdminWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS),
        rateLimitAdminMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_MAX),
        tracingSampleRate: parseFloat01(process.env.TRACING_SAMPLE_RATE, 1),
        tracingEnabled: parseBoolHot(process.env.TRACING_ENABLED, false),
        logLevel: parseLogLevelHot(process.env.LOG_LEVEL, 'info'),
        featureFlagsJson: process.env.FEATURE_FLAGS_JSON || undefined,
        featureFlagsFile: process.env.FEATURE_FLAGS_FILE || undefined,
      });

      const changed =
        previous === null || hotConfigFingerprint(previous) !== hotConfigFingerprint(hot);

      // Resolve prepare callbacks — prefer the prepare* form (two-phase commit);
      // fall back to the legacy apply* form for backward compatibility.
      const commitRateLimits = apply?.prepareRateLimits
        ? apply.prepareRateLimits(hot)
        : apply?.applyRateLimits
          ? () => apply.applyRateLimits!(hot)
          : undefined;

      const commitFeatureFlags = apply?.prepareFeatureFlags
        ? apply.prepareFeatureFlags(hot)
        : apply?.applyFeatureFlags
          ? () => apply.applyFeatureFlags!()
          : undefined;

      const commitLogLevel = apply?.prepareLogLevel
        ? apply.prepareLogLevel(hot.logLevel)
        : apply?.applyLogLevel
          ? () => apply.applyLogLevel!(hot.logLevel)
          : undefined;

      // Commit side effects in a fixed order for deterministic deploys/retries.
      commitRateLimits?.();
      commitFeatureFlags?.();
      commitLogLevel?.();

      lastHotConfig = hot;
      reloadGeneration += 1;

      const result: ConfigRefreshResult = Object.freeze({
        hot,
        generation: reloadGeneration,
        restartOnlyChanges: Object.freeze([...restartOnlyChanges]),
        changed,
        durationMs: Date.now() - started,
      });

      apply?.onSuccess?.(result);
      return result;
    })
    .catch((error: unknown) => {
      apply?.onFailure?.(error, Date.now() - started);
      throw error;
    })
    .finally(() => {
      reloadInFlight = null;
    });

  reloadInFlight = run;
  return run;
}
