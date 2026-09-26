/**
 * Stellar blockchain environment variables (network, contracts, RPC, Horizon).
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect. Cross-field invariants
 * (passphrase match, pinned-address allowlist incl. the optional streaming
 * address) live in the composed schema's `superRefine` in `schema.ts`.
 */
import { z } from 'zod';
import { isValidStellarContractAddress } from '../stellarContracts.js';
import { CONNECTION_LIMIT_DEFAULTS as LIMITS } from '../connectionLimits.js';
import {
  integerEnv,
  operationDeadlinesEnv,
  optionalString,
  optionalUrlString,
  requiredStellarContractAddress,
  urlString,
} from './parsers.js';

export const stellarEnvSchema = {
  /**
   * Target Stellar network. Defaults to `mainnet` when NODE_ENV=production,
   * otherwise `testnet`. `local` skips pinned-address checks for development.
   */
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet', 'local']).optional(),
  /** Streaming contract address (Stellar contract StrKey, allowlisted when not local). */
  STELLAR_CONTRACT_ADDRESS: requiredStellarContractAddress('STELLAR_CONTRACT_ADDRESS'),
  /** Token contract address (Stellar contract StrKey, allowlisted when not local). */
  STELLAR_TOKEN_ADDRESS: requiredStellarContractAddress('STELLAR_TOKEN_ADDRESS'),
  /**
   * Optional dedicated streaming contract address. Falls back to
   * STELLAR_CONTRACT_ADDRESS when unset. Must be a valid StrKey and is
   * checked against the pinned allowlist when a network is resolved.
   */
  CONTRACT_ADDRESS_STREAMING: z
    .preprocess((value) => (value === '' ? undefined : value), z.string().trim().optional())
    .refine(
      (val) => val === undefined || isValidStellarContractAddress(val),
      'CONTRACT_ADDRESS_STREAMING must be a valid Stellar contract StrKey'
    ),
  /**
   * Horizon API base URL. When unset, falls back to the network default
   * (STELLAR_NETWORKS[network].horizonUrl).
   */
  HORIZON_URL: optionalUrlString('HORIZON_URL'),
  /** Horizon network passphrase; must match the resolved network's passphrase when set. */
  HORIZON_NETWORK_PASSPHRASE: optionalString('HORIZON_NETWORK_PASSPHRASE'),
  /** Soroban RPC endpoint. @default 'https://soroban-testnet.stellar.org' */
  STELLAR_RPC_URL: urlString('STELLAR_RPC_URL').default('https://soroban-testnet.stellar.org'),
  /** Per-call RPC timeout in ms. @default 10000 */
  STELLAR_RPC_TIMEOUT: integerEnv('STELLAR_RPC_TIMEOUT', 1).default(LIMITS.STELLAR_RPC_TIMEOUT),
  /** Retries per failed RPC call. @default 3 */
  STELLAR_RPC_MAX_RETRIES: integerEnv('STELLAR_RPC_MAX_RETRIES', 0).default(
    LIMITS.STELLAR_RPC_MAX_RETRIES
  ),
  /** Base delay between RPC retries in ms. @default 1000 */
  STELLAR_RPC_RETRY_DELAY: integerEnv('STELLAR_RPC_RETRY_DELAY', 0).default(
    LIMITS.STELLAR_RPC_RETRY_DELAY
  ),
  /**
   * Per-operation timeout overrides for Stellar RPC calls.
   * Format: JSON object mapping operation names to timeouts in ms.
   * Example: '{"getLatestLedger":2000,"accountExists":8000}'
   */
  STELLAR_RPC_OPERATION_DEADLINES: operationDeadlinesEnv(),
};
