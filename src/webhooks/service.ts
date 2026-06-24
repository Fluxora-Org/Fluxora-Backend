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
import { calculateNextRetryTime, shouldRetry } from './retry.js';
import { webhookDeliveriesTotal, webhookDeliveryDurationSeconds, webhookBatchFailuresTotal, webhookBatchBackoffMs } from '../metrics/businessMetrics.js';

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
  policy?: WebhookRetryPolicy;
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

    const correlationId = getCorrelationId();
    logger.info('Attempting webhook delivery', correlationId !== 'unknown' ? correlationId : undefined, {
      deliveryId: delivery.deliveryId,
      attempt: attemptNumber,
      maxAttempts: this.policy.maxAttempts,
    });

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
        webhookDeliveriesTotal.inc({ outcome: 'failed' });
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
      webhookDeliveriesTotal.inc({ outcome: 'failed' });
    } finally {
      const durationSeconds = (Date.now() - startTime) / 1000;
      webhookDeliveryDurationSeconds.observe(durationSeconds);
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
  private readonly policy: WebhookRetryPolicy;
  private readonly service: WebhookService;
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
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.service = new WebhookService(this.policy);
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
        [this.batchSize],
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

  /**
   * Compute and store the next backoff value using full-jitter exponential
   * back-off: `min(cap, base * 2^n) * uniform(0.75, 1.25)`.
   *
   * The minimum base is `pollIntervalMs` so the first back-off is at least one
   * normal poll interval.  The maximum is `maxBatchBackoffMs` (bounded, so the
   * loop always eventually drains the outbox once Postgres recovers).
   */
  private recordBatchFailure(): void {
    this.consecutiveBatchFailures++;
    webhookBatchFailuresTotal.inc();

    const base = this.pollIntervalMs;
    const exponent = Math.min(this.consecutiveBatchFailures - 1, 30); // cap exponent to avoid overflow
    const uncapped = base * Math.pow(2, exponent);
    const capped = Math.min(uncapped, this.maxBatchBackoffMs);
    // ±25 % jitter
    const jitter = capped * (0.75 + Math.random() * 0.5);
    this.currentBatchBackoffMs = Math.round(jitter);

    webhookBatchBackoffMs.set(this.currentBatchBackoffMs);

    logger.warn('Webhook batch backoff applied', undefined, {
      consecutiveFailures: this.consecutiveBatchFailures,
      backoffMs: this.currentBatchBackoffMs,
      maxBackoffMs: this.maxBatchBackoffMs,
    });
  }

  private resetBatchBackoff(): void {
    if (this.consecutiveBatchFailures > 0) {
      logger.info('Webhook batch backoff reset after successful poll', undefined, {
        previousConsecutiveFailures: this.consecutiveBatchFailures,
      });
    }
    this.consecutiveBatchFailures = 0;
    this.currentBatchBackoffMs = 0;
    webhookBatchBackoffMs.set(0);
  }

  /** Expose backoff state for tests and health endpoints. */
  getBatchBackoffMs(): number {
    return this.currentBatchBackoffMs;
  }

  /** Expose consecutive failure count for tests. */
  getConsecutiveBatchFailures(): number {
    return this.consecutiveBatchFailures;
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

    await this.service.attemptDelivery(delivery, endpoint.secret);
    await client.query('UPDATE webhook_outbox SET processed = true WHERE id = $1', [row.id]);

    if (delivery.status === 'delivered' || delivery.status === 'permanent_failure') {
      return;
    }

    const retry = scheduleWebhookOutboxRetry({
      streamId: row.stream_id,
      eventType: row.event_type,
      payload,
      attemptNumber,
      policy: this.policy,
    });

    if (!retry.shouldRetry || !retry.retryAt) {
      return;
    }

    await client.query(
      `
        INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at, processed)
        VALUES ($1, $2, $3::jsonb, $4, false)
      `,
      [row.stream_id, row.event_type, JSON.stringify(retry.payload), retry.retryAt],
    );
  }
}

export const webhookService = new WebhookService();
export const webhookDispatcher = new WebhookDispatcher();
