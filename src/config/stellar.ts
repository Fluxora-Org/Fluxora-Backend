import { isValidStellarContractAddress } from './stellarContracts.js';

export type StellarNetwork = 'testnet' | 'mainnet' | 'local';

export interface StellarNetworkConfig {
  horizonUrl: string;
  /** Stellar network passphrase used to sign transactions on this network. */
  passphrase: string;
  /**
   * Backwards-compat alias for {@link passphrase}; retained because earlier
   * call-sites referenced `networkPassphrase` directly.
   */
  networkPassphrase: string;
  /** Default streaming-contract deployment address for the network. */
  streamingContractAddress?: string;
  /** Default token contract address for the network. */
  tokenContractAddress?: string;
}

export const STELLAR_NETWORKS: Record<StellarNetwork, StellarNetworkConfig> = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    networkPassphrase: 'Test SDF Network ; September 2015',
    streamingContractAddress: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
    tokenContractAddress: 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: 'Public Global Stellar Network ; September 2015',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    streamingContractAddress: 'CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA',
    tokenContractAddress: 'CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5',
  },
  local: {
    horizonUrl: 'http://localhost:8000',
    passphrase: 'Standalone Network ; February 2017',
    networkPassphrase: 'Standalone Network ; February 2017',
  },
};

export interface ContractAddresses {
  streaming?: string;
  contract?: string;
  token?: string;
  [key: string]: string | undefined;
}

export function resolveNetwork(
  env: {
    NODE_ENV?: string;
    STELLAR_NETWORK?: StellarNetwork;
  } = process.env as { NODE_ENV?: string; STELLAR_NETWORK?: StellarNetwork }
): StellarNetwork {
  if (
    env.STELLAR_NETWORK === 'mainnet' ||
    env.STELLAR_NETWORK === 'testnet' ||
    env.STELLAR_NETWORK === 'local'
  ) {
    return env.STELLAR_NETWORK;
  }
  return env.NODE_ENV === 'production' ? 'mainnet' : 'testnet';
}

export {
  assertNetworkMatchesContracts,
  logActiveStellarConfig,
  getAddressPinnedNetwork,
  getPinnedAddressNetwork,
  isValidStellarContractAddress,
  STELLAR_CONTRACT_ALLOWLIST,
  STELLAR_NETWORK_PASSPHRASES,
  type PinnedStellarNetwork,
  type PinnedStellarAddressKind,
} from './stellarContracts.js';
/**
 * Validate the static per-network Stellar configuration (issue #1437).
 *
 * Returns one human-readable issue per invalid setting so startup can fail
 * with a precise error instead of the first Horizon/contract call blowing up
 * mid-request. Pass an override map in tests; defaults to the real networks.
 */
export function validateStellarConfig(
  networks: Record<StellarNetwork, StellarNetworkConfig> = STELLAR_NETWORKS,
): string[] {
  const issues: string[] = [];

  for (const network of Object.keys(networks) as StellarNetwork[]) {
    const cfg = networks[network];
    const prefix = `STELLAR_NETWORKS.${network}`;

    if (typeof cfg.horizonUrl !== 'string' || cfg.horizonUrl.trim() === '') {
      issues.push(`${prefix}.horizonUrl must be a non-empty string`);
    } else {
      try {
        new URL(cfg.horizonUrl);
      } catch {
        issues.push(`${prefix}.horizonUrl must be a valid URL (got "${cfg.horizonUrl}")`);
      }
    }

    if (typeof cfg.passphrase !== 'string' || cfg.passphrase.trim() === '') {
      issues.push(`${prefix}.passphrase must be a non-empty string`);
    }

    if (cfg.networkPassphrase !== cfg.passphrase) {
      issues.push(`${prefix}.networkPassphrase must match passphrase`);
    }

    for (const key of ['streamingContractAddress', 'tokenContractAddress'] as const) {
      const value = cfg[key];
      if (value !== undefined && !isValidStellarContractAddress(value)) {
        issues.push(`${prefix}.${key} must be a valid Stellar contract StrKey (got "${value}")`);
      }
    }
  }

  return issues;
}
