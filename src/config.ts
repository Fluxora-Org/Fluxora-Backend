/**
 * Application Configuration
 */

export const config = {
  stellar: {
    rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    timeout: parseInt(process.env.STELLAR_RPC_TIMEOUT || '10000', 10),
    retry: {
      maxRetries: parseInt(process.env.STELLAR_RPC_MAX_RETRIES || '3', 10),
      initialDelayMs: parseInt(process.env.STELLAR_RPC_RETRY_DELAY || '1000', 10),
    },
  },
};
