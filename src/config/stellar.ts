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
  streamingContractAddress: string;
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
    streamingContractAddress: 'CLOCALPLACEHOLDER000000000000000000000000000000000000000',
  },
};

export interface ContractAddresses {
  streaming?: string;
  contract?: string;
  token?: string;
  [key: string]: string | undefined;
}
