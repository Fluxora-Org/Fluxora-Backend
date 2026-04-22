import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { WebhookDeliveryAttempt, WebhookRetryPolicy } from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { computeWebhookSignature } from './signature.js';
import { calculateNextRetryTime, shouldRetry, isRetryableStatusCode } from './retry.js';

export interface WebhookDispatchOptions {
  url: string;
  secret: string;
  payload: string;
  deliveryId: string;
  eventType: string;
  policy?: WebhookRetryPolicy;
  attemptNumber?: number;
}

export interface WebhookDispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  nextRetryAt?: number;
  shouldRetry: boolean;
}

/**
 * Enhanced webhook dispatcher with durable delivery and proper error handling
 */
export class WebhookDispatcher {
  private policy: WebhookRetryPolicy;

  constructor(policy: WebhookRetryPolicy = DEFAULT_RETRY_POLICY) {
    this.policy = policy;
  }

  /**
   * Dispatch a webhook with proper signature and error handling
   */
  async dispatch(options: WebhookDispatchOptions): Promise<WebhookDispatchResult> {
    const { url, secret, payload, deliveryId, eventType, attemptNumber = 1 } = options;
    const timestamp = Math.floor(Date.now() / 1000).toString();

    logger.info('Dispatching webhook', {
      deliveryId,
      eventType,
      attemptNumber,
      url,
    });

    const signature = computeWebhookSignature(secret, timestamp, payload);

    try {
      const response = await this.sendRequest(url, payload, deliveryId, eventType, timestamp, signature);
      
      const attempt: WebhookDeliveryAttempt = {
        attemptNumber,
        timestamp: Date.now(),
        statusCode: response.status,
      };

      if (response.ok) {
        logger.info('Webhook delivered successfully', {
          deliveryId,
          statusCode: response.status,
          attemptNumber,
        });

        return {
          success: true,
          statusCode: response.status,
          shouldRetry: false,
        };
      }

      // Handle non-2xx responses
      const errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      attempt.error = errorMessage;

      const retryable = shouldRetry(attempt, attemptNumber, this.policy);
      
      if (retryable) {
        const nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        
        logger.warn('Webhook delivery failed, will retry', {
          deliveryId,
          statusCode: response.status,
          attemptNumber,
          error: errorMessage,
          nextRetryAt: new Date(nextRetryAt).toISOString(),
        });

        return {
          success: false,
          statusCode: response.status,
          error: errorMessage,
          nextRetryAt,
          shouldRetry: true,
        };
      }

      logger.error('Webhook delivery failed permanently', {
        deliveryId,
        statusCode: response.status,
        attemptNumber,
        error: errorMessage,
        maxAttempts: this.policy.maxAttempts,
      });

      return {
        success: false,
        statusCode: response.status,
        error: errorMessage,
        shouldRetry: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const attempt: WebhookDeliveryAttempt = {
        attemptNumber,
        timestamp: Date.now(),
        error: errorMessage,
      };

      const retryable = shouldRetry(attempt, attemptNumber, this.policy);
      
      if (retryable) {
        const nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        
        logger.warn('Webhook delivery failed with error, will retry', {
          deliveryId,
          attemptNumber,
          error: errorMessage,
          nextRetryAt: new Date(nextRetryAt).toISOString(),
        });

        return {
          success: false,
          error: errorMessage,
          nextRetryAt,
          shouldRetry: true,
        };
      }

      logger.error('Webhook delivery failed permanently with error', {
        deliveryId,
        attemptNumber,
        error: errorMessage,
        maxAttempts: this.policy.maxAttempts,
      });

      return {
        success: false,
        error: errorMessage,
        shouldRetry: false,
      };
    }
  }

  /**
   * Send HTTP request to webhook endpoint
   */
  private async sendRequest(
    url: string,
    payload: string,
    deliveryId: string,
    eventType: string,
    timestamp: string,
    signature: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.policy.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-fluxora-delivery-id': deliveryId,
          'x-fluxora-timestamp': timestamp,
          'x-fluxora-signature': signature,
          'x-fluxora-event': eventType,
          'User-Agent': 'Fluxora-Webhook-Dispatcher/2.0',
        },
        body: payload,
        signal: controller.signal,
      });

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate webhook endpoint before attempting delivery
   */
  async validateEndpoint(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout for validation

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.status < 500; // Accept any non-server-error status
    } catch (error) {
      logger.warn('Webhook endpoint validation failed', { url, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Get retry policy for logging/debugging
   */
  getRetryPolicy(): WebhookRetryPolicy {
    return { ...this.policy };
  }
}

export const webhookDispatcher = new WebhookDispatcher();
