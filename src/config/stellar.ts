export type StellarNetwork = 'testnet' | 'mainnet';

export interface ContractAddresses {
  streaming: string;
}

interface StellarNetworkDefaults {
  horizonUrl: string;
  passphrase: string;
  streamingContractAddress: string;
}

export const STELLAR_NETWORKS: Record<StellarNetwork, StellarNetworkDefaults> = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    streamingContractAddress: 'PLACEHOLDER_TESTNET_STREAMING_CONTRACT',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: 'Public Global Stellar Network ; September 2015',
    streamingContractAddress: 'PLACEHOLDER_MAINNET_STREAMING_CONTRACT',
  },
};
