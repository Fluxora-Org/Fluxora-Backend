import { CORRELATION_ID_HEADER } from '../middleware/correlationId.js';
import { getCorrelationId, getActiveTraceContext, buildTraceparent } from '../tracing/middleware.js';

import { logger } from '../lib/logger.js';
import { redactKeysInString } from '../pii/sanitizer.js';

import type { WebhookDeliveryAttempt, WebhookRetryPolicy } from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { computeWebhookSignature } from './signature.js';
import { calculateNextRetryTime, shouldRetry, resolveCircuitBreakerDeferral, countsTowardCircuitBreaker } from './retry.js';
import type { WebhookCircuitBreakerStore, CircuitBreakerPolicy } from '../redis/webhookCircuitBreakerStore.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import type { EnhancedRetryPolicy } from './retry.js';
import { validateWebhookIPAddress, validateWebhookTarget, WebhookTargetValidationError } from './ssrfGuard.js';
import { getConfig } from '../config/env.js';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

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

interface WebhookHttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
}

type LookupCallback = (error: Error | null, address: string, family: number) => void;

type FetchRedirectOptions = Omit<RequestInit, 'redirect'>;

function webhookAllowlist(): string[] | undefined {
  try {
    return getConfig().webhookAllowedHosts;
  } catch {
    // Config not initialized, proceed without allowlist.
    return undefined;
  }
}

/**
 * Follow redirects for fetch-based webhook operations.
 *
 * The initial URL is validated by the caller. Every redirect is resolved
 * against the URL that produced it and validated before the next fetch, so
 * validation and delivery cannot drift into separate SSRF policies.
 */
async function followFetchRedirects(
  initialUrl: string,
  requestOptions: FetchRedirectOptions,
  maxRedirects = 1,
  operation = 'webhook request',
): Promise<Response> {
  let currentUrl = initialUrl;
  let redirectCount = 0;
  const allowlist = webhookAllowlist();

  while (true) {
    const response = await fetch(currentUrl, {
      ...requestOptions,
      redirect: 'manual',
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const locationHeader = response.headers.get('Location');
    if (!locationHeader) {
      return response;
    }

    if (redirectCount >= maxRedirects) {
      logger.error(`Too many redirects during ${operation}`);
      throw new Error('Too many redirects');
    }

    const redirectUrl = new URL(locationHeader, currentUrl).toString();
    try {
      await validateWebhookTarget(redirectUrl, { allowlist });
    } catch (error) {
      if (error instanceof WebhookTargetValidationError) {
        logger.error(`Redirect target rejected by SSRF guard during ${operation}`);
      }
      throw error;
    }

    currentUrl = redirectUrl;
    redirectCount++;
  }
}

/**
 * Resolve immediately before socket creation and hand Node the validated IP.
 * Returning the address prevents the HTTP client from performing a second DNS
 * lookup that could receive a rebinding answer.
 */
function lookupWebhookTarget(
  hostname: string,
  options: number | dns.LookupOneOptions,
  callback: LookupCallback,
): void {
  const family = typeof options === 'number' ? options : options.family;
  dns.lookup(hostname, { family, all: false }, (error, address, resolvedFamily) => {
    if (error) {
      callback(error, address, resolvedFamily);
      return;
    }

    try {
      validateWebhookIPAddress(address);
      callback(null, address, resolvedFamily);
    } catch (validationError) {
      callback(
        validationError instanceof Error
          ? validationError
          : new WebhookTargetValidationError('Resolved webhook address was rejected'),
        address,
        resolvedFamily,
      );
    }
  });
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

    // Validate webhook target for SSRF protection before any network call
    try {
      let allowlist: string[] | undefined;
      try {
        const config = getConfig();
        allowlist = config.webhookAllowedHosts;
      } catch {
        // Config not initialized, proceed without allowlist
      }
      await validateWebhookTarget(url, {
        allowlist,
      });
    } catch (error) {
      if (error instanceof WebhookTargetValidationError) {
        logger.error('Webhook target rejected by SSRF guard', effectiveCorrelationId, {
          deliveryId,
          eventType,
          reason: error.message,
        });
        return {
          success: false,
          error: error.message,
          shouldRetry: false,
        };
      }
      throw error;
    }

    const gate = await circuitBreakerStore.checkAndClaimAttempt(url, enhancedPolicy);
    if (!gate.allowed) {
      const nextRetryAt = resolveCircuitBreakerDeferral(gate, enhancedPolicy).getTime();
      logger.warn('Webhook delivery deferred by circuit breaker', effectiveCorrelationId, {
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
        logger.info('Webhook delivered successfully', effectiveCorrelationId, {
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
      const errorMessage = redactKeysInString(`HTTP ${response.status}: ${response.statusText}`);
      attempt.error = errorMessage;

      const consecutiveFailures = countsTowardCircuitBreaker(attempt, this.policy)
        ? (await circuitBreakerStore.recordFailure(url, enhancedPolicy as CircuitBreakerPolicy)).consecutiveFailures
        : (await circuitBreakerStore.getState(url))?.consecutiveFailures ?? 0;
      const retryable = shouldRetry(attempt, attemptNumber, this.policy, consecutiveFailures);
      
      if (retryable) {
        const nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
        
        logger.warn('Webhook delivery failed, will retry', effectiveCorrelationId, {
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

      logger.error('Webhook delivery failed permanently', effectiveCorrelationId, {
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
      const errorMessage = redactKeysInString(error instanceof Error ? error.message : String(error));
      
      // Check if it's WebhookTargetValidationError or TimeoutError, which are non-retryable
      let isNonRetryable = false;
      if (error instanceof WebhookTargetValidationError) {
        isNonRetryable = true;
      } else if (error instanceof DOMException && error.name === 'TimeoutError') {
        isNonRetryable = true;
      }
      
      if (isNonRetryable) {
        logger.error('Webhook delivery failed permanently with error', effectiveCorrelationId, {
          deliveryId,
          eventType,
          attemptNumber,
          error: errorMessage,
        });
        
        return {
          success: false,
          error: errorMessage,
          shouldRetry: false,
        };
      }

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
        
        logger.warn('Webhook delivery failed with error, will retry', effectiveCorrelationId, {
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

      logger.error('Webhook delivery failed permanently with error', effectiveCorrelationId, {
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
   * Follow redirects with SSRF validation on each hop.
   */
  private async followRedirects(
    initialUrl: string,
    requestOptions: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
    deliveryId: string,
    eventType: string,
    maxRedirects: number = 1,
  ): Promise<WebhookHttpResponse> {
    let currentUrl = initialUrl;
    let redirectCount = 0;
    const allowlist = webhookAllowlist();

    while (true) {
      const response = await this.sendWebhookHttpRequest(currentUrl, requestOptions);

      if (response.status >= 300 && response.status < 400) {
        const locationHeader = response.headers.get('Location');
        if (!locationHeader) {
          return response;
        }

        if (redirectCount >= maxRedirects) {
          logger.error('Too many webhook redirects', undefined, {
            deliveryId,
            eventType,
            redirectCount,
            maxRedirects,
          });
          throw new Error('Too many redirects');
        }

        // Resolve relative URL to absolute
        const redirectUrl = new URL(locationHeader, currentUrl).toString();
        
        // Validate the redirect URL with SSRF guard
        try {
          await validateWebhookTarget(redirectUrl, { allowlist });
          currentUrl = redirectUrl;
        } catch (error) {
          if (error instanceof WebhookTargetValidationError) {
            logger.error('Redirect target rejected by SSRF guard', undefined, {
              deliveryId,
              eventType,
              reason: error.message,
            });
            throw error;
          }
          throw error;
        }

        redirectCount++;
        continue;
      }

      return response;
    }
  }

  private async sendWebhookHttpRequest(
    url: string,
    requestOptions: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<WebhookHttpResponse> {
    const parsedUrl = new URL(url);
    return new Promise((resolve, reject) => {
      const options = {
        method: requestOptions.method,
        headers: requestOptions.headers,
        lookup: lookupWebhookTarget,
        signal: requestOptions.signal,
      };
      const handleResponse = (response: IncomingMessage) => {
        // The dispatcher intentionally ignores webhook response bodies. Drain
        // them so the connection can be reused while preserving the response
        // metadata consumed by dispatch().
        response.resume();
        const status = response.statusCode ?? 0;
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') {
            headers.set(name, value);
          } else if (Array.isArray(value)) {
            headers.set(name, value.join(', '));
          }
        }
        resolve({
          status,
          statusText: response.statusMessage ?? '',
          ok: status >= 200 && status < 300,
          headers,
        });
      };
      const request = parsedUrl.protocol === 'https:'
        ? https.request(parsedUrl, options, handleResponse)
        : http.request(parsedUrl, options, handleResponse);

      request.once('error', reject);
      request.end(requestOptions.body);
    });
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
  ): Promise<WebhookHttpResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new DOMException('Webhook delivery timeout', 'TimeoutError')), this.policy.timeoutMs);

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

      // Attach outbound W3C traceparent so webhook consumers can continue the
      // distributed trace across the service boundary.  Only added when an
      // active trace context exists in the current async scope; we never
      // fabricate a traceparent when no upstream trace is present.
      const activeTrace = getActiveTraceContext();
      if (activeTrace) {
        headers['traceparent'] = buildTraceparent(
          activeTrace.traceId,
          activeTrace.parentId,
          activeTrace.sampled,
        );
      }

      const response = await this.followRedirects(
        url,
        {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        },
        deliveryId,
        eventType,
      );

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

      const response = await followFetchRedirects(url, { method: 'HEAD' }, 1, 'endpoint validation');

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
  // Validate webhook target for SSRF protection before any network call
  try {
    const allowlist = webhookAllowlist();
    await validateWebhookTarget(opts.url, {
      allowlist,
    });
  } catch (error) {
    if (error instanceof WebhookTargetValidationError) {
      logger.error('Webhook target rejected by SSRF guard', undefined, {
        reason: error.message,
      });
      throw error;
    }
    throw error;
  }

  // Optional reorg suppression: callers that pass a ledger number opt in to
  // skipping delivery for ledgers the indexer has rolled back. The imports are
  // dynamic to avoid hard dependencies on the indexer module graph.
  if (typeof opts.ledger === 'number') {
    const [{ webhookDeliveriesSuppressedTotal }, { isLedgerRolledBack }] = await Promise.all([
      import('../metrics/businessMetrics.js'),
      import('../indexer/service.js'),
    ]);
    if (isLedgerRolledBack(opts.ledger)) {
      // Increment suppressed counter with outcome label
      webhookDeliveriesSuppressedTotal.inc({ outcome: 'suppressed' });
      return;
    }
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadStr = JSON.stringify(opts.payload);
  const signature = computeWebhookSignature(opts.secret, timestamp, payloadStr);

  // Add AbortController timeout to prevent slow-loris attacks
  const controller = new AbortController();
  const timeoutMs = DEFAULT_RETRY_POLICY.timeoutMs;
  const timeoutId = setTimeout(() => controller.abort(new DOMException('Webhook delivery timeout', 'TimeoutError')), timeoutMs);

  try {
    await followFetchRedirects(opts.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fluxora-Event': opts.event,
        'X-Fluxora-Signature': signature,
        'X-Fluxora-Timestamp': timestamp,
      },
      body: payloadStr,
      signal: controller.signal,
    }, 1, 'webhook dispatch');
  } finally {
    clearTimeout(timeoutId);
  }
}
