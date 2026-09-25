/**
 * Environment configuration — public entry point.
 *
 * This module is the single import surface for the rest of the codebase
 * (`import { loadConfig, Config } from './config/env.js'`). The schema itself
 * is split into per-subsystem modules (issue #1519):
 *
 * - `env-schema/`        — per-subsystem zod fragments (core, database, redis,
 *                           stellar, auth, http, webhooks, server, indexer,
 *                           rateLimit, infrastructure) composed in
 *                           `env-schema/schema.ts`
 * - `env-config.ts`       — `Config` interface, error types, env → config
 *                           mapping, and load/initialize/reset singletons
 * - `env-hot-reload.ts`   — SIGHUP hot-reload machinery (HotConfig)
 *
 * The composed schema is unchanged in effect: it accepts and rejects exactly
 * the same inputs as the original single-file definition, verified by
 * `tests/config/env.schema-split.test.ts`.
 */
import { parseEnv } from './env-config.js';

export { EnvSchema } from './env-schema/schema.js';
export type { ParsedEnv } from './env-schema/schema.js';
export type { NodeEnv, LogLevel } from './env-schema/types.js';

export { STELLAR_NETWORKS, type StellarNetwork, type ContractAddresses } from './stellar.js';
export { resolveNetwork } from './stellar.js';
export {
  STELLAR_CONTRACT_ALLOWLIST,
  STELLAR_NETWORK_PASSPHRASES,
  isValidStellarContractAddress,
  assertNetworkMatchesContracts,
  logActiveStellarConfig,
} from './stellarContracts.js';

export type { Config } from './env-config.js';
export { ConfigError, EnvironmentError, loadConfig, getConfig, initializeConfig, resetConfig } from './env-config.js';

export type { HotConfig, ConfigRefreshResult } from './env-hot-reload.js';
export {
  captureStartupEnvSnapshot,
  refreshHotConfig,
  reloadHotConfig,
  getLastHotConfig,
  getHotConfigGeneration,
  resetStartupEnvSnapshot,
} from './env-hot-reload.js';

/**
 * Parse process.env during module load so invalid deployments fail before the
 * server can bind a socket. The parsed value is intentionally not exported.
 */
parseEnv(process.env);
