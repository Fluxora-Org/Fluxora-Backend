# Stellar RPC Client Example Route

## Overview

The `stellar.ts` route demonstrates how to use the `StellarRpcClient` wrapper in an Express application. It showcases all the key features required by the Stellar RPC Client Wrapper specification.

## Features Demonstrated

### 1. Client Initialization with Environment Variables

The route initializes `StellarRpcClient` with configuration from environment variables:

```typescript
const config: StellarRpcClientConfig = {
  endpoint: process.env.STELLAR_RPC_ENDPOINT || 'https://soroban-testnet.stellar.org',
  timeout: parseInt(process.env.STELLAR_RPC_TIMEOUT || '5000', 10),
  maxRetries: parseInt(process.env.STELLAR_RPC_MAX_RETRIES || '3', 10),
  initialBackoff: parseInt(process.env.STELLAR_RPC_INITIAL_BACKOFF || '100', 10),
  maxBackoff: parseInt(process.env.STELLAR_RPC_MAX_BACKOFF || '5000', 10),
  circuitBreakerThreshold: parseInt(process.env.STELLAR_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
  circuitBreakerRecoveryTimeout: parseInt(process.env.STELLAR_CIRCUIT_BREAKER_RECOVERY_TIMEOUT || '30000', 10),
};
```

### 2. Correlation ID Propagation

The route propagates correlation IDs from incoming HTTP requests to RPC calls:

```typescript
const correlationId = req.correlationId;

const account = await stellarClient.getAccount(accountId, {
  correlationId,
  signal: abortController.signal,
});
```

This ensures end-to-end request tracing across the application and external RPC calls.

### 3. Request Cancellation with Abort Signal

The route demonstrates request cancellation when the HTTP request is aborted:

```typescript
const abortController = new AbortController();

req.on('close', () => {
  if (!res.headersSent) {
    info('Request aborted by client', { accountId, correlationId });
    abortController.abort();
  }
});

const account = await stellarClient.getAccount(accountId, {
  correlationId,
  signal: abortController.signal,
});
```

This prevents wasting resources on requests whose results are no longer needed.

### 4. RPC Error Handling

The route handles all RPC-specific errors and maps them to appropriate HTTP responses:

- **RpcValidationError** → 400 Bad Request
- **RpcTimeoutError** → 504 Gateway Timeout
- **RpcCircuitOpenError** → 503 Service Unavailable
- **RpcRetryExhaustedError** → 502 Bad Gateway
- **RpcError** → Maps status code from RPC response

Each error response includes:
- Machine-readable error code
- Human-readable error message
- Request correlation ID for tracing
- Additional context (e.g., retry attempts, field name)

## Available Endpoints

### GET /api/stellar/accounts/:accountId

Fetches Stellar account details by account ID.

**Example Request:**
```bash
curl -H "x-correlation-id: my-request-123" \
  http://localhost:3000/api/stellar/accounts/GABC...
```

**Success Response (200):**
```json
{
  "account": {
    "id": "GABC...",
    "sequence": "123456789",
    "balances": [
      {
        "asset": "native",
        "amount": "1000.0000000"
      }
    ]
  },
  "requestId": "my-request-123"
}
```

**Error Response (400 - Validation Error):**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "accountId must be 56 characters long",
    "field": "accountId",
    "requestId": "my-request-123"
  }
}
```

### GET /api/stellar/health

Checks Stellar RPC health status.

**Example Request:**
```bash
curl http://localhost:3000/api/stellar/health
```

**Response (200 or 503):**
```json
{
  "healthy": true,
  "responseTime": 245,
  "circuitState": "CLOSED",
  "requestId": "auto-generated-uuid"
}
```

### GET /api/stellar/metrics

Gets Stellar RPC client metrics.

**Example Request:**
```bash
curl http://localhost:3000/api/stellar/metrics
```

**Response (200):**
```json
{
  "metrics": {
    "totalRequests": 42,
    "successfulRequests": 38,
    "failedRequests": {
      "timeout": 2,
      "-32601": 2
    },
    "retryAttempts": 5,
    "circuitBreakerState": "CLOSED",
    "consecutiveFailures": 0,
    "latencyHistogram": {
      "p50": 150,
      "p95": 450,
      "p99": 800,
      "max": 1200
    }
  },
  "requestId": "auto-generated-uuid"
}
```

## Environment Variables

Configure the Stellar RPC client using these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `STELLAR_RPC_ENDPOINT` | `https://soroban-testnet.stellar.org` | Stellar RPC endpoint URL |
| `STELLAR_RPC_TIMEOUT` | `5000` | Request timeout in milliseconds |
| `STELLAR_RPC_MAX_RETRIES` | `3` | Maximum retry attempts |
| `STELLAR_RPC_INITIAL_BACKOFF` | `100` | Initial backoff delay in milliseconds |
| `STELLAR_RPC_MAX_BACKOFF` | `5000` | Maximum backoff delay in milliseconds |
| `STELLAR_CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive failures before opening circuit |
| `STELLAR_CIRCUIT_BREAKER_RECOVERY_TIMEOUT` | `30000` | Recovery timeout in milliseconds |

## Testing

Run the example route tests:

```bash
npm test -- --testPathPattern=stellar-route
```

The tests verify:
- Input validation (account ID format)
- Correlation ID propagation
- Error handling for various failure modes
- Health check functionality
- Metrics collection
