/** Process one claimed transactional-outbox row and schedule its next state. */
import { logger } from '../lib/logger.js';
import type { WebhookEvent, WebhookDelivery, DLQReasonCode } from './types.js';
import {
  calculateNextRetryTime,
  attemptWebhookDeliveryWithRateLimit,
  type EnhancedRetryPolicy,
} from './retry.js';
import type { WebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import type { IWebhookRateLimiter, RateLimitConfig } from '../redis/webhookRateLimit.js';
import { WebhookService } from './delivery.js';
import {
  classifyPoisonFailure,
  enqueuePermanentFailureToDlq,
  extractAttemptNumber,
  normalizePayload,
  validateWebhookPayload,
  validateWebhookUrl,
} from './delivery-support.js';

export interface OutboxRow {
  id: string;
  stream_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
}
export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}
export interface OutboxDeliveryContext {
  endpointUrl?: string;
  secret?: string;
  policy: EnhancedRetryPolicy;
  service: WebhookService;
  circuitBreakerStore: WebhookCircuitBreakerStore;
  rateLimiter?: IWebhookRateLimiter;
  rateLimitConfig: RateLimitConfig;
  resolveEndpoint(row: OutboxRow): ResolvedEndpoint | null;
}
interface ResolvedEndpoint {
  endpointUrl: string;
  secret: string;
}

export async function deliverOutboxRow(
  client: DbClient,
  row: OutboxRow,
  context: OutboxDeliveryContext
): Promise<void> {
  const endpoint = context.resolveEndpoint(row);
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
      policy: context.policy,
    },
    () => context.service.runDeliveryAttempt(delivery, endpoint.secret),
    {
      circuitBreakerStore: context.circuitBreakerStore,
      rateLimiter: context.rateLimiter,
      rateLimitConfig: context.rateLimitConfig,
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
    context.policy,
    attempt.error
  );

  if (failureReasonCode === 'poison' || failureReasonCode === 'timeout') {
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
      result.retryAt?.getTime() ?? calculateNextRetryTime(attemptNumber, context.policy);
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
