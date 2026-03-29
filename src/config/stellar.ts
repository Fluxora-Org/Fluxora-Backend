export type StellarNetwork = 'testnet' | 'mainnet' | 'local';

export const STELLAR_NETWORKS: Record<StellarNetwork, { horizonUrl: string; networkPassphrase: string }> = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
  local: {
    horizonUrl: 'http://localhost:8000',
    networkPassphrase: 'Standalone Network ; February 2017',
  },
};

export interface ContractAddresses {
  streaming?: string;
  [key: string]: string | undefined;
}
