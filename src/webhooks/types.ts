/**
 * Webhook delivery and retry policy types
 */

export type WebhookEventType = 'stream.created' | 'stream.updated' | 'stream.cancelled';

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'permanent_failure';

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
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
