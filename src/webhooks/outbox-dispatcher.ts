/** Transactional outbox polling and batch orchestration for webhook delivery. */
import { logger } from '../lib/logger.js';
import { getPool } from '../db/pool.js';
import type { EnhancedRetryPolicy } from './retry.js';
import type { WebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import type { IWebhookRateLimiter, RateLimitConfig } from '../redis/webhookRateLimit.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { loadConfig } from '../config/env.js';
import { WebhookService } from './delivery.js';
import { deliverOutboxRow, type DbClient, type OutboxRow } from './outbox-row.js';
import {
  assertSafeWebhookEndpoint,
  normalizePayload,
  resolveWebhookRetryPolicy,
} from './delivery-support.js';

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
  rateLimiter?: IWebhookRateLimiter;
  rateLimitConfig?: RateLimitConfig;
}
interface ResolvedEndpoint {
  endpointUrl: string;
  secret: string;
}

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
  private readonly rateLimiter?: IWebhookRateLimiter;
  private readonly rateLimitConfig: RateLimitConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  /** Consecutive processBatch failures; reset to 0 on first success. */
  private consecutiveBatchFailures = 0;
  /** Current backoff delay in ms (0 = no backoff). */
  private currentBatchBackoffMs = 0;

  constructor(options: WebhookDispatcherOptions = {}) {
    const config = loadConfig();
    this.endpointUrl = options.endpointUrl ?? config.webhookUrl;
    this.secret = options.secret ?? config.webhookSecret;
    this.pollIntervalMs = options.pollIntervalMs ?? config.webhookPollIntervalMs;
    this.batchSize = options.batchSize ?? config.webhookBatchSize;
    this.maxBatchBackoffMs = options.maxBatchBackoffMs ?? config.webhookBatchMaxBackoffMs;
    this.pool = options.pool ?? (getPool() as unknown as DbPool);
    this.policy = resolveWebhookRetryPolicy(options.policy);
    this.circuitBreakerStore = options.circuitBreakerStore ?? getWebhookCircuitBreakerStore();
    this.rateLimiter = options.rateLimiter ?? new TokenBucketRateLimiter();
    this.rateLimitConfig = options.rateLimitConfig ?? {
      limit: config.webhookRetryRps,
      windowMs: 1000,
      burst: config.webhookRetryBurst,
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
        await deliverOutboxRow(client, row, {
          endpointUrl: this.endpointUrl,
          secret: this.secret,
          policy: this.policy,
          service: this.service,
          circuitBreakerStore: this.circuitBreakerStore,
          rateLimiter: this.rateLimiter,
          rateLimitConfig: this.rateLimitConfig,
          resolveEndpoint: (outboxRow) => this.resolveEndpoint(outboxRow),
        });
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
