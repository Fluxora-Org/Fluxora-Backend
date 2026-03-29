import { StellarRpcClientConfig, RequestOptions, RequestContext, MetricsSnapshot } from './types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { RetryPolicy } from './retry-policy.js';
import { MetricsCollector } from './metrics-collector.js';
import { validateConfig } from './config.js';
import {
  RpcError,
  RpcTimeoutError,
  RpcRetryExhaustedError,
  RpcCircuitOpenError,
  RpcValidationError,
  RetryAttempt,
} from './errors.js';
import { randomUUID } from 'crypto';
import * as logger from '../utils/logger.js';

/**
 * StellarRpcClient provides a resilient HTTP client for Stellar RPC operations
 * with timeout enforcement, retry logic, circuit breaker protection, and metrics
 */
export class StellarRpcClient {
  private readonly config: StellarRpcClientConfig;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly retryPolicy: RetryPolicy;
  private readonly metricsCollector: MetricsCollector;

  constructor(config: StellarRpcClientConfig) {
    // Validate configuration
    validateConfig(config);

    this.config = config;
    this.circuitBreaker = new CircuitBreaker(
      config.circuitBreakerThreshold,
      config.circuitBreakerRecoveryTimeout
    );
    this.retryPolicy = new RetryPolicy(
      config.maxRetries,
      config.initialBackoff,
      config.maxBackoff
    );
    this.metricsCollector = new MetricsCollector();
  }

  /**
   * Executes an HTTP request with timeout enforcement, retry logic, and circuit breaker protection
   * @param method - RPC method name
   * @param params - RPC method parameters
   * @param options - Request options including signal and correlationId
   * @returns Promise resolving to the RPC response
   */
  private async executeRequest<T>(
    method: string,
    params: unknown,
    options?: RequestOptions
  ): Promise<T> {
    // Generate correlation ID if not provided
    const correlationId = options?.correlationId || randomUUID();

    // Check circuit breaker state
    if (!this.circuitBreaker.canExecute()) {
      // Log circuit breaker rejection
      logger.error('Request rejected by circuit breaker', {
        correlationId,
        method,
        endpoint: this.config.endpoint,
        circuitState: this.circuitBreaker.getState(),
      });

      // Record metrics for circuit open rejection
      this.metricsCollector.recordRequest();
      const errorType = 'circuit_open';
      this.metricsCollector.recordFailure(errorType, 0);
      
      throw new RpcCircuitOpenError(
        'Circuit breaker is open, request rejected',
        correlationId
      );
    }

    // Create request context
    const context: RequestContext = {
      correlationId,
      method,
      endpoint: this.config.endpoint,
      startTime: Date.now(),
      attempt: 0,
      signal: options?.signal,
    };

    // Log request initiation
    logger.info('RPC request initiated', {
      correlationId: context.correlationId,
      method: context.method,
      endpoint: context.endpoint,
    });

    // Record request initiation
    this.metricsCollector.recordRequest();

    // Track retry history
    const retryHistory: RetryAttempt[] = [];

    // Execute with retry logic
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      context.attempt = attempt;

      try {
        // Execute HTTP request with timeout
        const response = await this.executeHttpRequest<T>(method, params, context);

        // Record success
        const latency = Date.now() - context.startTime;
        this.metricsCollector.recordSuccess(latency);
        this.circuitBreaker.recordSuccess();

        // Log successful request
        logger.info('RPC request completed successfully', {
          correlationId: context.correlationId,
          method: context.method,
          endpoint: context.endpoint,
          duration: latency,
          statusCode: 200,
        });

        return response;
      } catch (error) {
        lastError = error as Error;
        const latency = Date.now() - context.startTime;

        // Check if we should retry
        const shouldRetry = attempt < this.config.maxRetries && this.retryPolicy.shouldRetry(attempt, lastError);

        if (shouldRetry) {
          // Calculate backoff delay
          const backoffDelay = this.retryPolicy.getBackoffDelay(attempt);

          // Record retry attempt in history
          retryHistory.push({
            attempt,
            error: lastError,
            timestamp: Date.now(),
            backoffDelay,
          });

          // Record retry attempt in metrics
          this.metricsCollector.recordRetry();

          // Log retry attempt
          logger.debug('Retrying RPC request', {
            correlationId: context.correlationId,
            method: context.method,
            endpoint: context.endpoint,
            attempt: attempt + 1,
            backoffDelay,
            errorType: this.getErrorType(lastError),
          });

          // Wait before retrying
          await this.sleep(backoffDelay);

          // Continue to next attempt
          continue;
        }

        // No more retries, record failure
        const errorType = this.getErrorType(lastError);
        this.metricsCollector.recordFailure(errorType, latency);
        this.circuitBreaker.recordFailure();

        // Determine if error is transient or permanent
        const isTransient = this.retryPolicy.shouldRetry(0, lastError);
        const logLevel = isTransient ? 'warn' : 'error';

        // Log failure
        const logContext = {
          correlationId: context.correlationId,
          method: context.method,
          endpoint: context.endpoint,
          errorType,
          statusCode: lastError instanceof RpcError ? lastError.statusCode : undefined,
          duration: latency,
        };

        if (logLevel === 'error') {
          logger.error('RPC request failed with permanent error', logContext, lastError);
        } else {
          logger.warn('RPC request failed with transient error', logContext);
        }

        // If we exhausted retries (had at least one retry), throw retry exhausted error
        if (retryHistory.length > 0) {
          throw new RpcRetryExhaustedError(
            `Request failed after ${attempt + 1} attempts`,
            attempt + 1,
            lastError,
            retryHistory,
            correlationId
          );
        }

        // Otherwise, throw the original error (permanent error, no retries)
        throw lastError;
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError || new RpcError('Unknown error', 'UNKNOWN', undefined, correlationId);
  }

  /**
   * Executes a single HTTP request with timeout enforcement
   * @param method - RPC method name
   * @param params - RPC method parameters
   * @param context - Request context
   * @returns Promise resolving to the RPC response
   */
  private async executeHttpRequest<T>(
    method: string,
    params: unknown,
    context: RequestContext
  ): Promise<T> {
    // Create AbortController for timeout
    const abortController = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;

    try {
      // Set up timeout
      timeoutId = setTimeout(() => {
        abortController.abort();
      }, this.config.timeout);

      // Combine timeout signal with user-provided signal
      const signal = context.signal
        ? this.combineAbortSignals([abortController.signal, context.signal])
        : abortController.signal;

      // Execute HTTP request
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: context.correlationId,
          method,
          params,
        }),
        signal,
      });

      // Clear timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // Parse response
      const data = await response.json();

      // Check for RPC error in response
      if (data.error) {
        throw new RpcError(
          data.error.message || 'RPC error',
          data.error.code || 'RPC_ERROR',
          response.status,
          context.correlationId
        );
      }

      return data.result as T;
    } catch (error) {
      // Clear timeout if still active
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        const elapsed = Date.now() - context.startTime;
        
        // Log timeout event
        logger.error('RPC request timed out', {
          correlationId: context.correlationId,
          method: context.method,
          endpoint: context.endpoint,
          elapsed,
          timeout: this.config.timeout,
        });

        throw new RpcTimeoutError(
          `Request timed out after ${this.config.timeout}ms`,
          context.correlationId
        );
      }

      // Handle DOMException with AbortError
      if (error instanceof DOMException && error.name === 'AbortError') {
        const elapsed = Date.now() - context.startTime;
        
        // Log timeout event
        logger.error('RPC request timed out', {
          correlationId: context.correlationId,
          method: context.method,
          endpoint: context.endpoint,
          elapsed,
          timeout: this.config.timeout,
        });

        throw new RpcTimeoutError(
          `Request timed out after ${this.config.timeout}ms`,
          context.correlationId
        );
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Combines multiple AbortSignals into a single signal
   * @param signals - Array of AbortSignals to combine
   * @returns Combined AbortSignal
   */
  private combineAbortSignals(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        break;
      }

      signal.addEventListener('abort', () => {
        controller.abort();
      });
    }

    return controller.signal;
  }

  /**
   * Sleep for specified duration
   * @param ms - Duration in milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get error type string for metrics
   * @param error - Error object
   * @returns Error type string
   */
  private getErrorType(error: Error): string {
    if (error instanceof RpcTimeoutError) {
      return 'timeout';
    }
    if (error instanceof RpcCircuitOpenError) {
      return 'circuit_open';
    }
    if (error instanceof RpcError) {
      return error.code;
    }
    return error.name || 'unknown';
  }

  /**
   * Validates Stellar account ID format
   * @param accountId - Account ID to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if accountId is invalid
   */
  private validateAccountId(accountId: string, correlationId?: string): void {
    // Stellar account IDs are 56 characters long and start with 'G'
    if (!accountId || typeof accountId !== 'string') {
      throw new RpcValidationError(
        'accountId must be a non-empty string',
        'accountId',
        correlationId
      );
    }

    if (accountId.length !== 56) {
      throw new RpcValidationError(
        'accountId must be 56 characters long',
        'accountId',
        correlationId
      );
    }

    if (!accountId.startsWith('G')) {
      throw new RpcValidationError(
        'accountId must start with G',
        'accountId',
        correlationId
      );
    }

    // Validate base32 characters (A-Z and 2-7)
    const base32Regex = /^[A-Z2-7]+$/;
    if (!base32Regex.test(accountId)) {
      throw new RpcValidationError(
        'accountId must contain only valid base32 characters (A-Z, 2-7)',
        'accountId',
        correlationId
      );
    }
  }

  /**
   * Validates AccountResponse structure and required fields
   * @param response - Response object to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if response is invalid
   */
  private validateAccountResponse(response: unknown, correlationId?: string): void {
    if (!response || typeof response !== 'object') {
      throw new RpcValidationError(
        'Response must be an object',
        'response',
        correlationId
      );
    }

    const resp = response as Record<string, unknown>;

    // Validate required field: id
    if (!resp.id || typeof resp.id !== 'string') {
      throw new RpcValidationError(
        'Response must contain id field as string',
        'id',
        correlationId
      );
    }

    // Validate required field: sequence
    if (!resp.sequence || typeof resp.sequence !== 'string') {
      throw new RpcValidationError(
        'Response must contain sequence field as string',
        'sequence',
        correlationId
      );
    }

    // Validate required field: balances
    if (!Array.isArray(resp.balances)) {
      throw new RpcValidationError(
        'Response must contain balances field as array',
        'balances',
        correlationId
      );
    }

    // Validate each balance entry
    for (const balance of resp.balances) {
      if (!balance || typeof balance !== 'object') {
        throw new RpcValidationError(
          'Each balance must be an object',
          'balances',
          correlationId
        );
      }

      const bal = balance as Record<string, unknown>;

      if (!bal.asset || typeof bal.asset !== 'string') {
        throw new RpcValidationError(
          'Each balance must contain asset field as string',
          'balances.asset',
          correlationId
        );
      }

      if (!bal.amount || typeof bal.amount !== 'string') {
        throw new RpcValidationError(
          'Each balance must contain amount field as string',
          'balances.amount',
          correlationId
        );
      }
    }
  }

  /**
   * Fetches account details by account ID
   * @param accountId - Stellar account ID (56-character string starting with 'G')
   * @param options - Optional request options including signal and correlationId
   * @returns Promise resolving to AccountResponse with account details
   * @throws RpcValidationError if accountId is invalid
   * @throws RpcTimeoutError if request times out
   * @throws RpcRetryExhaustedError if retries are exhausted
   * @throws RpcCircuitOpenError if circuit breaker is open
   * @throws RpcError for other RPC errors
   */
  async getAccount(accountId: string, options?: RequestOptions): Promise<import('./types.js').AccountResponse> {
    // Validate accountId format
    this.validateAccountId(accountId, options?.correlationId);

    // Build RPC request payload
    const params = { accountId };

    // Execute request with timeout and retry policies
    const response = await this.executeRequest<unknown>('getAccount', params, options);

    // Validate response structure
    this.validateAccountResponse(response, options?.correlationId);

    // Return typed response (already validated)
    return response as import('./types.js').AccountResponse;
  }

  /**
   * Validates transaction hash format
   * @param txHash - Transaction hash to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if txHash is invalid
   */
  private validateTxHash(txHash: string, correlationId?: string): void {
    // Transaction hashes are 64 hex characters
    if (!txHash || typeof txHash !== 'string') {
      throw new RpcValidationError(
        'txHash must be a non-empty string',
        'txHash',
        correlationId
      );
    }

    if (txHash.length !== 64) {
      throw new RpcValidationError(
        'txHash must be 64 characters long',
        'txHash',
        correlationId
      );
    }

    // Validate hex characters (0-9, a-f, A-F)
    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(txHash)) {
      throw new RpcValidationError(
        'txHash must contain only valid hexadecimal characters (0-9, a-f, A-F)',
        'txHash',
        correlationId
      );
    }
  }

  /**
   * Validates TransactionResponse structure and required fields
   * @param response - Response object to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if response is invalid
   */
  private validateTransactionResponse(response: unknown, correlationId?: string): void {
    if (!response || typeof response !== 'object') {
      throw new RpcValidationError(
        'Response must be an object',
        'response',
        correlationId
      );
    }

    const resp = response as Record<string, unknown>;

    // Validate required field: hash
    if (!resp.hash || typeof resp.hash !== 'string') {
      throw new RpcValidationError(
        'Response must contain hash field as string',
        'hash',
        correlationId
      );
    }

    // Validate required field: ledger
    if (typeof resp.ledger !== 'number') {
      throw new RpcValidationError(
        'Response must contain ledger field as number',
        'ledger',
        correlationId
      );
    }

    // Validate required field: status
    if (!resp.status || typeof resp.status !== 'string') {
      throw new RpcValidationError(
        'Response must contain status field as string',
        'status',
        correlationId
      );
    }

    // Validate status is one of the allowed values
    if (resp.status !== 'SUCCESS' && resp.status !== 'FAILED') {
      throw new RpcValidationError(
        'Response status must be either SUCCESS or FAILED',
        'status',
        correlationId
      );
    }
  }

  /**
   * Fetches transaction details by transaction hash
   * @param txHash - Transaction hash (64-character hexadecimal string)
   * @param options - Optional request options including signal and correlationId
   * @returns Promise resolving to TransactionResponse with transaction details
   * @throws RpcValidationError if txHash is invalid
   * @throws RpcTimeoutError if request times out
   * @throws RpcRetryExhaustedError if retries are exhausted
   * @throws RpcCircuitOpenError if circuit breaker is open
   * @throws RpcError for other RPC errors
   */
  async getTransaction(txHash: string, options?: RequestOptions): Promise<import('./types.js').TransactionResponse> {
    // Validate txHash format
    this.validateTxHash(txHash, options?.correlationId);

    // Build RPC request payload
    const params = { txHash };

    // Execute request with timeout and retry policies
    const response = await this.executeRequest<unknown>('getTransaction', params, options);

    // Validate response structure
    this.validateTransactionResponse(response, options?.correlationId);

    // Return typed response (already validated)
    return response as import('./types.js').TransactionResponse;
  }

  /**
   * Validates signed transaction format
   * @param signedTx - Signed transaction to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if signedTx is invalid
   */
  private validateSignedTx(signedTx: string, correlationId?: string): void {
    if (!signedTx || typeof signedTx !== 'string') {
      throw new RpcValidationError(
        'signedTx must be a non-empty string',
        'signedTx',
        correlationId
      );
    }

    if (signedTx.trim().length === 0) {
      throw new RpcValidationError(
        'signedTx must be a non-empty string',
        'signedTx',
        correlationId
      );
    }
  }

  /**
   * Validates SubmitResponse structure and required fields
   * @param response - Response object to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if response is invalid
   */
  private validateSubmitResponse(response: unknown, correlationId?: string): void {
    if (!response || typeof response !== 'object') {
      throw new RpcValidationError(
        'Response must be an object',
        'response',
        correlationId
      );
    }

    const resp = response as Record<string, unknown>;

    // Validate required field: hash
    if (!resp.hash || typeof resp.hash !== 'string') {
      throw new RpcValidationError(
        'Response must contain hash field as string',
        'hash',
        correlationId
      );
    }

    // Validate required field: status
    if (!resp.status || typeof resp.status !== 'string') {
      throw new RpcValidationError(
        'Response must contain status field as string',
        'status',
        correlationId
      );
    }

    // Validate status is one of the allowed values
    if (resp.status !== 'PENDING' && resp.status !== 'DUPLICATE' && resp.status !== 'ERROR') {
      throw new RpcValidationError(
        'Response status must be either PENDING, DUPLICATE, or ERROR',
        'status',
        correlationId
      );
    }
  }

  /**
   * Submits a signed transaction to the Stellar network
   * @param signedTx - Signed transaction as a string
   * @param options - Optional request options including signal and correlationId
   * @returns Promise resolving to SubmitResponse with transaction hash and status
   * @throws RpcValidationError if signedTx is invalid
   * @throws RpcTimeoutError if request times out
   * @throws RpcRetryExhaustedError if retries are exhausted
   * @throws RpcCircuitOpenError if circuit breaker is open
   * @throws RpcError for other RPC errors
   */
  async submitTransaction(signedTx: string, options?: RequestOptions): Promise<import('./types.js').SubmitResponse> {
    // Validate signedTx is non-empty string
    this.validateSignedTx(signedTx, options?.correlationId);

    // Build RPC request payload
    const params = { signedTx };

    // Call executeRequest with timeout and retry policies
    const response = await this.executeRequest<unknown>('submitTransaction', params, options);

    // Parse response JSON into SubmitResponse type and validate
    this.validateSubmitResponse(response, options?.correlationId);

    // Return typed response (already validated)
    return response as import('./types.js').SubmitResponse;
  }

  /**
   * Validates ledger sequence parameter
   * @param sequence - Ledger sequence to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if sequence is invalid
   */
  private validateSequence(sequence: number, correlationId?: string): void {
    if (typeof sequence !== 'number') {
      throw new RpcValidationError(
        'sequence must be a number',
        'sequence',
        correlationId
      );
    }

    if (!Number.isInteger(sequence)) {
      throw new RpcValidationError(
        'sequence must be an integer',
        'sequence',
        correlationId
      );
    }

    if (sequence <= 0) {
      throw new RpcValidationError(
        'sequence must be a positive integer',
        'sequence',
        correlationId
      );
    }
  }

  /**
   * Validates LedgerResponse structure and required fields
   * @param response - Response object to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if response is invalid
   */
  private validateLedgerResponse(response: unknown, correlationId?: string): void {
    if (!response || typeof response !== 'object') {
      throw new RpcValidationError(
        'Response must be an object',
        'response',
        correlationId
      );
    }

    const resp = response as Record<string, unknown>;

    // Validate required field: sequence
    if (typeof resp.sequence !== 'number') {
      throw new RpcValidationError(
        'Response must contain sequence field as number',
        'sequence',
        correlationId
      );
    }

    // Validate required field: hash
    if (!resp.hash || typeof resp.hash !== 'string') {
      throw new RpcValidationError(
        'Response must contain hash field as string',
        'hash',
        correlationId
      );
    }

    // Validate required field: transactionCount
    if (typeof resp.transactionCount !== 'number') {
      throw new RpcValidationError(
        'Response must contain transactionCount field as number',
        'transactionCount',
        correlationId
      );
    }
  }

  /**
   * Fetches ledger details by ledger sequence
   * @param sequence - Ledger sequence number (positive integer)
   * @param options - Optional request options including signal and correlationId
   * @returns Promise resolving to LedgerResponse with ledger details
   * @throws RpcValidationError if sequence is invalid
   * @throws RpcTimeoutError if request times out
   * @throws RpcRetryExhaustedError if retries are exhausted
   * @throws RpcCircuitOpenError if circuit breaker is open
   * @throws RpcError for other RPC errors
   */
  async getLedger(sequence: number, options?: RequestOptions): Promise<import('./types.js').LedgerResponse> {
    // Validate sequence is positive integer
    this.validateSequence(sequence, options?.correlationId);

    // Build RPC request payload
    const params = { sequence };

    // Call executeRequest with timeout and retry policies
    const response = await this.executeRequest<unknown>('getLedger', params, options);

    // Parse response JSON into LedgerResponse type and validate
    this.validateLedgerResponse(response, options?.correlationId);

    // Return typed response (already validated)
    return response as import('./types.js').LedgerResponse;
  }

  /**
   * Validates EventFilters parameters
   * @param filters - Event filters to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if filters are invalid
   */
  private validateEventFilters(filters: import('./types.js').EventFilters, correlationId?: string): void {
    if (!filters || typeof filters !== 'object') {
      throw new RpcValidationError(
        'filters must be an object',
        'filters',
        correlationId
      );
    }

    // Validate startLedger if provided
    if (filters.startLedger !== undefined) {
      if (typeof filters.startLedger !== 'number') {
        throw new RpcValidationError(
          'startLedger must be a number',
          'startLedger',
          correlationId
        );
      }

      if (!Number.isInteger(filters.startLedger)) {
        throw new RpcValidationError(
          'startLedger must be an integer',
          'startLedger',
          correlationId
        );
      }

      if (filters.startLedger <= 0) {
        throw new RpcValidationError(
          'startLedger must be a positive integer',
          'startLedger',
          correlationId
        );
      }
    }

    // Validate endLedger if provided
    if (filters.endLedger !== undefined) {
      if (typeof filters.endLedger !== 'number') {
        throw new RpcValidationError(
          'endLedger must be a number',
          'endLedger',
          correlationId
        );
      }

      if (!Number.isInteger(filters.endLedger)) {
        throw new RpcValidationError(
          'endLedger must be an integer',
          'endLedger',
          correlationId
        );
      }

      if (filters.endLedger <= 0) {
        throw new RpcValidationError(
          'endLedger must be a positive integer',
          'endLedger',
          correlationId
        );
      }
    }

    // Validate startLedger <= endLedger if both provided
    if (filters.startLedger !== undefined && filters.endLedger !== undefined) {
      if (filters.startLedger > filters.endLedger) {
        throw new RpcValidationError(
          'startLedger must be less than or equal to endLedger',
          'startLedger',
          correlationId
        );
      }
    }

    // Validate contractId if provided
    if (filters.contractId !== undefined) {
      if (typeof filters.contractId !== 'string' || filters.contractId.trim().length === 0) {
        throw new RpcValidationError(
          'contractId must be a non-empty string',
          'contractId',
          correlationId
        );
      }
    }

    // Validate topics if provided
    if (filters.topics !== undefined) {
      if (!Array.isArray(filters.topics)) {
        throw new RpcValidationError(
          'topics must be an array',
          'topics',
          correlationId
        );
      }

      for (const topic of filters.topics) {
        if (typeof topic !== 'string') {
          throw new RpcValidationError(
            'Each topic must be a string',
            'topics',
            correlationId
          );
        }
      }
    }
  }

  /**
   * Validates EventsResponse structure and required fields
   * @param response - Response object to validate
   * @param correlationId - Optional correlation ID for error tracking
   * @throws RpcValidationError if response is invalid
   */
  private validateEventsResponse(response: unknown, correlationId?: string): void {
    if (!response || typeof response !== 'object') {
      throw new RpcValidationError(
        'Response must be an object',
        'response',
        correlationId
      );
    }

    const resp = response as Record<string, unknown>;

    // Validate required field: events
    if (!Array.isArray(resp.events)) {
      throw new RpcValidationError(
        'Response must contain events field as array',
        'events',
        correlationId
      );
    }

    // Validate required field: latestLedger
    if (typeof resp.latestLedger !== 'number') {
      throw new RpcValidationError(
        'Response must contain latestLedger field as number',
        'latestLedger',
        correlationId
      );
    }
  }

  /**
   * Fetches contract event logs based on filters
   * @param filters - Event filters including contractId, topics, startLedger, endLedger
   * @param options - Optional request options including signal and correlationId
   * @returns Promise resolving to EventsResponse with events and latestLedger
   * @throws RpcValidationError if filters are invalid
   * @throws RpcTimeoutError if request times out
   * @throws RpcRetryExhaustedError if retries are exhausted
   * @throws RpcCircuitOpenError if circuit breaker is open
   * @throws RpcError for other RPC errors
   */
  async getEvents(filters: import('./types.js').EventFilters, options?: RequestOptions): Promise<import('./types.js').EventsResponse> {
    // Validate filter parameters
    this.validateEventFilters(filters, options?.correlationId);

    // Build RPC request payload
    const params = { filters };

    // Call executeRequest with timeout and retry policies
    const response = await this.executeRequest<unknown>('getEvents', params, options);

    // Parse response JSON into EventsResponse type and validate
    this.validateEventsResponse(response, options?.correlationId);

    // Return typed response (already validated)
    return response as import('./types.js').EventsResponse;
  }

  /**
   * Performs a health check by sending a lightweight RPC request
   * Health check failures do not count toward circuit breaker threshold
   * @returns Promise resolving to HealthCheckResult with health status, response time, and circuit state
   */
  async healthCheck(): Promise<import('./types.js').HealthCheckResult> {
    const startTime = Date.now();
    const correlationId = randomUUID();

    // Log health check initiation
    logger.info('Health check initiated', {
      correlationId,
      endpoint: this.config.endpoint,
    });

    try {
      // Send lightweight RPC request (getLedger with sequence 1)
      // We use a direct HTTP request to avoid circuit breaker and retry logic
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, this.config.timeout);

      try {
        const response = await fetch(this.config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: correlationId,
            method: 'getLedger',
            params: { sequence: 1 },
          }),
          signal: abortController.signal,
        });

        clearTimeout(timeoutId);

        // Calculate response time
        const responseTime = Date.now() - startTime;

        // Check if response is successful
        if (!response.ok) {
          const errorMessage = `Health check failed with status ${response.status}`;
          
          // Log unhealthy result
          logger.info('Health check completed - unhealthy', {
            correlationId,
            endpoint: this.config.endpoint,
            responseTime,
            statusCode: response.status,
            circuitState: this.circuitBreaker.getState(),
          });

          return {
            healthy: false,
            responseTime,
            circuitState: this.circuitBreaker.getState(),
            error: errorMessage,
          };
        }

        // Parse response to verify it's valid JSON
        await response.json();

        // Log healthy result
        logger.info('Health check completed - healthy', {
          correlationId,
          endpoint: this.config.endpoint,
          responseTime,
          statusCode: response.status,
          circuitState: this.circuitBreaker.getState(),
        });

        return {
          healthy: true,
          responseTime,
          circuitState: this.circuitBreaker.getState(),
        };
      } catch (error) {
        clearTimeout(timeoutId);

        // Calculate response time
        const responseTime = Date.now() - startTime;

        // Handle timeout or other errors
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Log unhealthy result
        logger.info('Health check completed - unhealthy', {
          correlationId,
          endpoint: this.config.endpoint,
          responseTime,
          error: errorMessage,
          circuitState: this.circuitBreaker.getState(),
        });

        return {
          healthy: false,
          responseTime,
          circuitState: this.circuitBreaker.getState(),
          error: errorMessage,
        };
      }
    } catch (error) {
      // Calculate response time
      const responseTime = Date.now() - startTime;

      // Handle unexpected errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Log unhealthy result
      logger.info('Health check completed - unhealthy', {
        correlationId,
        endpoint: this.config.endpoint,
        responseTime,
        error: errorMessage,
        circuitState: this.circuitBreaker.getState(),
      });

      return {
        healthy: false,
        responseTime,
        circuitState: this.circuitBreaker.getState(),
        error: errorMessage,
      };
    }
  }

  /**
   * Get current metrics snapshot
   * @returns MetricsSnapshot with current metrics
   */
  getMetrics(): MetricsSnapshot {
    return this.metricsCollector.getSnapshot(
      this.circuitBreaker.getState(),
      this.circuitBreaker.getConsecutiveFailures()
    );
  }

  /**
   * Reset all metrics counters
   */
  resetMetrics(): void {
    this.metricsCollector.reset();
  }
}
