/**
 * Config mapping layer for the split environment schema.
 *
 * Holds the `Config` interface, the `ConfigError`/`EnvironmentError` types,
 * the env → config mapping (`toConfig`), and the loader singletons. Extracted
 * from the original single-file `env.ts` verbatim; behavior is unchanged.
 *
 * The schema itself lives in `src/config/env-schema/` (per-subsystem
 * fragments composed in `schema.ts`); hot-reload machinery lives in
 * `env-hot-reload.ts`. `env.ts` re-exports the public surface unchanged.
 */
import { z } from 'zod';
import {
  type StellarNetwork,
  STELLAR_NETWORKS,
  type ContractAddresses,
  resolveNetwork as resolveStellarNetwork,
} from './stellar.js';
import { assertNetworkMatchesContracts, logActiveStellarConfig } from './stellarContracts.js';
import { EnvSchema, type ParsedEnv } from './env-schema/schema.js';
import type { NodeEnv, LogLevel } from './env-schema/types.js';
import { SECRET_ENV_NAMES } from './env-schema/parsers.js';

export type { NodeEnv, LogLevel };

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

  /** TCP connect timeout for each Redis client, in ms. */
  redisConnectTimeoutMs: number;
  /** Command retries per request before a Redis call fails. */
  redisMaxRetriesPerRequest: number;
  /** Base delay of the Redis reconnect backoff, in ms. */
  redisRetryBaseDelayMs: number;
  /** Ceiling of the Redis reconnect backoff, in ms. */
  redisRetryMaxDelayMs: number;
  /** Reconnect attempts before ioredis stops retrying. */
  redisRetryMaxAttempts: number;


  stellarNetwork: StellarNetwork;
  stellarRpcUrl: string;
  stellarRpcTimeout: number;
  stellarRpcMaxRetries: number;
  stellarRpcRetryDelay: number;
  stellarRpcOperationDeadlines: Record<string, number>;
  rpcCircuitBreakerFailureThreshold: number;
  rpcCircuitBreakerWindowMs: number;
  rpcCircuitBreakerResetTimeoutMs: number;
  rpcTimeoutMs: number;
  rpcFallbackCacheTtlSeconds: number;
  rpcFallbackCacheEarlyExpiryBeta: number;
  rpcHealthCheckIntervalMs: number;
  rpcHealthCheckFailureThreshold: number;
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
  apiKeyPepperPrevious?: string | undefined;
  indexerWorkerToken: string;

  /** OIDC issuer base URL. Undefined means OIDC login is disabled. */
  oidcIssuerUrl?: string | undefined;
  /** Expected `aud` (client_id) claim for OIDC ID tokens. */
  oidcAudience?: string | undefined;

  maxRequestSizeBytes: number;
  maxJsonDepth: number;
  requestTimeoutMs: number;
  graphqlPersistedQueryAllowlist: string[];
  graphqlPersistedQueryHashVerification: boolean;
  graphqlUnpersistedQueryPolicy: 'allow' | 'reject';
  graphqlIntrospectionEnabled: boolean;

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
  webhookRetryBurst: number;
  webhookCircuitBreakerThreshold: number;
  webhookCircuitBreakerResetMs: number;
  webhookBatchMaxBackoffMs: number;
  webhookMaxResponseBytes: number;
  webhookAllowedHosts?: string[] | undefined;

  enableStreamValidation: boolean;
  enableRateLimit: boolean;
  idempotencyTtlSeconds: number;
  requirePartnerAuth: boolean;
  partnerApiToken?: string | undefined;
  requireAdminAuth: boolean;
  adminApiToken?: string | undefined;
  /** Reject unauthenticated WebSocket, SSE and long-poll clients (WS_AUTH_REQUIRED). */
  wsAuthRequired: boolean;
  wsMaxConnectionsPerIp: number;
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
  /** Delay between backfill batch retries, in ms. */
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

/**
 * Parse a raw environment object with the composed `EnvSchema`, converting
 * zod issues into an `EnvironmentError` with redacted, actionable messages.
 *
 * @internal Exported for the module-load parse in `env.ts` and tests.
 */
export function parseEnv(env: NodeJS.ProcessEnv): ParsedEnv {
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
  return resolveStellarNetwork(env);
}

function resolveContractAddresses(network: StellarNetwork, env: ParsedEnv): ContractAddresses {
  const streaming = env.CONTRACT_ADDRESS_STREAMING ?? env.STELLAR_CONTRACT_ADDRESS;
  return {
    streaming,
    contract: env.STELLAR_CONTRACT_ADDRESS,
    token: env.STELLAR_TOKEN_ADDRESS,
  };
}

function toConfig(env: ParsedEnv): Config {
  const stellarNetwork = resolveNetwork(env);
  const networkDefaults = STELLAR_NETWORKS[stellarNetwork];
  const isProduction = env.NODE_ENV === 'production';
  const contractAddresses = resolveContractAddresses(stellarNetwork, env);

  assertNetworkMatchesContracts(stellarNetwork, contractAddresses);

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
    redisConnectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
    redisMaxRetriesPerRequest: env.REDIS_MAX_RETRIES_PER_REQUEST,
    redisRetryBaseDelayMs: env.REDIS_RETRY_BASE_DELAY_MS,
    redisRetryMaxDelayMs: env.REDIS_RETRY_MAX_DELAY_MS,
    redisRetryMaxAttempts: env.REDIS_RETRY_MAX_ATTEMPTS,

    stellarNetwork,
    stellarRpcUrl: env.STELLAR_RPC_URL,
    stellarRpcTimeout: env.STELLAR_RPC_TIMEOUT,
    stellarRpcMaxRetries: env.STELLAR_RPC_MAX_RETRIES,
    stellarRpcRetryDelay: env.STELLAR_RPC_RETRY_DELAY,
    stellarRpcOperationDeadlines: env.STELLAR_RPC_OPERATION_DEADLINES,
    rpcCircuitBreakerFailureThreshold: env.RPC_CB_FAILURE_THRESHOLD,
    rpcCircuitBreakerWindowMs: env.RPC_CB_WINDOW_MS,
    rpcCircuitBreakerResetTimeoutMs: env.RPC_CB_RESET_TIMEOUT_MS,
    rpcTimeoutMs: env.RPC_TIMEOUT_MS,
    rpcFallbackCacheTtlSeconds: env.RPC_FALLBACK_CACHE_TTL_SECONDS,
    rpcFallbackCacheEarlyExpiryBeta: env.RPC_FALLBACK_CACHE_EARLY_EXPIRY_BETA,
    rpcHealthCheckIntervalMs: env.RPC_HEALTH_CHECK_INTERVAL_MS,
    rpcHealthCheckFailureThreshold: env.RPC_HEALTH_CHECK_FAILURE_THRESHOLD,
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
    apiKeyPepperPrevious: env.API_KEY_PEPPER_PREVIOUS,
    indexerWorkerToken: env.INDEXER_WORKER_TOKEN,

    oidcIssuerUrl: env.OIDC_ISSUER_URL,
    oidcAudience: env.OIDC_AUDIENCE,

    maxRequestSizeBytes: env.MAX_REQUEST_SIZE,
    maxJsonDepth: env.MAX_JSON_DEPTH,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    graphqlPersistedQueryAllowlist: env.GRAPHQL_PERSISTED_QUERY_ALLOWLIST
      ? env.GRAPHQL_PERSISTED_QUERY_ALLOWLIST.split(',')
          .map((hash) => hash.trim())
          .filter((hash) => hash.length > 0)
      : [],
    graphqlPersistedQueryHashVerification: env.GRAPHQL_PERSISTED_QUERY_HASH_VERIFICATION,
    graphqlUnpersistedQueryPolicy: env.GRAPHQL_UNPERSISTED_QUERY_POLICY,
    graphqlIntrospectionEnabled: env.GRAPHQL_INTROSPECTION_ENABLED,

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
    webhookRetryBurst: env.WEBHOOK_RETRY_BURST,
    webhookCircuitBreakerThreshold: env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD,
    webhookCircuitBreakerResetMs: env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS,
    webhookBatchMaxBackoffMs: env.WEBHOOK_BATCH_MAX_BACKOFF_MS,
    webhookMaxResponseBytes: env.WEBHOOK_MAX_RESPONSE_BYTES,
    webhookAllowedHosts: env.WEBHOOK_ALLOWED_HOSTS
      ? env.WEBHOOK_ALLOWED_HOSTS.split(',')
          .map((h) => h.trim())
          .filter((h) => h.length > 0)
      : undefined,

    enableStreamValidation: env.ENABLE_STREAM_VALIDATION,
    enableRateLimit: env.ENABLE_RATE_LIMIT ?? !isProduction,
    idempotencyTtlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
    requirePartnerAuth: env.REQUIRE_PARTNER_AUTH,
    partnerApiToken: env.PARTNER_API_TOKEN,
    requireAdminAuth: env.REQUIRE_ADMIN_AUTH,
    adminApiToken: env.ADMIN_API_TOKEN,
    /** Reject unauthenticated WebSocket, SSE and long-poll clients (WS_AUTH_REQUIRED). */
    wsAuthRequired: env.WS_AUTH_REQUIRED,
    wsMaxConnectionsPerIp: env.WS_MAX_CONNECTIONS_PER_IP,
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
  if (process.env.NODE_ENV !== 'test') {
    logActiveStellarConfig({
      network: configInstance.stellarNetwork,
      contractAddresses: configInstance.contractAddresses,
    });
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}
