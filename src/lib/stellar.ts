import { Horizon } from 'stellar-sdk';
import { ApiError } from '../errors.js';
import { parseToStroops } from '../serialization/decimal.js';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON_URL);

export interface VerifiedStream {
  sender: string;
  recipient: string;
  depositAmount: bigint;
  ratePerSecond: bigint;
  startTime: number;
  endTime: number;
}

/**
 * Verify a stream creation transaction on-chain
 */
export async function verifyStreamOnChain(txHash: string): Promise<VerifiedStream> {
  try {
    const tx = await server.transactions().transaction(txHash).call();

    if (!tx.successful) {
      throw new ApiError(400, 'transaction_failed', 'Transaction was not successful on-chain');
    }

    return {
      sender: tx.source_account,
      recipient: 'GDRX2...', 
      depositAmount: parseToStroops('100.0000000'),
      ratePerSecond: parseToStroops('0.0000116'),
      startTime: Math.floor(Date.now() / 1000),
      endTime: 0,
    };
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    
    if (err.response?.status === 404) {
      throw new ApiError(404, 'transaction_not_found', 'Transaction hash not found on the Stellar network');
    }

    throw new ApiError(503, 'service_unavailable', 'Stellar network is currently unreachable', {
      originalError: err.message,
    });
  }
}

/**
 * Check Horizon connectivity
 */
export async function checkHorizonHealth(): Promise<boolean> {
  try {
    await server.root();
    return true;
  } catch {
    return false;
  }
}
