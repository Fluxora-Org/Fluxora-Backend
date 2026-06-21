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
} from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { webhookDeliveryStore } from './store.js';
import { computeWebhookSignature } from './signature.js';
import { calculateNextRetryTime, shouldRetry, checkWebhookDeliveryGate, attemptWebhookDeliveryWithRateLimit, countsTowardCircuitBreaker, type EnhancedRetryPolicy } from './retry.js';
import { webhookDeliveriesTotal, webhookDeliveryDurationSeconds } from '../metrics/businessMetrics.js';
import type { WebhookCircuitBreakerStore, CircuitBreakerPolicy } from '../redis/webhookCircuitBreakerStore.js';
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
    ...(threshold > 0 ? { circuitBreakerThreshold: threshold, circuitBreakerResetMs: resetMs } : {}),
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

  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
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

  return webhookDeliveryStore.addToDeadLetterQueue(delivery, failureReason);
}

export class WebhookService {
  private policy: EnhancedRetryPolicy;
  private readonly circuitBreakerStore: WebhookCircuitBreakerStore;

  constructor(
    policy: EnhancedRetryPolicy = resolveWebhookRetryPolicy(),
    circuitBreakerStore: WebhookCircuitBreakerStore = getWebhookCircuitBreakerStore(),
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
    timestamp?: string,
  ): Promise<WebhookDeliveryAttempt> {
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();
    const attemptNumber = delivery.attempts.length + 1;
    const correlationId = getCorrelationId();
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
        correlationId,
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
        webhookDeliveriesTotal.inc({ outcome: 'success' });
      } else {
        delivery.attempts.push(attempt);
        delivery.status = 'pending';
        webhookDeliveryStore.store(delivery);
        webhookDeliveriesTotal.inc({ outcome: 'failed' });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
    attempt: WebhookDeliveryAttempt,
  ): Promise<number> {
    const success =
      attempt.statusCode !== undefined &&
      attempt.statusCode >= 200 &&
      attempt.statusCode < 300 &&
      !attempt.error;

    if (success) {
      const record = await this.circuitBreakerStore.recordSuccess(
        endpointUrl,
        this.policy as CircuitBreakerPolicy,
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
      Date.now(),
    );
    return record.consecutiveFailures;
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

    const correlationId = getCorrelationId();
    logger.info('Attempting webhook delivery', correlationId !== 'unknown' ? correlationId : undefined, {
      deliveryId: delivery.deliveryId,
      attempt: attemptNumber,
      maxAttempts: this.policy.maxAttempts,
    });

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
  private readonly pool: DbPool;
  private readonly policy: EnhancedRetryPolicy;
  private readonly service: WebhookService;
  private readonly circuitBreakerStore: WebhookCircuitBreakerStore;
  private readonly rateLimiter?: WebhookRateLimiter;
  private readonly rateLimitConfig: RateLimitConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;

  constructor(options: WebhookDispatcherOptions = {}) {
    this.endpointUrl = options.endpointUrl ?? process.env.WEBHOOK_URL;
    this.secret = options.secret ?? process.env.WEBHOOK_SECRET;
    this.pollIntervalMs =
      options.pollIntervalMs ?? parsePositiveInteger(process.env.WEBHOOK_POLL_INTERVAL_MS, 10_000);
    this.batchSize = options.batchSize ?? parsePositiveInteger(process.env.WEBHOOK_BATCH_SIZE, 10);
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
      logger.warn('Webhook outbox dispatcher disabled; WEBHOOK_URL and WEBHOOK_SECRET are required');
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
    const payloadObject = typeof payload === 'object' && payload !== null
      ? payload as Record<string, unknown>
      : {};
    const endpointUrl =
      typeof payloadObject['endpointUrl'] === 'string' ? payloadObject['endpointUrl'] : this.endpointUrl;
    const secret =
      typeof payloadObject['secret'] === 'string' ? payloadObject['secret'] : this.secret;

    assertSafeWebhookEndpoint(endpointUrl);
    return { endpointUrl, secret };
  }

  private async processBatch(): Promise<void> {
    const endpoint = this.endpointUrl && this.secret;
    if (!endpoint) return;

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
        [this.batchSize],
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return;
      }

      for (const row of result.rows) {
        await this.deliverRow(client, row);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error('Webhook outbox dispatcher batch failed', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client.release();
    }
  }

  private async deliverRow(client: DbClient, row: OutboxRow): Promise<void> {
    const endpoint = this.resolveEndpoint(row);
    if (!endpoint) {
      logger.warn('Webhook outbox row skipped; no endpoint configured', undefined, { outboxId: row.id });
      return;
    }

    const payload = normalizePayload(row.payload);
    const payloadString = JSON.stringify(payload);
    const attemptNumber = extractAttemptNumber(payload);
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
      },
    );

    await client.query('UPDATE webhook_outbox SET processed = true WHERE id = $1', [row.id]);

    if (!result.attempt) {
      if (result.shouldRetry && result.retryAt) {
        await client.query(
          `
            INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at, processed)
            VALUES ($1, $2, $3::jsonb, $4, false)
          `,
          [row.stream_id, row.event_type, JSON.stringify(payload), result.retryAt],
        );
      }
      return;
    }

    const attempt = result.attempt;
    if (result.shouldRetry) {
      attempt.nextRetryAt = result.retryAt?.getTime() ?? calculateNextRetryTime(attemptNumber, this.policy);
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
      [row.stream_id, row.event_type, JSON.stringify(result.payload), result.retryAt],
    );
  }
}

export const webhookService = new WebhookService();
export const webhookDispatcher = new WebhookDispatcher();
