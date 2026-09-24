/** Webhook delivery orchestration and delivery-attempt lifecycle. */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { CORRELATION_ID_HEADER } from '../middleware/correlationId.js';
import { getCorrelationId } from '../tracing/middleware.js';
import type { WebhookEvent, WebhookDelivery, WebhookDeliveryAttempt } from './types.js';
import { webhookDeliveryStore } from './storeFactory.js';
import { computeWebhookSignature } from './signature.js';
import {
  calculateNextRetryTime,
  shouldRetry,
  checkWebhookDeliveryGate,
  countsTowardCircuitBreaker,
  type EnhancedRetryPolicy,
} from './retry.js';
import {
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
  safeObserveDuration,
} from '../metrics/businessMetrics.js';
import type { WebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import { loadConfig } from '../config/env.js';
import {
  enqueuePermanentFailureToDlq,
  parseRetryAfter,
  resolveWebhookRetryPolicy,
} from './delivery-support.js';

export class WebhookService {
  private policy: EnhancedRetryPolicy;
  private readonly circuitBreakerStore: WebhookCircuitBreakerStore;

  constructor(
    policy: EnhancedRetryPolicy = resolveWebhookRetryPolicy(),
    circuitBreakerStore: WebhookCircuitBreakerStore = getWebhookCircuitBreakerStore()
  ) {
    this.policy = policy;
    this.circuitBreakerStore = circuitBreakerStore;
  }

  /**
   * Queue a webhook delivery
   */
  async queueDelivery(
    event: WebhookEvent,
    endpointUrl: string,
    secret: string
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
    });

    // Attempt immediate delivery when the circuit breaker allows it.
    const gate = await checkWebhookDeliveryGate(endpointUrl, this.policy, {
      circuitBreakerStore: this.circuitBreakerStore,
    });
    if (!gate.canDeliver) {
      if (!gate.retryAt) {
        logger.error('Webhook delivery gate rejected delivery without a retry time', undefined, {
          deliveryId: delivery.deliveryId,
        });
        return delivery;
      }
      const attempt: WebhookDeliveryAttempt = {
        attemptNumber: 1,
        timestamp: Date.now(),
        nextRetryAt: gate.retryAt.getTime(),
      };
      delivery.attempts.push(attempt);
      webhookDeliveryStore.store(delivery);
      return delivery;
    }

    await this.attemptDelivery(delivery, secret, timestamp);

    return delivery;
  }

  /**
   * Perform the HTTP request and update delivery state without touching the circuit breaker.
   * Used by {@link attemptWebhookDeliveryWithRateLimit} so breaker accounting stays in one place.
   */
  async runDeliveryAttempt(
    delivery: WebhookDelivery,
    secret: string,
    timestamp?: string
  ): Promise<WebhookDeliveryAttempt> {
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();
    const attemptNumber = delivery.attempts.length + 1;
    const correlationId = getCorrelationId();
    logger.info(
      'Attempting webhook delivery',
      correlationId !== 'unknown' ? correlationId : undefined,
      {
        deliveryId: delivery.deliveryId,
        eventType: delivery.eventType,
        attemptNumber,
        maxAttempts: this.policy.maxAttempts,
      }
    );

    const signature = computeWebhookSignature(secret, ts, delivery.payload);
    const attempt: WebhookDeliveryAttempt = {
      attemptNumber,
      timestamp: Date.now(),
    };
    const startTime = Date.now();

    try {
      const response = await this.sendWebhook(
        delivery.endpointUrl,
        delivery.payload,
        delivery.deliveryId,
        delivery.eventType,
        ts,
        signature,
        correlationId
      );
      attempt.statusCode = response.status;

      if (response.ok) {
        delivery.status = 'delivered';
        delivery.attempts.push(attempt);
        webhookDeliveryStore.store(delivery);
        logger.info('Webhook delivered successfully', undefined, {
          deliveryId: delivery.deliveryId,
          eventType: delivery.eventType,
          statusCode: response.status,
          attemptNumber,
        });
        webhookDeliveriesTotal.inc({ outcome: 'success' });
      } else {
        // Handle non-2xx responses
        if (shouldRetry(attempt, attemptNumber, this.policy)) {
          // For 429 responses, respect Retry-After header if present
          let nextRetryAt: number;
          if (response.status === 429) {
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
            nextRetryAt =
              retryAfterMs !== null
                ? Date.now() + retryAfterMs
                : calculateNextRetryTime(attemptNumber, this.policy);
          } else {
            nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
          }
          attempt.nextRetryAt = nextRetryAt;
          delivery.status = 'pending';

          logger.warn('Webhook delivery failed, will retry', undefined, {
            deliveryId: delivery.deliveryId,
            eventType: delivery.eventType,
            statusCode: response.status,
            attemptNumber,
          });
        } else {
          delivery.status = 'permanent_failure';
          logger.error('Webhook delivery failed permanently', undefined, {
            deliveryId: delivery.deliveryId,
            eventType: delivery.eventType,
            statusCode: response.status,
            attemptNumber,
          });
        }

        delivery.attempts.push(attempt);
        delivery.status = 'pending';
        webhookDeliveryStore.store(delivery);
        webhookDeliveriesTotal.inc({ outcome: 'failed' });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (shouldRetry(attempt, attemptNumber, this.policy)) {
        attempt.error = errorMessage;
        attempt.nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        delivery.status = 'pending';

        logger.warn('Webhook delivery failed with error, will retry', undefined, {
          deliveryId: delivery.deliveryId,
          eventType: delivery.eventType,
          attemptNumber,
        });
      } else {
        attempt.error = errorMessage;
        delivery.status = 'permanent_failure';

        logger.error('Webhook delivery failed permanently with error', undefined, {
          deliveryId: delivery.deliveryId,
          eventType: delivery.eventType,
          attemptNumber,
        });
      }

      attempt.error = errorMessage;
      delivery.attempts.push(attempt);
      delivery.status = 'pending';
      webhookDeliveryStore.store(delivery);
      webhookDeliveriesTotal.inc({ outcome: 'failed' });
    } finally {
      safeObserveDuration(webhookDeliveryDurationSeconds, (Date.now() - startTime) / 1000);
    }

    return attempt;
  }

  private async recordBreakerOutcome(
    endpointUrl: string,
    attempt: WebhookDeliveryAttempt
  ): Promise<number> {
    const success =
      attempt.statusCode !== undefined &&
      attempt.statusCode >= 200 &&
      attempt.statusCode < 300 &&
      !attempt.error;

    if (success) {
      const record = await this.circuitBreakerStore.recordSuccess(
        endpointUrl,
        this.policy as CircuitBreakerPolicy
      );
      return record.consecutiveFailures;
    }

    if (!countsTowardCircuitBreaker(attempt, this.policy)) {
      const state = await this.circuitBreakerStore.getState(endpointUrl);
      return state?.consecutiveFailures ?? 0;
    }

    const record = await this.circuitBreakerStore.recordFailure(
      endpointUrl,
      this.policy as CircuitBreakerPolicy,
      Date.now()
    );
    return record.consecutiveFailures;
  }

  /**
   * Attempt to deliver a webhook
   */
  async attemptDelivery(
    delivery: WebhookDelivery,
    secret: string,
    timestamp?: string
  ): Promise<void> {
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();
    const attemptNumber = delivery.attempts.length + 1;

    const correlationId = getCorrelationId();
    logger.info(
      'Attempting webhook delivery',
      correlationId !== 'unknown' ? correlationId : undefined,
      {
        deliveryId: delivery.deliveryId,
        attempt: attemptNumber,
        maxAttempts: this.policy.maxAttempts,
      }
    );

    const attempt = await this.runDeliveryAttempt(delivery, secret, ts);
    const consecutiveFailures = await this.recordBreakerOutcome(delivery.endpointUrl, attempt);

    if (delivery.status === 'delivered') {
      return;
    }

    if (shouldRetry(attempt, attemptNumber, this.policy, consecutiveFailures)) {
      attempt.nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
      delivery.status = 'pending';
      logger.warn('Webhook delivery failed, will retry', undefined, {
        deliveryId: delivery.deliveryId,
        statusCode: attempt.statusCode,
        attempt: attemptNumber,
        nextRetryAt: new Date(attempt.nextRetryAt).toISOString(),
      });
    } else {
      delivery.status = 'permanent_failure';
      logger.error('Webhook delivery failed permanently', undefined, {
        deliveryId: delivery.deliveryId,
        statusCode: attempt.statusCode,
        attempt: attemptNumber,
        maxAttempts: this.policy.maxAttempts,
      });
    }

    webhookDeliveryStore.store(delivery);

    if (delivery.status === 'permanent_failure') {
      const failureReason = attempt.error
        ? `${attempt.error} after ${attemptNumber} attempt${attemptNumber === 1 ? '' : 's'}`
        : `HTTP ${attempt.statusCode} after ${attemptNumber} attempt${attemptNumber === 1 ? '' : 's'}`;
      enqueuePermanentFailureToDlq(delivery, failureReason);
    }
  }

  /**
   * Send a webhook to an endpoint
   */
  private async sendWebhook(
    url: string,
    payload: string,
    deliveryId: string,
    eventType: string,
    timestamp: string,
    signature: string,
    correlationId?: string
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException('Webhook delivery timeout', 'TimeoutError')),
      this.policy.timeoutMs
    );

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-fluxora-delivery-id': deliveryId,
        'x-fluxora-timestamp': timestamp,
        'x-fluxora-signature': signature,
        'x-fluxora-event': eventType,
      };

      if (correlationId && correlationId !== 'unknown') {
        headers[CORRELATION_ID_HEADER] = correlationId;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });

      // Validate Content-Type header (must be present and not empty)
      const contentType = response.headers.get('content-type');
      if (!contentType) {
        throw new Error('Missing Content-Type header in webhook response');
      }

      // Enforce maximum response body size
      const maxBytes = loadConfig().webhookMaxResponseBytes;
      if (response.body) {
        const reader = response.body.getReader();
        let bytesRead = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.length;
          if (bytesRead > maxBytes) {
            controller.abort(new Error('Webhook response exceeds maximum allowed size'));
            throw new Error('Webhook response exceeds maximum allowed size');
          }
        }
      }

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
      const gate = await checkWebhookDeliveryGate(delivery.endpointUrl, this.policy, {
        circuitBreakerStore: this.circuitBreakerStore,
      });
      if (!gate.canDeliver) {
        if (!gate.retryAt) {
          logger.error('Webhook retry gate rejected delivery without a retry time', undefined, {
            deliveryId: delivery.deliveryId,
          });
          continue;
        }
        const lastAttempt = delivery.attempts[delivery.attempts.length - 1];
        if (lastAttempt) {
          lastAttempt.nextRetryAt = gate.retryAt.getTime();
          webhookDeliveryStore.store(delivery);
        }
        continue;
      }

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
   * Register an inbound delivery ID for deduplication.
   */
  registerDeliveryId(deliveryId: string): void {
    webhookDeliveryStore.registerDeliveryId(deliveryId);
  }

  /**
   * Check if a delivery ID has been seen (for deduplication)
   */
  isDuplicateDelivery(deliveryId: string): boolean {
    return webhookDeliveryStore.isDuplicateDelivery(deliveryId);
  }
}

/**
 * Polls PostgreSQL webhook_outbox rows and delivers them to the configured
 * consumer endpoint. Rows stay locked until their HTTP delivery transaction
 * commits, so concurrent workers use FOR UPDATE SKIP LOCKED without sending
 * the same row at the same time.
 */
