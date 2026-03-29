import { Router, Request, Response } from 'express';
import { StellarRpcClient } from '../stellar/stellar-rpc-client.js';
import { StellarRpcClientConfig } from '../stellar/types.js';
import {
  RpcError,
  RpcTimeoutError,
  RpcRetryExhaustedError,
  RpcCircuitOpenError,
  RpcValidationError,
} from '../stellar/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { info, error as logError } from '../utils/logger.js';

export const stellarRouter = Router();

// Initialize StellarRpcClient with configuration from environment variables
const config: StellarRpcClientConfig = {
  endpoint: process.env.STELLAR_RPC_ENDPOINT || 'https://soroban-testnet.stellar.org',
  timeout: parseInt(process.env.STELLAR_RPC_TIMEOUT || '5000', 10),
  maxRetries: parseInt(process.env.STELLAR_RPC_MAX_RETRIES || '3', 10),
  initialBackoff: parseInt(process.env.STELLAR_RPC_INITIAL_BACKOFF || '100', 10),
  maxBackoff: parseInt(process.env.STELLAR_RPC_MAX_BACKOFF || '5000', 10),
  circuitBreakerThreshold: parseInt(process.env.STELLAR_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
  circuitBreakerRecoveryTimeout: parseInt(process.env.STELLAR_CIRCUIT_BREAKER_RECOVERY_TIMEOUT || '30000', 10),
};

const stellarClient = new StellarRpcClient(config);

/**
 * GET /api/stellar/accounts/:accountId
 * Fetch Stellar account details using StellarRpcClient
 * 
 * Demonstrates:
 * - Client initialization with environment variables
 * - Correlation ID propagation from request
 * - Request cancellation using abort signal
 * - RPC error handling with appropriate HTTP responses
 */
stellarRouter.get(
  '/accounts/:accountId',
  asyncHandler(async (req: Request, res: Response) => {
    const { accountId } = req.params;
    const correlationId = req.correlationId;

    info('Fetching Stellar account', { accountId, correlationId });

    try {
      // Create abort controller from request signal for cancellation support
      const abortController = new AbortController();
      
      // Cancel RPC request if HTTP request is aborted
      req.on('close', () => {
        if (!res.headersSent) {
          info('Request aborted by client', { accountId, correlationId });
          abortController.abort();
        }
      });

      // Call getAccount with correlation ID and abort signal
      const account = await stellarClient.getAccount(accountId, {
        correlationId,
        signal: abortController.signal,
      });

      info('Successfully fetched Stellar account', { 
        accountId, 
        correlationId,
        balanceCount: account.balances.length,
      });

      res.json({
        account,
        requestId: correlationId,
      });
    } catch (err) {
      // Handle RPC-specific errors with appropriate HTTP status codes
      if (err instanceof RpcValidationError) {
        logError('Account validation error', { accountId, correlationId, error: err.message });
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message,
            field: err.field,
            requestId: correlationId,
          },
        });
      }

      if (err instanceof RpcTimeoutError) {
        logError('Account request timeout', { accountId, correlationId });
        return res.status(504).json({
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: 'Request to Stellar RPC timed out',
            requestId: correlationId,
          },
        });
      }

      if (err instanceof RpcCircuitOpenError) {
        logError('Circuit breaker open', { accountId, correlationId });
        return res.status(503).json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Stellar RPC service is temporarily unavailable',
            requestId: correlationId,
          },
        });
      }

      if (err instanceof RpcRetryExhaustedError) {
        logError('Retry attempts exhausted', { 
          accountId, 
          correlationId, 
          attempts: err.attempts,
        });
        return res.status(502).json({
          error: {
            code: 'BAD_GATEWAY',
            message: 'Failed to reach Stellar RPC after multiple attempts',
            attempts: err.attempts,
            requestId: correlationId,
          },
        });
      }

      if (err instanceof RpcError) {
        logError('RPC error', { 
          accountId, 
          correlationId, 
          code: err.code,
          statusCode: err.statusCode,
        });
        
        // Map RPC status codes to HTTP status codes
        const httpStatus = err.statusCode || 500;
        return res.status(httpStatus).json({
          error: {
            code: err.code,
            message: err.message,
            requestId: correlationId,
          },
        });
      }

      // Re-throw unexpected errors to be handled by error middleware
      throw err;
    }
  })
);

/**
 * GET /api/stellar/health
 * Check Stellar RPC health status
 */
stellarRouter.get(
  '/health',
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;

    info('Checking Stellar RPC health', { correlationId });

    const healthResult = await stellarClient.healthCheck();

    const statusCode = healthResult.healthy ? 200 : 503;

    res.status(statusCode).json({
      ...healthResult,
      requestId: correlationId,
    });
  })
);

/**
 * GET /api/stellar/metrics
 * Get Stellar RPC client metrics
 */
stellarRouter.get(
  '/metrics',
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;

    info('Fetching Stellar RPC metrics', { correlationId });

    const metrics = stellarClient.getMetrics();

    res.json({
      metrics,
      requestId: correlationId,
    });
  })
);
