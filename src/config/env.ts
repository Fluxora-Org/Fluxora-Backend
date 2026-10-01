/**
 * Environment configuration — public entry point.
 *
 * This module is the single import surface for the rest of the codebase
 * (`import { loadConfig, Config } from './config/env.js'`). The schema is split
 * into per-subsystem modules (issue #1519):
 *
 * - `env-schema/`        — per-subsystem zod fragments (core, database, redis,
 *                           stellar, auth, http, webhooks, server, indexer,
 *                           rateLimit, infrastructure) composed in
 *                           `env-schema/schema.ts`
 * - `env-config.ts`      — `Config` interface, error types, env → config
 *                           mapping, and load/initialize/reset singletons
 * - `env-hot-reload.ts`  — SIGHUP hot-reload machinery (HotConfig)
 *
 * The pre-split single-file implementation used to be duplicated here. It
 * redeclared `EnvSchema`, `ParsedEnv`, `Config`, `ConfigError`,
 * `EnvironmentError` and the parse/load singletons that this facade
 * re-exports, so the module exported the same names twice and could not be
 * compiled or imported. `env-config.ts` holds that implementation verbatim:
 * the composed schema accepts and rejects exactly the same inputs as the
 * original definition, verified by `tests/config/env.schema-split.test.ts`.
 */
import { getConfig, parseEnv } from './env-config.js';

export type { ParsedEnv } from './env-schema/schema.js';
export type { NodeEnv, LogLevel } from './env-schema/types.js';

export { STELLAR_NETWORKS, type StellarNetwork, type ContractAddresses } from './stellar.js';
export {
  STELLAR_CONTRACT_ALLOWLIST,
  STELLAR_NETWORK_PASSPHRASES,
  isValidStellarContractAddress,
  assertNetworkMatchesContracts,
  logActiveStellarConfig,
} from './stellarContracts.js';
export { resolveNetwork } from './stellar.js';

export type { Config } from './env-config.js';
export { loadConfig, getConfig, initializeConfig, resetConfig } from './env-config.js';
export {
  ConfigError,
  EnvironmentError,
  loadConfig,
  getConfig,
  initializeConfig,
  resetConfig,
} from './env-config.js';

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
 * Effective ceiling on a single inbound WebSocket frame, honouring
 * `WS_MAX_INBOUND_MESSAGE_BYTES` when it was overridden at startup.
 */
}

export function getWsMaxInboundMessageBytes(): number {
  return getConfig().wsMaxInboundMessageBytes;
}

/**
 * Parse process.env during module load so invalid deployments fail before the
 * server can bind a socket. The parsed value is intentionally not exported.
 */
parseEnv(process.env);
