import { z } from 'zod';
import { type StellarNetwork, STELLAR_NETWORKS, type ContractAddresses } from './stellar.js';
export { STELLAR_NETWORKS, type StellarNetwork, type ContractAddresses } from './stellar.js';

type NodeEnv = 'development' | 'staging' | 'production' | 'test';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_ENV_NAMES = new Set([
  'JWT_SECRET',
  'INDEXER_WORKER_TOKEN',
  'WEBHOOK_SECRET',
  'WEBHOOK_SECRET_PREVIOUS',
  'PARTNER_API_TOKEN',
  'ADMIN_API_TOKEN',
  'ADMIN_API_KEY',
  'API_KEYS',
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
  return z.string().min(1, `${name} is required`).refine((value) => {
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
      .optional(),
  );
}

function integerEnv(name: string, min: number, max?: number) {
  const schema = z.preprocess(
    parseInteger,
    z.number().int(`${name} must be an integer`).min(min, `${name} must be at least ${min}`),
  );
  return max === undefined ? schema : schema.pipe(z.number().max(max, `${name} must be at most ${max}`));
}

function booleanEnv() {
  return z.preprocess(parseBoolean, z.boolean());
}

function optionalString(name: string) {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1, `${name} cannot be empty`).optional(),
  );
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: integerEnv('PORT', 1, 65535).default(3000),

  DATABASE_URL: urlString('DATABASE_URL'),
  DB_POOL_MIN: integerEnv('DB_POOL_MIN', 1, 100).default(2),
  DB_POOL_MAX: integerEnv('DB_POOL_MAX', 1, 100).default(10),
  DB_CONNECTION_TIMEOUT: integerEnv('DB_CONNECTION_TIMEOUT', 1000, 60000).default(5000),
  DB_IDLE_TIMEOUT: integerEnv('DB_IDLE_TIMEOUT', 1000, 600000).default(30000),

  REDIS_URL: urlString('REDIS_URL').default('redis://localhost:6379'),
  REDIS_ENABLED: booleanEnv().default(true),

  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).optional(),
  HORIZON_URL: optionalUrlString('HORIZON_URL'),
  HORIZON_NETWORK_PASSPHRASE: optionalString('HORIZON_NETWORK_PASSPHRASE'),
  CONTRACT_ADDRESS_STREAMING: optionalString('CONTRACT_ADDRESS_STREAMING'),
  STELLAR_RPC_URL: urlString('STELLAR_RPC_URL').default('https://soroban-testnet.stellar.org'),
  STELLAR_RPC_TIMEOUT: integerEnv('STELLAR_RPC_TIMEOUT', 1).default(10000),
  STELLAR_RPC_MAX_RETRIES: integerEnv('STELLAR_RPC_MAX_RETRIES', 0).default(3),
  STELLAR_RPC_RETRY_DELAY: integerEnv('STELLAR_RPC_RETRY_DELAY', 0).default(1000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().min(1, 'JWT_EXPIRES_IN cannot be empty').default('24h'),
  API_KEYS: z.string().optional(),
  INDEXER_WORKER_TOKEN: z.string().min(32, 'INDEXER_WORKER_TOKEN must be at least 32 characters'),
  ADMIN_API_KEY: optionalString('ADMIN_API_KEY'),

  MAX_REQUEST_SIZE: z.preprocess(
    byteSizeToNumber,
    z.number().int('MAX_REQUEST_SIZE must resolve to whole bytes').positive('MAX_REQUEST_SIZE must be positive'),
  ).default(1024 * 1024),
  MAX_JSON_DEPTH: integerEnv('MAX_JSON_DEPTH', 1, 1000).default(20),
  REQUEST_TIMEOUT_MS: integerEnv('REQUEST_TIMEOUT_MS', 1000, 300000).default(30000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  METRICS_ENABLED: booleanEnv().default(true),
  CORS_ALLOWED_ORIGINS: optionalString('CORS_ALLOWED_ORIGINS'),

  TRACING_ENABLED: booleanEnv().default(false),
  TRACING_SAMPLE_RATE: z.preprocess(
    parseNumber,
    z.number().min(0, 'TRACING_SAMPLE_RATE must be at least 0').max(1, 'TRACING_SAMPLE_RATE must be at most 1'),
  ).default(1),
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

  ENABLE_STREAM_VALIDATION: booleanEnv().default(true),
  ENABLE_RATE_LIMIT: booleanEnv().optional(),
  REQUIRE_PARTNER_AUTH: booleanEnv().default(false),
  PARTNER_API_TOKEN: optionalString('PARTNER_API_TOKEN'),
  REQUIRE_ADMIN_AUTH: booleanEnv().default(false),
  ADMIN_API_TOKEN: optionalString('ADMIN_API_TOKEN'),
  WS_AUTH_REQUIRED: booleanEnv().default(false),
  INDEXER_ENABLED: booleanEnv().default(false),
  WORKER_ENABLED: booleanEnv().default(false),
  INDEXER_STALL_THRESHOLD_MS: integerEnv('INDEXER_STALL_THRESHOLD_MS', 1000).default(5 * 60 * 1000),
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
  FLUXORA_SHUTDOWN: booleanEnv().optional(),
}).passthrough();

type ParsedEnv = z.infer<typeof EnvSchema>;

/**
 * Global configuration interface for the Fluxora API.
 */
export interface Config {
  port: number;
  nodeEnv: NodeEnv;
  apiVersion: string;

  databaseUrl: string;
  databasePoolMin: number;
  databasePoolMax: number;
  databaseConnectionTimeout: number;
  databaseIdleTimeout: number;

  redisUrl: string;
  redisEnabled: boolean;

  stellarNetwork: StellarNetwork;
  horizonUrl: string;
  horizonNetworkPassphrase: string;
  contractAddresses: ContractAddresses;

  jwtSecret: string;
  jwtExpiresIn: string;
  apiKeys: string[];
  indexerWorkerToken: string;

  maxRequestSizeBytes: number;
  maxJsonDepth: number;
  requestTimeoutMs: number;

  logLevel: LogLevel;
  metricsEnabled: boolean;

  tracingEnabled: boolean;
  tracingSampleRate: number;
  tracingOtelEnabled: boolean;
  tracingLogEvents: boolean;

  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  webhookSecretPrevious?: string | undefined;
  webhookPollIntervalMs: number;
  webhookBatchSize: number;
  webhookRetryRps: number;

  enableStreamValidation: boolean;
  enableRateLimit: boolean;
  idempotencyTtlSeconds: number;
  requirePartnerAuth: boolean;
  partnerApiToken?: string | undefined;
  requireAdminAuth: boolean;
  adminApiToken?: string | undefined;
  indexerEnabled: boolean;
  workerEnabled: boolean;
  indexerStallThresholdMs: number;
  indexerLastSuccessfulSyncAt?: string | undefined;
  deploymentChecklistVersion: string;
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
  return env.STELLAR_NETWORK ?? (env.NODE_ENV === 'production' ? 'mainnet' : 'testnet');
}

function resolveContractAddresses(network: StellarNetwork, env: ParsedEnv): ContractAddresses {
  const defaults = STELLAR_NETWORKS[network];
  const streaming = env.CONTRACT_ADDRESS_STREAMING ?? defaults.streamingContractAddress;

  if (env.NODE_ENV === 'production' && streaming.includes('PLACEHOLDER')) {
    throw new EnvironmentError([
      'CONTRACT_ADDRESS_STREAMING: must be set to a real contract address in production',
    ]);
  }

  return { streaming };
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
    databasePoolMin: env.DB_POOL_MIN,
    databasePoolMax: env.DB_POOL_MAX,
    databaseConnectionTimeout: env.DB_CONNECTION_TIMEOUT,
    databaseIdleTimeout: env.DB_IDLE_TIMEOUT,

    redisUrl: env.REDIS_URL,
    redisEnabled: env.REDIS_ENABLED,

    stellarNetwork,
    horizonUrl: env.HORIZON_URL ?? networkDefaults.horizonUrl,
    horizonNetworkPassphrase: env.HORIZON_NETWORK_PASSPHRASE ?? networkDefaults.passphrase,
    contractAddresses: resolveContractAddresses(stellarNetwork, env),

    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    apiKeys: (env.API_KEYS ?? (env.NODE_ENV === 'test' ? 'test-api-key' : ''))
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
    indexerWorkerToken: env.INDEXER_WORKER_TOKEN,

    maxRequestSizeBytes: env.MAX_REQUEST_SIZE,
    maxJsonDepth: env.MAX_JSON_DEPTH,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,

    logLevel: env.LOG_LEVEL,
    metricsEnabled: env.METRICS_ENABLED,

    tracingEnabled: env.TRACING_ENABLED,
    tracingSampleRate: env.TRACING_SAMPLE_RATE,
    tracingOtelEnabled: env.TRACING_OTEL_ENABLED,
    tracingLogEvents: env.TRACING_LOG_EVENTS,

    webhookUrl: env.WEBHOOK_URL,
    webhookSecret: env.WEBHOOK_SECRET,
    webhookSecretPrevious: env.WEBHOOK_SECRET_PREVIOUS,
    webhookPollIntervalMs: env.WEBHOOK_POLL_INTERVAL_MS,
    webhookBatchSize: env.WEBHOOK_BATCH_SIZE,
    webhookRetryRps: env.WEBHOOK_RETRY_RPS,

    enableStreamValidation: env.ENABLE_STREAM_VALIDATION,
    enableRateLimit: env.ENABLE_RATE_LIMIT ?? !isProduction,
    idempotencyTtlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
    requirePartnerAuth: env.REQUIRE_PARTNER_AUTH,
    partnerApiToken: env.PARTNER_API_TOKEN,
    requireAdminAuth: env.REQUIRE_ADMIN_AUTH,
    adminApiToken: env.ADMIN_API_TOKEN,
    indexerEnabled: env.INDEXER_ENABLED,
    workerEnabled: env.WORKER_ENABLED,
    indexerStallThresholdMs: env.INDEXER_STALL_THRESHOLD_MS,
    indexerLastSuccessfulSyncAt: env.INDEXER_LAST_SUCCESSFUL_SYNC_AT,
    deploymentChecklistVersion: env.DEPLOYMENT_CHECKLIST_VERSION,
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
