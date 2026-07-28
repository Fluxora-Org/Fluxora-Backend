/**
 * Webhook delivery and retry policy types
 */

export type WebhookEventType = 'stream.created' | 'stream.updated' | 'stream.cancelled';

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'permanent_failure';

/**
 * Distinct reason codes for DLQ entries.
 * Operators can use these to distinguish between different failure modes
 * and prioritize remediation accordingly.
 *
 * - `poison`: Structurally invalid payload, unparseable URL, or non-retryable 4xx (deterministic failure)
 * - `exhausted`: Hit max retry attempts with transient failures
 * - `timeout`: Delivery took longer than configured timeout
 * - `circuit_breaker`: Circuit breaker is open for this endpoint
 * - `rate_limited`: Persistent rate-limiting despite backoff
 * - `other`: Catch-all for other permanent failures
 */
export type DLQReasonCode =
  | 'poison'
  | 'exhausted'
  | 'timeout'
  | 'circuit_breaker'
  | 'rate_limited'
  | 'other';

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface WebhookDeliveryAttempt {
  attemptNumber: number;
  timestamp: number;
  statusCode?: number;
  error?: string;
  nextRetryAt?: number;
}

export interface WebhookDelivery {
  id: string;
  deliveryId: string;
  eventId: string;
  eventType: WebhookEventType;
  endpointUrl: string;
  status: WebhookDeliveryStatus;
  attempts: WebhookDeliveryAttempt[];
  createdAt: number;
  updatedAt: number;
  payload: string;
}

export interface WebhookRetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  jitterPercent: number;
  timeoutMs: number;
  retryableStatusCodes: number[];
}

export const DEFAULT_RETRY_POLICY: WebhookRetryPolicy = {
  maxAttempts: 5,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60000,
  jitterPercent: 10,
  timeoutMs: 30000,
  retryableStatusCodes: [408, 425, 429, 500, 502, 503, 504],
};
