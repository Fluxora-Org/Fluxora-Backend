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
 *
 * NOTE: the single-file implementation below is still the one this module
 * exports. The `env-schema/` fragments are the equivalent split definition
 * used by `env-config.ts` and are covered on their own by the equivalence
 * tests, so this module must not re-declare `EnvSchema`/`parseEnv` from them.
 */
import { parseEnv } from './env-config.js';
import { getConfig } from './env-config.js';

export { EnvSchema } from './env-schema/schema.js';
export type { ParsedEnv } from './env-schema/schema.js';
export type { NodeEnv, LogLevel } from './env-schema/types.js';

import { z } from 'zod';
import { warn } from '../lib/logger.js';
import { type StellarNetwork, STELLAR_NETWORKS, type ContractAddresses } from './stellar.js';
import {
  getPinnedAddressNetwork,
  isValidStellarContractAddress,
  assertNetworkMatchesContracts,
  logActiveStellarConfig,
  STELLAR_NETWORK_PASSPHRASES,
  type PinnedStellarAddressKind,
} from './stellarContracts.js';
import { CONNECTION_LIMIT_DEFAULTS as LIMITS } from './connectionLimits.js';
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

function operationDeadlinesEnv() {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === '') return {};
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
    z.record(z.string(), z.number().int().min(1, 'RPC operation deadlines must be at least 1ms')),
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
  path: 'STELLAR_CONTRACT_ADDRESS' | 'STELLAR_TOKEN_ADDRESS' | 'CONTRACT_ADDRESS_STREAMING' | string,
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

export { DEFAULT_WS_MAX_INBOUND_MESSAGE_BYTES } from './env-schema/server.js';

export function getWsMaxInboundMessageBytes(): number {
  return getConfig().wsMaxInboundMessageBytes;
}

/**
 * Parse process.env during module load so invalid deployments fail before the
 * server can bind a socket. The parsed value is intentionally not exported.
 */
parseEnv(process.env);
