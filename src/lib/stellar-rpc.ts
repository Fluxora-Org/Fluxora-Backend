import { rpc } from 'stellar-sdk';
import { config } from '../config.js';
import { info, error, debug, warn } from '../utils/logger.js';

export interface StellarRpcClientInterface {
  getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse>;
  getHealth(): Promise<rpc.Api.GetHealthResponse>;
  withRetry<T>(fn: () => Promise<T>): Promise<T>;
  withTimeout<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
}

/**
 * Stellar RPC Client wrapper with base implementation
 */
export class StellarRpcClient implements StellarRpcClientInterface {
  private client: rpc.Server;
  private maxRetries: number;
  private retryDelay: number;
  private timeout: number;

  constructor(server?: rpc.Server) {
    this.client = server || new rpc.Server(config.stellar.rpcUrl);
    this.maxRetries = config.stellar.retry.maxRetries;
    this.retryDelay = config.stellar.retry.initialDelayMs;
    this.timeout = config.stellar.timeout;
  }

  /**
   * Get the latest ledger from the network with retries and timeout
   */
  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return this.withRetry(() => this.withTimeout(() => this.client.getLatestLedger()));
  }

  /**
   * Check the health of the RPC server with retries and timeout
   */
  async getHealth(): Promise<rpc.Api.GetHealthResponse> {
    return this.withRetry(() => this.withTimeout(() => this.client.getHealth()));
  }

  /**
   * Execute a function with a timeout
   */
  async withTimeout<T>(fn: () => Promise<T>, timeoutMs: number = config.stellar.timeout): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([fn(), timeoutPromise]);
  }

  /**
   * Execute a function with exponential backoff retries
   */
  async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = config.stellar.retry.maxRetries,
    initialDelay: number = config.stellar.retry.initialDelayMs
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = initialDelay * Math.pow(2, attempt - 1);
          debug(`Retrying Stellar RPC operation...`, { attempt, delayMs: delay });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        warn(`Stellar RPC operation failed`, {
          attempt: attempt + 1,
          maxRetries,
          error: lastError.message,
        });

        // Don't retry if it's a non-retryable error (optional: add error classification)
        if (attempt === maxRetries) {
          break;
        }
      }
    }

    throw lastError || new Error('Stellar RPC operation failed after max retries');
  }
}
