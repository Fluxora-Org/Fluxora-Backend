# Implementation Plan: Stellar RPC Client Wrapper

## Overview

This implementation plan breaks down the Stellar RPC Client Wrapper into discrete, testable tasks. The wrapper provides resilient HTTP communication with Stellar RPC nodes using TypeScript, implementing timeouts, exponential backoff retries, circuit breaker protection, and comprehensive logging. Each task builds incrementally, validating core functionality early through automated tests.

## Tasks

- [x] 1. Set up project structure and core types
  - Create `src/stellar/` directory for RPC client components
  - Define configuration interfaces and validation types
  - Define error class hierarchy (RpcError, RpcTimeoutError, RpcRetryExhaustedError, RpcCircuitOpenError, RpcValidationError)
  - Define Stellar RPC request/response types (AccountResponse, TransactionResponse, SubmitResponse, LedgerResponse, EventsResponse)
  - Define internal types (RequestContext, RequestOptions, MetricsSnapshot)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 9.7, 10.2_

- [x] 2. Implement configuration validation
  - [x] 2.1 Create StellarRpcClientConfig interface and validation logic
    - Implement validateConfig function that checks all configuration constraints
    - Validate timeout is positive integer
    - Validate maxRetries is non-negative integer
    - Validate backoff delays are positive integers and maxBackoff >= initialBackoff
    - Validate circuit breaker parameters are positive integers
    - Throw descriptive configuration errors on validation failure
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_
  
  - [ ]* 2.2 Write unit tests for configuration validation
    - Test valid configuration acceptance
    - Test invalid timeout rejection
    - Test invalid retry parameters rejection
    - Test invalid backoff parameters rejection
    - Test maxBackoff < initialBackoff rejection
    - Test descriptive error messages
    - _Requirements: 1.6, 1.7, 1.8, 1.9_

- [x] 3. Implement RetryPolicy class
  - [x] 3.1 Create RetryPolicy with exponential backoff logic
    - Implement shouldRetry method that classifies errors as transient or permanent
    - Classify HTTP 408, 429, 500, 502, 503, 504 as transient
    - Classify HTTP 400, 401, 403, 404, 405, 422 as permanent
    - Classify network timeouts (ETIMEDOUT) and connection refused (ECONNREFUSED) as transient
    - Classify JSON parsing and validation errors as permanent
    - Implement getBackoffDelay with formula: min(initialBackoff * (2^attempt), maxBackoff) + jitter
    - Add random jitter between 0 and 20% of calculated delay
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3, 4.4_
  
  - [ ]* 3.2 Write unit tests for RetryPolicy
    - Test transient error classification
    - Test permanent error classification
    - Test backoff delay calculation
    - Test jitter is within 0-20% range
    - Test maxBackoff ceiling enforcement
    - Test shouldRetry respects maxRetries limit
    - _Requirements: 3.3, 3.4, 3.6, 3.7, 3.8, 4.2_

- [x] 4. Implement CircuitBreaker class
  - [x] 4.1 Create CircuitBreaker state machine
    - Implement state transitions: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
    - Implement canExecute method that checks current state and recovery timeout
    - Implement recordSuccess method that resets failure count and transitions to CLOSED
    - Implement recordFailure method that increments counter and transitions to OPEN when threshold exceeded
    - Track lastFailureTime for recovery timeout calculation
    - Implement getState method for observability
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.10_
  
  - [ ]* 4.2 Write unit tests for CircuitBreaker
    - Test initial state is CLOSED
    - Test transition to OPEN after threshold failures
    - Test requests rejected in OPEN state
    - Test transition to HALF_OPEN after recovery timeout
    - Test single probe allowed in HALF_OPEN state
    - Test transition to CLOSED on probe success
    - Test transition back to OPEN on probe failure
    - Test failure count reset on CLOSED transition
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.10_

- [x] 5. Implement MetricsCollector class
  - [x] 5.1 Create MetricsCollector with counters and histogram
    - Implement recordRequest, recordSuccess, recordFailure, recordRetry methods
    - Maintain counters for total requests, successful requests, failed requests by type, retry attempts
    - Implement latency histogram with p50, p95, p99, max percentiles
    - Implement getSnapshot method that returns MetricsSnapshot
    - Implement reset method that clears all counters
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.9, 8.10_
  
  - [ ]* 5.2 Write unit tests for MetricsCollector
    - Test counter increments
    - Test latency histogram calculation
    - Test snapshot includes all metrics
    - Test reset clears counters
    - Test percentile calculations
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.9_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement core StellarRpcClient class
  - [x] 7.1 Create StellarRpcClient with HTTP request execution
    - Implement constructor that accepts StellarRpcClientConfig and initializes components
    - Create private executeRequest method that handles HTTP calls with timeout enforcement
    - Implement timeout using AbortController and setTimeout
    - Integrate CircuitBreaker check before request execution
    - Integrate RetryPolicy for retry logic on transient failures
    - Implement request cancellation via AbortSignal
    - Generate correlation IDs for requests without one
    - Create RequestContext for each request
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 5.2, 5.3, 5.4, 11.1, 11.2_
  
  - [x] 7.2 Implement error handling and classification
    - Throw RpcTimeoutError when timeout expires
    - Throw RpcCircuitOpenError when circuit breaker is open
    - Throw RpcRetryExhaustedError when max retries exceeded
    - Include retry history in RpcRetryExhaustedError
    - Classify errors using RetryPolicy
    - Fail fast on permanent errors without retry
    - Update CircuitBreaker state on success/failure
    - Update MetricsCollector on each request outcome
    - _Requirements: 2.3, 2.5, 3.5, 3.10, 4.1, 4.5, 4.6, 5.3, 5.4, 10.1, 10.2, 10.3, 10.4, 10.5_
  
  - [ ]* 7.3 Write unit tests for StellarRpcClient core logic
    - Test successful request execution
    - Test timeout enforcement
    - Test retry on transient errors
    - Test fail fast on permanent errors
    - Test circuit breaker integration
    - Test request cancellation via AbortSignal
    - Test correlation ID propagation
    - Test metrics recording
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 4.1, 5.3, 11.1, 11.2, 11.3_

- [-] 8. Implement logging integration
  - [x] 8.1 Add structured logging to StellarRpcClient
    - Log request initiation with correlation ID, method, endpoint (INFO level)
    - Log successful requests with correlation ID, duration, status code (INFO level)
    - Log failures with correlation ID, error type, status code, duration (ERROR level for permanent, WARN for transient)
    - Log retry attempts with correlation ID, attempt number, backoff delay (DEBUG level)
    - Log circuit breaker state transitions with previous state, new state, reason (WARN level)
    - Log timeout events with correlation ID and elapsed time (ERROR level)
    - Include RequestContext in all log entries
    - Use existing logger utility from src/utils/logger.ts
    - _Requirements: 2.5, 2.6, 3.9, 4.5, 5.9, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 10.8_
  
  - [ ]* 8.2 Write unit tests for logging integration
    - Test request logging includes correlation ID
    - Test success logging includes duration
    - Test failure logging includes error details
    - Test retry logging includes attempt number
    - Test circuit breaker logging includes state transition
    - Test log levels are correct for each event type
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.9, 7.10, 7.11, 7.12_

- [~] 9. Implement Stellar-specific RPC methods
  - [x] 9.1 Implement getAccount method
    - Accept accountId parameter and optional RequestOptions
    - Validate accountId format (Stellar address)
    - Build RPC request payload
    - Call executeRequest with timeout and retry policies
    - Parse response JSON into AccountResponse type
    - Validate response contains required fields (id, sequence, balances)
    - Preserve numeric precision using decimal strings
    - _Requirements: 9.1, 9.6, 9.7, 9.9, 9.10, 12.1, 12.2, 12.5_
  
  - [x] 9.2 Implement getTransaction method
    - Accept txHash parameter and optional RequestOptions
    - Validate txHash format
    - Build RPC request payload
    - Call executeRequest with timeout and retry policies
    - Parse response JSON into TransactionResponse type
    - Validate response contains required fields (hash, ledger, status)
    - _Requirements: 9.2, 9.6, 9.7, 9.9, 9.10, 12.1, 12.2, 12.6_
  
  - [x] 9.3 Implement submitTransaction method
    - Accept signedTx parameter and optional RequestOptions
    - Validate signedTx is non-empty string
    - Build RPC request payload
    - Call executeRequest with timeout and retry policies
    - Parse response JSON into SubmitResponse type
    - Validate response contains required fields (hash, status)
    - Extract and throw RPC error if response contains error field
    - _Requirements: 9.3, 9.6, 9.7, 9.9, 9.10, 12.1, 12.2, 12.3_
  
  - [x] 9.4 Implement getLedger method
    - Accept sequence parameter and optional RequestOptions
    - Validate sequence is positive integer
    - Build RPC request payload
    - Call executeRequest with timeout and retry policies
    - Parse response JSON into LedgerResponse type
    - Validate response contains required fields (sequence, hash, transactionCount)
    - _Requirements: 9.4, 9.6, 9.7, 9.9, 9.10, 12.1, 12.2_
  
  - [x] 9.5 Implement getEvents method
    - Accept EventFilters parameter and optional RequestOptions
    - Validate filter parameters (startLedger <= endLedger if both provided)
    - Build RPC request payload
    - Call executeRequest with timeout and retry policies
    - Parse response JSON into EventsResponse type
    - Validate response contains required fields (events, latestLedger)
    - _Requirements: 9.5, 9.6, 9.7, 9.9, 9.10, 12.1, 12.2, 12.4_
  
  - [ ]* 9.6 Write unit tests for Stellar RPC methods
    - Test getAccount with valid account ID
    - Test getTransaction with valid transaction hash
    - Test submitTransaction with valid signed transaction
    - Test getLedger with valid sequence number
    - Test getEvents with valid filters
    - Test parameter validation for each method
    - Test response parsing and validation
    - Test error extraction from RPC error responses
    - Test decimal string preservation in numeric fields
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 12.1, 12.2, 12.3_

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [~] 11. Implement health check functionality
  - [x] 11.1 Implement healthCheck method
    - Send lightweight RPC request (e.g., getLedger with latest sequence)
    - Measure response time in milliseconds
    - Return HealthCheckResult with healthy status on success
    - Return HealthCheckResult with unhealthy status and error details on failure
    - Include circuit breaker state in result
    - Do not count health check failures toward circuit breaker threshold
    - Log health check results (INFO level)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_
  
  - [ ]* 11.2 Write unit tests for health check
    - Test health check returns healthy on success
    - Test health check returns unhealthy on failure
    - Test response time is measured
    - Test circuit breaker state is included
    - Test health check failures don't affect circuit breaker
    - Test health check logging
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

- [~] 12. Implement metrics exposure
  - [x] 12.1 Implement getMetrics and resetMetrics methods
    - Implement getMetrics that returns MetricsSnapshot from MetricsCollector
    - Include circuit breaker state in snapshot
    - Include consecutive failure count in snapshot
    - Implement resetMetrics that clears all counters
    - _Requirements: 8.6, 8.7, 8.8, 8.9_
  
  - [ ]* 12.2 Write unit tests for metrics exposure
    - Test getMetrics returns complete snapshot
    - Test snapshot includes circuit breaker state
    - Test snapshot includes failure count
    - Test resetMetrics clears counters
    - _Requirements: 8.6, 8.7, 8.8, 8.9_

- [~] 13. Integrate with error handling middleware
  - [x] 13.1 Extend error handler middleware for RPC errors
    - Add RPC error type detection in errorHandler
    - Map RpcTimeoutError to 504 Gateway Timeout
    - Map RpcCircuitOpenError to 503 Service Unavailable
    - Map RpcRetryExhaustedError to 503 Service Unavailable
    - Map RpcValidationError to 400 Bad Request
    - Map generic RpcError to 502 Bad Gateway
    - Include RPC error details (code, correlationId, attempts) in API response
    - Preserve correlation ID from RPC errors in error response
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.9_
  
  - [ ]* 13.2 Write integration tests for error handling
    - Test RPC timeout error returns 504
    - Test circuit open error returns 503
    - Test retry exhausted error returns 503
    - Test validation error returns 400
    - Test correlation ID propagation through error handling
    - Test error details included in response
    - _Requirements: 10.6, 10.7, 10.9_

- [~] 14. Implement response validation
  - [x] 14.1 Add response validation logic
    - Validate response contains expected fields for each RPC method
    - Throw RpcValidationError when required fields are missing
    - Validate numeric fields are within expected ranges
    - Validate account IDs match Stellar address format (56 chars, starts with G)
    - Validate transaction hashes match expected format (64 hex chars)
    - Log validation failures with response excerpt and error details (ERROR level)
    - Classify validation errors as permanent errors (no retry)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_
  
  - [ ]* 14.2 Write unit tests for response validation
    - Test missing required fields trigger validation error
    - Test invalid account ID format rejection
    - Test invalid transaction hash format rejection
    - Test numeric range validation
    - Test validation errors are classified as permanent
    - Test validation logging
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6, 12.7, 12.8_

- [~] 15. Create example usage and integration
  - [x] 15.1 Create example route using StellarRpcClient
    - Create example route in src/routes/ that demonstrates client usage
    - Initialize StellarRpcClient with configuration from environment variables
    - Implement route handler that calls getAccount with correlation ID from request
    - Handle RPC errors and return appropriate HTTP responses
    - Demonstrate request cancellation using request abort signal
    - Add route to Express app
    - _Requirements: 9.10, 10.9, 11.1, 11.2_
  
  - [ ]* 15.2 Write integration tests for example route
    - Test successful account fetch returns 200
    - Test timeout returns 504
    - Test circuit breaker returns 503
    - Test validation error returns 400
    - Test correlation ID propagation
    - Test request cancellation
    - _Requirements: 10.6, 10.9, 11.2, 11.3_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- All numeric precision is preserved using decimal strings
- Correlation IDs flow through all components for observability
- Circuit breaker protects against cascading failures
- Exponential backoff with jitter prevents thundering herd
