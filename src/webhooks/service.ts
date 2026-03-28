/**
 * Webhook delivery service
 * Handles sending webhooks with retry logic
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type {
  WebhookEvent,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookRetryPolicy,
} from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { webhookDeliveryStore } from './store.js';
import { calculateNextRetryTime, shouldRetry } from './retry.js';
import { computeWebhookSignature } from './signature.js';

export class WebhookService {
  private policy: WebhookRetryPolicy;

  constructor(policy: WebhookRetryPolicy = DEFAULT_RETRY_POLICY) {
    this.policy = policy;
  }

  /**
   * Queue a webhook delivery
   */
  async queueDelivery(
    event: WebhookEvent,
    endpointUrl: string,
    secret: string,
  ): Promise<WebhookDelivery> {
    const deliveryId = `deliv_${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify(event);

    const delivery: WebhookDelivery = {
      id: `delivery_${randomUUID()}`,
      deliveryId,
      eventId: event.id,
      eventType: event.type,
      endpointUrl,
      status: 'pending',
      attempts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      payload,
    };

    webhookDeliveryStore.store(delivery);
    logger.info('Webhook delivery queued', undefined, {
      deliveryId: delivery.deliveryId,
      eventId: event.id,
      eventType: event.type,
      endpointUrl,
    });

    // Attempt immediate delivery
    await this.attemptDelivery(delivery, secret, timestamp);

    return delivery;
  }

  /**
   * Attempt to deliver a webhook
   */
  async attemptDelivery(
    delivery: WebhookDelivery,
    secret: string,
    timestamp?: string,
  ): Promise<void> {
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();
    const attemptNumber = delivery.attempts.length + 1;

    logger.info('Attempting webhook delivery', undefined, {
      deliveryId: delivery.deliveryId,
      attempt: attemptNumber,
      maxAttempts: this.policy.maxAttempts,
    });

    const signature = computeWebhookSignature(secret, ts, delivery.payload);

    const attempt: WebhookDeliveryAttempt = {
      attemptNumber,
      timestamp: Date.now(),
    };

    try {
      const response = await this.sendWebhook(
        delivery.endpointUrl,
        delivery.payload,
        delivery.deliveryId,
        ts,
        signature,
      );

      attempt.statusCode = response.status;

      if (response.ok) {
        delivery.status = 'delivered';
        delivery.attempts.push(attempt);
        webhookDeliveryStore.store(delivery);

        logger.info('Webhook delivered successfully', undefined, {
          deliveryId: delivery.deliveryId,
          statusCode: response.status,
          attempt: attemptNumber,
        });
      } else {
        // Handle non-2xx responses
        if (shouldRetry(attempt, attemptNumber, this.policy)) {
          attempt.nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
          delivery.status = 'pending';

          logger.warn('Webhook delivery failed, will retry', undefined, {
            deliveryId: delivery.deliveryId,
            statusCode: response.status,
            attempt: attemptNumber,
            nextRetryAt: new Date(attempt.nextRetryAt).toISOString(),
          });
        } else {
          delivery.status = 'permanent_failure';
          logger.error('Webhook delivery failed permanently', undefined, {
            deliveryId: delivery.deliveryId,
            statusCode: response.status,
            attempt: attemptNumber,
            maxAttempts: this.policy.maxAttempts,
          });
        }

        delivery.attempts.push(attempt);
        webhookDeliveryStore.store(delivery);
      }
    } catch (error) {
      // Network error or timeout
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (shouldRetry(attempt, attemptNumber, this.policy)) {
        attempt.error = errorMessage;
        attempt.nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        delivery.status = 'pending';

        logger.warn('Webhook delivery failed with error, will retry', undefined, {
          deliveryId: delivery.deliveryId,
          error: errorMessage,
          attempt: attemptNumber,
          nextRetryAt: new Date(attempt.nextRetryAt).toISOString(),
        });
      } else {
        attempt.error = errorMessage;
        delivery.status = 'permanent_failure';

        logger.error('Webhook delivery failed permanently with error', undefined, {
          deliveryId: delivery.deliveryId,
          error: errorMessage,
          attempt: attemptNumber,
          maxAttempts: this.policy.maxAttempts,
        });
      }

      delivery.attempts.push(attempt);
      webhookDeliveryStore.store(delivery);
    }
  }

  /**
   * Send a webhook to an endpoint
   */
  private async sendWebhook(
    url: string,
    payload: string,
    deliveryId: string,
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
          'x-fluxora-event': 'webhook.event',
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
   * Process pending retries
   * Should be called periodically (e.g., every 10 seconds)
   */
  async processPendingRetries(secret: string): Promise<void> {
    const now = Date.now();
    const pendingRetries = webhookDeliveryStore.getPendingRetries(now);

    if (pendingRetries.length === 0) {
      return;
    }

    logger.info('Processing pending webhook retries', undefined, {
      count: pendingRetries.length,
    });

    for (const delivery of pendingRetries) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      await this.attemptDelivery(delivery, secret, timestamp);
    }
  }

  /**
   * Get delivery status
   */
  getDeliveryStatus(deliveryId: string): WebhookDelivery | undefined {
    return webhookDeliveryStore.getByDeliveryId(deliveryId);
  }

  /**
   * Check if a delivery ID has been seen (for deduplication)
   */
  isDuplicateDelivery(deliveryId: string): boolean {
    return webhookDeliveryStore.isDuplicateDelivery(deliveryId);
  }
}

export const webhookService = new WebhookService();
