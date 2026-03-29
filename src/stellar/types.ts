/**
 * Configuration interface for Stellar RPC Client
 */
export interface StellarRpcClientConfig {
  endpoint: string;
  timeout: number;
  maxRetries: number;
  initialBackoff: number;
  maxBackoff: number;
  circuitBreakerThreshold: number;
  circuitBreakerRecoveryTimeout: number;
}

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

/**
 * Request options for RPC calls
 */
export interface RequestOptions {
  signal?: AbortSignal;
  correlationId?: string;
}

/**
 * Internal request context
 */
export interface RequestContext {
  correlationId: string;
  method: string;
  endpoint: string;
  startTime: number;
  attempt: number;
  signal?: AbortSignal;
}

/**
 * Metrics snapshot
 */
export interface MetricsSnapshot {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: Record<string, number>;
  retryAttempts: number;
  circuitBreakerState: CircuitState;
  consecutiveFailures: number;
  latencyHistogram: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
}

/**
 * Stellar RPC Response Types
 */

export interface Balance {
  asset: string;
  amount: string;
}

export interface AccountResponse {
  id: string;
  sequence: string;
  balances: Balance[];
}

export interface Operation {
  type: string;
  source?: string;
  [key: string]: unknown;
}

export interface TransactionResponse {
  hash: string;
  ledger: number;
  status: 'SUCCESS' | 'FAILED';
  createdAt: string;
  operations: Operation[];
}

export interface SubmitResponse {
  hash: string;
  status: 'PENDING' | 'DUPLICATE' | 'ERROR';
  errorMessage?: string;
}

export interface LedgerResponse {
  sequence: number;
  hash: string;
  previousHash: string;
  transactionCount: number;
  closedAt: string;
}

export interface EventFilters {
  contractId?: string;
  topics?: string[];
  startLedger?: number;
  endLedger?: number;
}

export interface ContractEvent {
  type: string;
  ledger: number;
  contractId: string;
  topics: string[];
  data: unknown;
}

export interface EventsResponse {
  events: ContractEvent[];
  latestLedger: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  responseTime: number;
  circuitState: CircuitState;
  error?: string;
}
