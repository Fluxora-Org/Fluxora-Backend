import { CORRELATION_ID_HEADER } from '../middleware/correlationId.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { logger } from '../lib/logger.js';
import type { WebhookDeliveryAttempt, WebhookRetryPolicy } from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { computeWebhookSignature } from './signature.js';
import { calculateNextRetryTime, shouldRetry, resolveCircuitBreakerDeferral, countsTowardCircuitBreaker } from './retry.js';
import { webhooksSuppressedByReorgTotal } from '../metrics/businessMetrics.js';
import type { WebhookCircuitBreakerStore, CircuitBreakerPolicy } from '../redis/webhookCircuitBreakerStore.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import type { EnhancedRetryPolicy } from './retry.js';

export interface WebhookDispatchOptions {
  url: string;
  secret: string;
  payload: string;
  deliveryId: string;
  eventType: string;
  policy?: WebhookRetryPolicy;
  attemptNumber?: number;
  correlationId?: string;
  circuitBreakerStore?: WebhookCircuitBreakerStore;
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
  private policy: EnhancedRetryPolicy;
  private readonly circuitBreakerStore: WebhookCircuitBreakerStore;

  constructor(
    policy: EnhancedRetryPolicy = DEFAULT_RETRY_POLICY,
    circuitBreakerStore: WebhookCircuitBreakerStore = getWebhookCircuitBreakerStore(),
  ) {
    this.policy = policy;
    this.circuitBreakerStore = circuitBreakerStore;
  }

  /**
   * Dispatch a webhook with a signed POST request and retry-safe result.
   *
   * Logging contract: structured logs include only stable delivery identifiers
   * (`deliveryId`, `eventType`, `attemptNumber`) and HTTP `statusCode` when
   * available. Webhook secrets, raw payloads, signatures, and target URLs are
   * intentionally excluded from log metadata.
   */
  async dispatch(options: WebhookDispatchOptions): Promise<WebhookDispatchResult> {
    const {
      url,
      secret,
      payload,
      deliveryId,
      eventType,
      attemptNumber = 1,
      correlationId,
      circuitBreakerStore = this.circuitBreakerStore,
    } = options;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const effectiveCorrelationId = correlationId ?? getCorrelationId();
    const enhancedPolicy = this.policy as EnhancedRetryPolicy;

    const gate = await circuitBreakerStore.checkAndClaimAttempt(url, enhancedPolicy);
    if (!gate.allowed) {
      const nextRetryAt = resolveCircuitBreakerDeferral(gate, enhancedPolicy).getTime();
      logger.warn('Webhook delivery deferred by circuit breaker', undefined, {
        deliveryId,
        attemptNumber,
        state: gate.state,
        nextRetryAt: new Date(nextRetryAt).toISOString(),
      });
      return {
        success: false,
        error: `Circuit breaker ${gate.state}`,
        nextRetryAt,
        shouldRetry: true,
      };
    }

    logger.info('Dispatching webhook', effectiveCorrelationId !== 'unknown' ? effectiveCorrelationId : undefined, {
      deliveryId,
      eventType,
      attemptNumber,
    });

    const signature = computeWebhookSignature(secret, timestamp, payload);

    try {
      const response = await this.sendRequest(url, payload, deliveryId, eventType, timestamp, signature, effectiveCorrelationId);
      
      const attempt: WebhookDeliveryAttempt = {
        attemptNumber,
        timestamp: Date.now(),
        statusCode: response.status,
      };

      if (response.ok) {
        await circuitBreakerStore.recordSuccess(url, enhancedPolicy as CircuitBreakerPolicy);
        logger.info('Webhook delivered successfully', undefined, {
          deliveryId,
          eventType,
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

      const consecutiveFailures = countsTowardCircuitBreaker(attempt, this.policy)
        ? (await circuitBreakerStore.recordFailure(url, enhancedPolicy as CircuitBreakerPolicy)).consecutiveFailures
        : (await circuitBreakerStore.getState(url))?.consecutiveFailures ?? 0;
      const retryable = shouldRetry(attempt, attemptNumber, this.policy, consecutiveFailures);
      
      if (retryable) {
        const nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        
        logger.warn('Webhook delivery failed, will retry', undefined, {
          deliveryId,
          eventType,
          statusCode: response.status,
          attemptNumber,
        });

        return {
          success: false,
          statusCode: response.status,
          error: errorMessage,
          nextRetryAt,
          shouldRetry: true,
        };
      }

      logger.error('Webhook delivery failed permanently', undefined, {
        deliveryId,
        eventType,
        statusCode: response.status,
        attemptNumber,
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

      const consecutiveFailures = countsTowardCircuitBreaker(attempt, this.policy)
        ? (await circuitBreakerStore.recordFailure(url, enhancedPolicy as CircuitBreakerPolicy)).consecutiveFailures
        : (await circuitBreakerStore.getState(url))?.consecutiveFailures ?? 0;
      const retryable = shouldRetry(attempt, attemptNumber, this.policy, consecutiveFailures);
      
      if (retryable) {
        const nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        
        logger.warn('Webhook delivery failed with error, will retry', undefined, {
          deliveryId,
          eventType,
          attemptNumber,
        });

        return {
          success: false,
          error: errorMessage,
          nextRetryAt,
          shouldRetry: true,
        };
      }

      logger.error('Webhook delivery failed permanently with error', undefined, {
        deliveryId,
        eventType,
        attemptNumber,
      });

      return {
        success: false,
        error: errorMessage,
        shouldRetry: false,
      };
    }
  }

  /**
   * Send HTTP request to webhook endpoint.
   *
   * This method does not log request metadata; callers must keep secrets,
   * signatures, raw payloads, and endpoint URLs out of log records.
   */
  private async sendRequest(
    url: string,
    payload: string,
    deliveryId: string,
    eventType: string,
    timestamp: string,
    signature: string,
    correlationId?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.policy.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-fluxora-delivery-id': deliveryId,
        'x-fluxora-timestamp': timestamp,
        'x-fluxora-signature': signature,
        'x-fluxora-event': eventType,
        'User-Agent': 'Fluxora-Webhook-Dispatcher/2.0',
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

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate webhook endpoint reachability.
   *
   * Validation failures are logged without URL or exception text metadata to
   * avoid leaking endpoint credentials or provider-specific details.
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
    } catch {
      logger.warn('Webhook endpoint validation failed');
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

/**
 * Backwards-compat convenience wrapper used by older callers (and tests)
 * that pre-date the {@link WebhookDispatcher} class.
 *
 * Builds an HMAC-signed POST to `url` carrying `payload` serialised as JSON.
 * The optional `ledger` field is consulted by callers that wish to suppress
 * delivery for reorged ledgers — when `ledger` is provided and the indexer
 * has rolled it back, delivery is skipped.
 */
export interface SimpleWebhookDispatch {
  url: string;
  secret: string;
  event: string;
  payload: unknown;
  ledger?: number;
}

export async function dispatchWebhook(opts: SimpleWebhookDispatch): Promise<void> {
  // Optional reorg suppression: callers that pass a ledger number opt in to
  // skipping delivery for ledgers the indexer has rolled back.  The import is
  // dynamic so this helper has no hard dependency on the indexer module graph.
  if (opts.ledger !== undefined) {
    try {
      const { isLedgerRolledBack } = await import('../indexer/service.js');
      if (isLedgerRolledBack(opts.ledger)) {
        webhooksSuppressedByReorgTotal.inc();
        return;
      }
    } catch {
      // If we can't determine reorg status, fall through and deliver.
    }
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadStr = JSON.stringify(opts.payload);
  const signature = computeWebhookSignature(opts.secret, timestamp, payloadStr);

  await fetch(opts.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Fluxora-Event': opts.event,
      'X-Fluxora-Signature': signature,
      'X-Fluxora-Timestamp': timestamp,
    },
    body: payloadStr,
  });
}
