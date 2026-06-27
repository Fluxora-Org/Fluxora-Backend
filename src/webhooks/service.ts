/**
 * Webhook delivery service
 * Handles sending webhooks with retry logic
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { CORRELATION_ID_HEADER } from '../middleware/correlationId.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { getPool } from '../db/pool.js';
import type {
  WebhookEvent,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookRetryPolicy,
  DLQReasonCode,
} from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { webhookDeliveryStore } from './store.js';
import { computeWebhookSignature } from './signature.js';
import {
  calculateNextRetryTime,
  scheduleWebhookOutboxRetry,
  shouldRetry,
  isRetryableStatusCode,
  checkWebhookDeliveryGate,
  attemptWebhookDeliveryWithRateLimit,
  countsTowardCircuitBreaker,
  type EnhancedRetryPolicy,
} from './retry.js';
import {
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
} from '../metrics/businessMetrics.js';
import type {
  WebhookCircuitBreakerStore,
  CircuitBreakerPolicy,
} from '../redis/webhookCircuitBreakerStore.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import type { WebhookRateLimiter, RateLimitConfig } from '../redis/webhookRateLimit.js';
import { DEFAULT_WEBHOOK_RETRY_RPS } from '../redis/webhookRateLimit.js';

interface OutboxRow {
  id: string;
  stream_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
}

interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

interface DbPool {
  connect(): Promise<DbClient>;
}

export interface WebhookDispatcherOptions {
  endpointUrl?: string;
  secret?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  maxBatchBackoffMs?: number;
  pool?: DbPool;
  policy?: EnhancedRetryPolicy;
  circuitBreakerStore?: WebhookCircuitBreakerStore;
  rateLimiter?: WebhookRateLimiter;
  rateLimitConfig?: RateLimitConfig;
}

interface ResolvedEndpoint {
  endpointUrl: string;
  secret: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveWebhookRetryPolicy(override?: EnhancedRetryPolicy): EnhancedRetryPolicy {
  const threshold = parseNonNegativeInteger(process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD, 0);
  const resetMs = parsePositiveInteger(process.env.WEBHOOK_CIRCUIT_BREAKER_RESET_MS, 300_000);
  return {
    ...DEFAULT_RETRY_POLICY,
    ...(threshold > 0
      ? { circuitBreakerThreshold: threshold, circuitBreakerResetMs: resetMs }
      : {}),
    ...override,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function assertSafeWebhookEndpoint(endpointUrl: string): void {
  const url = new URL(endpointUrl);

  if (url.username || url.password) {
    throw new Error('Webhook endpoint must not include credentials');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Webhook endpoint must use http or https');
  }

  if (
    process.env.NODE_ENV === 'production' &&
    url.protocol !== 'https:' &&
    !isLoopbackHostname(url.hostname)
  ) {
    throw new Error('Webhook endpoint must use https in production');
  }
}

function normalizePayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }

  return payload;
}

function extractAttemptNumber(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 1;
  const retry = (payload as Record<string, unknown>)['_webhookRetry'];
  if (typeof retry !== 'object' || retry === null) return 1;
  const attemptNumber = (retry as Record<string, unknown>)['attemptNumber'];
  return typeof attemptNumber === 'number' && Number.isFinite(attemptNumber) && attemptNumber > 0
    ? Math.floor(attemptNumber)
    : 1;
}

function enqueuePermanentFailureToDlq(
  delivery: WebhookDelivery,
  failureReason: string,
  reasonCode: DLQReasonCode = 'other'
): string | undefined {
  const alreadyQueued = webhookDeliveryStore
    .getDeadLetterQueueItems()
    .some((item) => item.deliveryId === delivery.deliveryId);

  if (alreadyQueued) {
    logger.warn('Webhook permanent failure already exists in dead-letter queue', undefined, {
      deliveryId: delivery.deliveryId,
    });
    return undefined;
  }

  return webhookDeliveryStore.addToDeadLetterQueue(delivery, failureReason, reasonCode);
}

/**
 * Validate a webhook payload for structural integrity.
 *
 * A payload is considered structurally invalid if:
 * - It is a non-empty string that fails to parse as JSON (unless it's a simple string)
 * - It is excessively large (>10MB to prevent resource exhaustion)
 * - It appears to be binary garbage (contains non-UTF8 characters)
 *
 * @throws {string} Error message describing the validation failure, if the payload is poisoned
 */
function validateWebhookPayload(payload: unknown): void {
  // Check if payload is oversized (potential DoS vector)
  if (typeof payload === 'string' && payload.length > 10 * 1024 * 1024) {
    throw 'Payload exceeds maximum size of 10MB (likely garbage or DoS attempt)';
  }

  // If it's a string, verify it's valid JSON or a reasonable simple string
  if (typeof payload === 'string') {
    // Try to parse as JSON first
    try {
      JSON.parse(payload);
      // Successfully parsed - this is valid JSON
      return;
    } catch {
      // Failed to parse. Check if this looks like an attempt at JSON (starts with { or [)
      const trimmed = payload.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // Looks like JSON but failed to parse - definitely poison
        throw `Payload starts with JSON marker but is not valid JSON`;
      }

      // If it's not JSON-like, check if it's binary garbage
      // Allow simple strings but reject if any character is outside printable ASCII range
      if (payload.length > 1000) {
        // Check if the first 100 chars contain any non-printable characters
        let hasNonPrintable = false;
        const checkStr = payload.substring(0, 100);
        for (let i = 0; i < checkStr.length; i++) {
          const code = checkStr.charCodeAt(i);
          // Allow printable ASCII (0x20-0x7E) and common whitespace (0x09, 0x0A, 0x0D)
          if (
            !((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d)
          ) {
            hasNonPrintable = true;
            break;
          }
        }
        if (hasNonPrintable) {
          throw 'Payload appears to be binary garbage (non-UTF8 characters detected)';
        }
      }
    }
  }
}

/**
 * Validate a webhook endpoint URL for structural integrity.
 *
 * A URL is considered invalid (poison) if:
 * - It cannot be parsed as a valid URL
 * - It uses an unsupported protocol (not http/https)
 * - It includes credentials (security risk)
 *
 * @throws {string} Error message describing the validation failure
 */
function validateWebhookUrl(endpointUrl: string): void {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw `Webhook endpoint URL is unparseable: ${endpointUrl}`;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw `Webhook endpoint must use http or https, got: ${url.protocol}`;
  }

  if (url.username || url.password) {
    throw 'Webhook endpoint must not include credentials in URL';
  }
}

/**
 * Classify a delivery failure as "poison" (deterministic/non-retryable).
 *
 * A failure is poison if it will deterministically recur on every retry:
 * - Structurally invalid payload
 * - Unparseable endpoint URL
 * - Non-retryable HTTP status code (4xx except rate-limiting codes)
 *
 * Returns a DLQReasonCode to distinguish poison from exhausted retries.
 */
function classifyPoisonFailure(
  payload: unknown,
  endpointUrl: string,
  statusCode: number | undefined,
  policy: EnhancedRetryPolicy
): DLQReasonCode | null {
  // Check for structurally invalid payload
  try {
    validateWebhookPayload(payload);
  } catch {
    return 'poison';
  }

  // Check for unparseable URL
  try {
    validateWebhookUrl(endpointUrl);
  } catch {
    return 'poison';
  }

  // Check for non-retryable status codes (4xx except rate-limiting)
  if (statusCode !== undefined && !isRetryableStatusCode(statusCode, policy)) {
    if (statusCode >= 400 && statusCode < 500) {
      return 'poison';
    }
  }

  return null;
}

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
      const attempt: WebhookDeliveryAttempt = {
        attemptNumber: 1,
        timestamp: Date.now(),
        nextRetryAt: gate.retryAt!.getTime(),
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
          attempt.nextRetryAt = calculateNextRetryTime(attemptNumber, this.policy);
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
      const durationSeconds = (Date.now() - startTime) / 1000;
      webhookDeliveryDurationSeconds.observe(durationSeconds);
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
    const timeoutId = setTimeout(() => controller.abort(), this.policy.timeoutMs);

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
      const maxBytes = Number(process.env.WEBHOOK_MAX_RESPONSE_BYTES) || 64 * 1024;
      if (response.body) {
        const reader = response.body.getReader();
        let bytesRead = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.length;
          if (bytesRead > maxBytes) {
            controller.abort();
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
        const lastAttempt = delivery.attempts[delivery.attempts.length - 1];
        if (lastAttempt) {
          lastAttempt.nextRetryAt = gate.retryAt!.getTime();
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
export class WebhookDispatcher {
  private readonly endpointUrl?: string;
  private readonly secret?: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatchBackoffMs: number;
  private readonly pool: DbPool;
  private readonly policy: EnhancedRetryPolicy;
  private readonly service: WebhookService;
  private readonly circuitBreakerStore: WebhookCircuitBreakerStore;
  private readonly rateLimiter?: WebhookRateLimiter;
  private readonly rateLimitConfig: RateLimitConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  /** Consecutive processBatch failures; reset to 0 on first success. */
  private consecutiveBatchFailures = 0;
  /** Current backoff delay in ms (0 = no backoff). */
  private currentBatchBackoffMs = 0;

  constructor(options: WebhookDispatcherOptions = {}) {
    this.endpointUrl = options.endpointUrl ?? process.env.WEBHOOK_URL;
    this.secret = options.secret ?? process.env.WEBHOOK_SECRET;
    this.pollIntervalMs =
      options.pollIntervalMs ?? parsePositiveInteger(process.env.WEBHOOK_POLL_INTERVAL_MS, 10_000);
    this.batchSize = options.batchSize ?? parsePositiveInteger(process.env.WEBHOOK_BATCH_SIZE, 10);
    this.maxBatchBackoffMs =
      options.maxBatchBackoffMs ??
      parsePositiveInteger(process.env.WEBHOOK_BATCH_MAX_BACKOFF_MS, 60_000);
    this.pool = options.pool ?? (getPool() as unknown as DbPool);
    this.policy = resolveWebhookRetryPolicy(options.policy);
    this.circuitBreakerStore = options.circuitBreakerStore ?? getWebhookCircuitBreakerStore();
    this.rateLimiter = options.rateLimiter;
    this.rateLimitConfig = options.rateLimitConfig ?? {
      limit: parsePositiveInteger(process.env.WEBHOOK_RETRY_RPS, DEFAULT_WEBHOOK_RETRY_RPS),
      windowMs: 1000,
    };
    this.service = new WebhookService(this.policy, this.circuitBreakerStore);
  }

  start(): void {
    if (!this.stopped) return;

    if (!this.endpointUrl || !this.secret) {
      logger.warn(
        'Webhook outbox dispatcher disabled; WEBHOOK_URL and WEBHOOK_SECRET are required'
      );
      return;
    }

    assertSafeWebhookEndpoint(this.endpointUrl);
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    void this.pollOnce();
    logger.info('Webhook outbox dispatcher started', undefined, {
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.inFlight;
    logger.info('Webhook outbox dispatcher stopped');
  }

  async pollOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.processBatch().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private resolveEndpoint(row: OutboxRow): ResolvedEndpoint | null {
    if (!this.endpointUrl || !this.secret) return null;

    const payload = normalizePayload(row.payload);
    const payloadObject =
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const endpointUrl =
      typeof payloadObject['endpointUrl'] === 'string'
        ? payloadObject['endpointUrl']
        : this.endpointUrl;
    const secret =
      typeof payloadObject['secret'] === 'string' ? payloadObject['secret'] : this.secret;

    assertSafeWebhookEndpoint(endpointUrl);
    return { endpointUrl, secret };
  }

  /**
   * Execute one poll cycle against the webhook outbox.
   *
   * On consecutive database failures the method applies exponential back-off
   * with ±25 % jitter before returning, so the poll loop slows down
   * automatically when Postgres is degraded.  The back-off is capped at
   * `maxBatchBackoffMs` (default 60 s) and resets to zero on the first
   * successful batch.
   */
  private async processBatch(): Promise<void> {
    const endpoint = this.endpointUrl && this.secret;
    if (!endpoint) return;

    // Apply backoff delay accumulated from previous failures before querying.
    if (this.currentBatchBackoffMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.currentBatchBackoffMs));
      if (this.stopped) return;
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxRow>(
        `
          SELECT id, stream_id, event_type, payload, created_at
          FROM webhook_outbox
          WHERE processed = false
            AND created_at <= NOW()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [this.batchSize]
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        // Empty batch still counts as success — reset backoff.
        this.resetBatchBackoff();
        return;
      }

      for (const row of result.rows) {
        await this.deliverRow(client, row);
      }

      await client.query('COMMIT');
      // Successful batch — reset backoff.
      this.resetBatchBackoff();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error('Webhook outbox dispatcher batch failed', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordBatchFailure();
    } finally {
      client.release();
    }
  }

  private async deliverRow(client: DbClient, row: OutboxRow): Promise<void> {
    const endpoint = this.resolveEndpoint(row);
    if (!endpoint) {
      logger.warn('Webhook outbox row skipped; no endpoint configured', undefined, {
        outboxId: row.id,
      });
      return;
    }

    const payload = normalizePayload(row.payload);
    const payloadString = JSON.stringify(payload);
    const attemptNumber = extractAttemptNumber(payload);

    // ─────────────────────────────────────────────────────────────────────
    // POISON DETECTION: Check for structurally invalid or unparseable data
    // ─────────────────────────────────────────────────────────────────────
    let poisonReason: DLQReasonCode | null = null;

    try {
      validateWebhookPayload(payload);
    } catch (error) {
      poisonReason = 'poison';
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Webhook payload is structurally invalid (poison)', undefined, {
        outboxId: row.id,
        streamId: row.stream_id,
        error: errorMsg,
      });
    }

    // Check URL validity on first attempt to fail fast on unparseable URLs
    if (!poisonReason && attemptNumber === 1) {
      try {
        validateWebhookUrl(endpoint.endpointUrl);
      } catch (error) {
        poisonReason = 'poison';
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Webhook endpoint URL is unparseable (poison)', undefined, {
          outboxId: row.id,
          streamId: row.stream_id,
          url: endpoint.endpointUrl,
          error: errorMsg,
        });
      }
    }

    // Fast-track poison to DLQ without retrying
    if (poisonReason) {
      const delivery: WebhookDelivery = {
        id: `outbox_${row.id}`,
        deliveryId: `outbox_${row.id}`,
        eventId: row.stream_id,
        eventType: row.event_type as WebhookEvent['type'],
        endpointUrl: endpoint.endpointUrl,
        status: 'permanent_failure',
        attempts: [],
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: Date.now(),
        payload: payloadString,
      };

      enqueuePermanentFailureToDlq(
        delivery,
        'Webhook payload or endpoint is structurally invalid and non-retryable',
        poisonReason
      );

      await client.query('UPDATE webhook_outbox SET processed = true WHERE id = $1', [row.id]);
      return;
    }

    const delivery: WebhookDelivery = {
      id: `outbox_${row.id}`,
      deliveryId: `outbox_${row.id}`,
      eventId: row.stream_id,
      eventType: row.event_type as WebhookEvent['type'],
      endpointUrl: endpoint.endpointUrl,
      status: 'pending',
      attempts: Array.from({ length: Math.max(0, attemptNumber - 1) }, (_, index) => ({
        attemptNumber: index + 1,
        timestamp: Date.now(),
      })),
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: Date.now(),
      payload: payloadString,
    };

    const result = await attemptWebhookDeliveryWithRateLimit(
      {
        consumerUrl: endpoint.endpointUrl,
        streamId: row.stream_id,
        eventType: row.event_type,
        payload,
        attemptNumber,
        policy: this.policy,
      },
      () => this.service.runDeliveryAttempt(delivery, endpoint.secret),
      {
        circuitBreakerStore: this.circuitBreakerStore,
        rateLimiter: this.rateLimiter,
        rateLimitConfig: this.rateLimitConfig,
      }
    );

    await client.query('UPDATE webhook_outbox SET processed = true WHERE id = $1', [row.id]);

    if (!result.attempt) {
      if (result.shouldRetry && result.retryAt) {
        await client.query(
          `
            INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at, processed)
            VALUES ($1, $2, $3::jsonb, $4, false)
          `,
          [row.stream_id, row.event_type, JSON.stringify(payload), result.retryAt]
        );
      }
      return;
    }

    const attempt = result.attempt;

    // ─────────────────────────────────────────────────────────────────────
    // POISON DETECTION: Check for non-retryable status codes after first attempt
    // ─────────────────────────────────────────────────────────────────────
    const failureReasonCode = classifyPoisonFailure(
      payload,
      endpoint.endpointUrl,
      attempt.statusCode,
      this.policy
    );

    if (failureReasonCode === 'poison') {
      delivery.status = 'permanent_failure';
      delivery.attempts.push(attempt);

      logger.error('Webhook delivery detected as poison (non-retryable failure)', undefined, {
        deliveryId: delivery.deliveryId,
        statusCode: attempt.statusCode,
        error: attempt.error,
        attemptNumber,
      });

      enqueuePermanentFailureToDlq(
        delivery,
        attempt.error
          ? `Poison detected: ${attempt.error}`
          : `Poison detected: non-retryable status ${attempt.statusCode}`,
        'poison'
      );

      return;
    }

    if (result.shouldRetry) {
      attempt.nextRetryAt =
        result.retryAt?.getTime() ?? calculateNextRetryTime(attemptNumber, this.policy);
      delivery.status = 'pending';
    } else if (
      attempt.statusCode !== undefined &&
      attempt.statusCode >= 200 &&
      attempt.statusCode < 300 &&
      !attempt.error
    ) {
      delivery.status = 'delivered';
    } else {
      delivery.status = 'permanent_failure';
    }

    if (delivery.status === 'delivered' || delivery.status === 'permanent_failure') {
      return;
    }

    if (!result.shouldRetry || !result.retryAt) {
      return;
    }

    await client.query(
      `
        INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at, processed)
        VALUES ($1, $2, $3::jsonb, $4, false)
      `,
      [row.stream_id, row.event_type, JSON.stringify(result.payload), result.retryAt]
    );
  }

  /**
   * Reset the dispatcher batch back-off after a successful (or empty) batch.
   * Clears the consecutive-failure counter and the accumulated delay so the
   * poll loop returns to its normal cadence immediately.
   */
  private resetBatchBackoff(): void {
    this.consecutiveBatchFailures = 0;
    this.currentBatchBackoffMs = 0;
  }

  /**
   * Record a failed batch and grow the back-off delay exponentially with
   * ±25 % jitter, capped at `maxBatchBackoffMs`. The poll loop applies the
   * resulting delay before the next query so a degraded Postgres is not
   * hammered.
   */
  private recordBatchFailure(): void {
    this.consecutiveBatchFailures += 1;
    // Exponential base: pollInterval * 2^(failures-1), capped at the max.
    const base = this.pollIntervalMs * Math.pow(2, this.consecutiveBatchFailures - 1);
    const capped = Math.min(base, this.maxBatchBackoffMs);
    // ±25 % jitter to avoid thundering-herd retries.
    const jitter = capped * (Math.random() * 0.5 - 0.25);
    this.currentBatchBackoffMs = Math.max(0, Math.round(capped + jitter));
  }
}

export const webhookService = new WebhookService();
export const webhookDispatcher = new WebhookDispatcher();
