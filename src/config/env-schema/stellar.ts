/**
 * Stellar blockchain environment variables (network, contracts, RPC, Horizon).
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect. Cross-field invariants
 * (passphrase match, pinned-address allowlist) live in the composed schema's
 * `superRefine` in `src/config/env.ts`.
 */
import { z } from 'zod';
import {
  integerEnv,
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
   * Horizon API base URL. When unset, falls back to the network default
   * (STELLAR_NETWORKS[network].horizonUrl).
   */
  HORIZON_URL: optionalUrlString('HORIZON_URL'),
  /** Horizon network passphrase; must match the resolved network's passphrase when set. */
  HORIZON_NETWORK_PASSPHRASE: optionalString('HORIZON_NETWORK_PASSPHRASE'),
  /** Streaming contract address override used by stream consumers. */
  CONTRACT_ADDRESS_STREAMING: optionalString('CONTRACT_ADDRESS_STREAMING'),
  /** Soroban RPC endpoint. @default 'https://soroban-testnet.stellar.org' */
  STELLAR_RPC_URL: urlString('STELLAR_RPC_URL').default('https://soroban-testnet.stellar.org'),
  /** Per-call RPC timeout in ms. @default 10000 */
  STELLAR_RPC_TIMEOUT: integerEnv('STELLAR_RPC_TIMEOUT', 1).default(10000),
  /** Retries per failed RPC call. @default 3 */
  STELLAR_RPC_MAX_RETRIES: integerEnv('STELLAR_RPC_MAX_RETRIES', 0).default(3),
  /** Base delay between RPC retries in ms. @default 1000 */
  STELLAR_RPC_RETRY_DELAY: integerEnv('STELLAR_RPC_RETRY_DELAY', 0).default(1000),
  /**
   * Per-operation timeout overrides for Stellar RPC calls.
   * Format: JSON object mapping operation names to timeouts in ms.
   * Example: '{"getLatestLedger":2000,"accountExists":8000}'
   */
  STELLAR_RPC_OPERATION_DEADLINES: z.string().optional(),
};
