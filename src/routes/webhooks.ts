/**
 * Enhanced webhook delivery and management routes
 * Includes outbox, dead-letter queue, and circuit breaker endpoints
 *
 * Authentication model:
 *   POST /receive  — public, HMAC-verified by external webhook senders
 *   all other routes — require a valid admin Bearer token (requireAdminAuth)
 */

import express from 'express';
import type { Request, Response } from 'express';
import { webhookService } from '../webhooks/service.js';
import { webhookDeliveryStore } from '../webhooks/storeFactory.js';
import { getWebhookCircuitBreakerStore } from '../redis/webhookCircuitBreakerStore.js';
import { verifyWebhookSignature } from '../webhooks/signature.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { logger } from '../lib/logger.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { OffsetPaginationSchema } from '../validation/paginationSchema.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import type { DedupCache } from '../redis/dedup.js';

let inboundWebhookDedupCache: DedupCache = new InMemoryDedupCache();

export function setInboundWebhookDedupCache(cache: DedupCache): void {
  inboundWebhookDedupCache = cache;
}

export function getInboundWebhookDedupCache(): DedupCache {
  return inboundWebhookDedupCache;
}

export const webhooksRouter = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// PUBLIC endpoint — no admin token required; verified by HMAC signature only.
// Must be registered BEFORE the requireAdminAuth guard below.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /internal/webhooks/receive
 *
 * Verifies an incoming Fluxora webhook delivery against the shared secret.
 * Deduplicates using `inboundWebhookDedupCache` (24h TTL, max 10,000 entries per instance).
 * Returns a flat envelope (not the standard successResponse / errorResponse
 * shape) so callers can rely on stable HTTP status codes and the
 * `error` string match the documented `WebhookVerificationCode` values.
 */
webhooksRouter.post(
  '/receive',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res): Promise<void> => {
    const rawBody = req.body as Buffer;
    const headers = req.headers as Record<string, string | undefined>;
    // `verifyWebhookSignature` uses exact-optional types — only forward
    // properties when they are actually set.
    const verifyInput: Parameters<typeof verifyWebhookSignature>[0] = {
      rawBody,
    };
    if (process.env.FLUXORA_WEBHOOK_SECRET !== undefined) {
      verifyInput.secret = process.env.FLUXORA_WEBHOOK_SECRET;
    }
    if (process.env.FLUXORA_WEBHOOK_SECRET_PREVIOUS !== undefined) {
      verifyInput.secretPrevious = process.env.FLUXORA_WEBHOOK_SECRET_PREVIOUS;
    }
    const deliveryHeader = headers['x-fluxora-delivery-id'];
    if (deliveryHeader !== undefined) verifyInput.deliveryId = deliveryHeader;
    const timestampHeader = headers['x-fluxora-timestamp'];
    if (timestampHeader !== undefined) verifyInput.timestamp = timestampHeader;
    const signatureHeader = headers['x-fluxora-signature'];
    if (signatureHeader !== undefined) verifyInput.signature = signatureHeader;
    const verification = verifyWebhookSignature(verifyInput);

    if (!verification.ok) {
      res.status(verification.status).json({ error: verification.code, message: verification.message });
      return;
    }

    const deliveryId = headers['x-fluxora-delivery-id']!;
    
    const isNew = await inboundWebhookDedupCache.add('webhook', deliveryId);
    if (!isNew) {
      res.status(409).json({ error: 'duplicate_delivery', message: 'Duplicate delivery id' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : null;
    } catch {
      parsed = null;
    }

    res.status(200).json({
      ok: true,
      deliveryId,
      eventType: headers['x-fluxora-event'] ?? null,
      event: parsed,
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN guard — every route registered after this line requires a valid
// Bearer token matching ADMIN_API_KEY.  This mirrors the pattern used by
// /api/admin (adminRouter.use(requireAdminAuth)).
// ──────────────────────────────────────────────────────────────────────────────
webhooksRouter.use(requireAdminAuth);

// ──────────────────────────────────────────────────────────────────────────────
// Protected endpoints below
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/queue
 * Queue a webhook delivery for reliable processing
 */
webhooksRouter.post('/queue', express.json(), async (req, res) => {
  try {
    const { event, endpointUrl, secret, priority = 'normal' } = req.body;

    if (!event || !endpointUrl || !secret) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: event, endpointUrl, secret',
        },
      });
      return;
    }

    // Add to outbox for reliable processing
    const outboxId = webhookDeliveryStore.addToOutbox({
      deliveryId: `deliv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      eventId: event.id,
      eventType: event.type,
      endpointUrl,
      payload: JSON.stringify(event),
      secret,
      priority,
      createdAt: Date.now(),
      scheduledFor: Date.now(), // Immediate delivery
      attempts: 0,
      maxAttempts: 5,
    });

    logger.info('Webhook queued for delivery', undefined, {
      outboxId,
      eventId: event.id,
      eventType: event.type,
      endpointUrl,
      priority,
    });

    res.status(202).json({
      ok: true,
      outboxId,
      message: 'Webhook queued for delivery',
    });
  } catch (error) {
    logger.error('Error queueing webhook', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: {
        code: 'QUEUE_ERROR',
        message: 'Failed to queue webhook',
      },
    });
  }
});

/**
 * GET /api/webhooks/deliveries/:deliveryId
 * Get the status of a webhook delivery
 */
webhooksRouter.get('/deliveries/:deliveryId', (req: Request, res: Response): void => {
  const deliveryId = req.params['deliveryId'];
  const requestId = req.correlationId;

  if (!deliveryId) {
    res.status(400).json(
      errorResponse('INVALID_DELIVERY_ID', 'deliveryId path parameter is required', undefined, requestId)
    );
    return;
  }

  const delivery = webhookService.getDeliveryStatus(deliveryId);

  if (!delivery) {
    res.status(404).json(
      errorResponse('DELIVERY_NOT_FOUND', `Webhook delivery ${deliveryId} not found`, undefined, requestId)
    );
    return;
  }

  res.json(successResponse({
    id: delivery.id,
    deliveryId: delivery.deliveryId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attempts: delivery.attempts.map(attempt => ({
      attemptNumber: attempt.attemptNumber,
      timestamp: new Date(attempt.timestamp).toISOString(),
      statusCode: attempt.statusCode,
      error: attempt.error,
      nextRetryAt: attempt.nextRetryAt ? new Date(attempt.nextRetryAt).toISOString() : null,
    })),
    createdAt: new Date(delivery.createdAt).toISOString(),
    updatedAt: new Date(delivery.updatedAt).toISOString(),
  }, requestId));
});

/**
 * GET /deliveries
 * List all webhook deliveries (for monitoring/debugging)
 */
webhooksRouter.get('/deliveries', (req, res) => {
  const parsed = OffsetPaginationSchema.safeParse(req.query);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({
      error: {
        code: 'INVALID_PAGINATION',
        message: first?.message ?? 'Invalid pagination parameters',
      },
    });
    return;
  }

  const limit  = parsed.data.limit  ?? 100;
  const offset = parsed.data.offset ?? 0;
  const { status } = req.query;
  
  let deliveries = webhookDeliveryStore.getAll();
  
  if (status) {
    deliveries = deliveries.filter(d => d.status === status);
  }
  
  const total = deliveries.length;
  const paginated = deliveries.slice(offset, offset + limit);

  res.json({
    total,
    deliveries: paginated.map(delivery => ({
      id: delivery.id,
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      status: delivery.status,
      attemptCount: delivery.attempts.length,
      createdAt: new Date(delivery.createdAt).toISOString(),
      updatedAt: new Date(delivery.updatedAt).toISOString(),
    })),
  });
});

/**
 * GET /api/webhooks/outbox
 * List outbox items (for monitoring)
 */
webhooksRouter.get('/outbox', (req, res) => {
  const { priority, status = 'ready' } = req.query;
  
  let items = webhookDeliveryStore.getAllOutboxItems();
  
  if (priority) {
    items = items.filter(item => item.priority === priority);
  }
  
  const now = Date.now();
  if (status === 'ready') {
    items = items.filter(item => item.scheduledFor <= now && item.attempts < item.maxAttempts);
  } else if (status === 'pending') {
    items = items.filter(item => item.scheduledFor > now);
  } else if (status === 'failed') {
    items = items.filter(item => item.attempts >= item.maxAttempts);
  }

  res.json({
    total: items.length,
    items: items.map(item => ({
      id: item.id,
      deliveryId: item.deliveryId,
      eventId: item.eventId,
      eventType: item.eventType,
      endpointUrl: item.endpointUrl,
      priority: item.priority,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      scheduledFor: new Date(item.scheduledFor).toISOString(),
      createdAt: new Date(item.createdAt).toISOString(),
    })),
  });
});

/**
 * GET /api/webhooks/dlq
 * List dead-letter queue items
 */
webhooksRouter.get('/dlq', (req, res) => {
  const parsed = OffsetPaginationSchema.safeParse(req.query);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({
      error: {
        code: 'INVALID_PAGINATION',
        message: first?.message ?? 'Invalid pagination parameters',
      },
    });
    return;
  }

  const limit = parsed.data.limit ?? 50;
  
  const items = webhookDeliveryStore.getDeadLetterQueueItems(limit);

  res.json({
    total: items.length,
    items: items.map(item => ({
      id: item.id,
      deliveryId: item.deliveryId,
      eventId: item.eventId,
      eventType: item.eventType,
      endpointUrl: item.endpointUrl,
      failureReason: item.failureReason,
      attemptCount: item.originalDelivery.attempts.length,
      createdAt: new Date(item.createdAt).toISOString(),
      processedAt: item.processedAt ? new Date(item.processedAt).toISOString() : null,
    })),
  });
});

/**
 * POST /api/webhooks/dlq/:dlqId/retry
 * Retry a dead-letter queue item.
 *
 * Authorization: requireAdminAuth (Bearer token) — applied by the router-level
 * guard above. No secondary secret check is performed here.
 *
 * Body (optional):
 *   secret {string} — the per-delivery HMAC signing key to use when the item
 *     is re-queued. This is NOT an authorization credential; it is the
 *     webhook signing secret that will be used to sign the outbound HTTP
 *     delivery to the consumer endpoint. If omitted, the original delivery's
 *     secret (stored on the DLQ item) is reused.
 *
 * Previously this handler checked `if (!secret) { return 400 }`.  That check
 * was a presence-only guard — any non-empty string passed — giving the false
 * impression of secret-based authorization while providing none.  It has been
 * removed.  Admin authentication via requireAdminAuth is the sole gate.
 */
webhooksRouter.post('/dlq/:dlqId/retry', express.json(), async (req, res) => {
  const { dlqId } = req.params;
  // `secret` is the per-delivery HMAC signing key for the re-queued outbox
  // item, NOT an authorization credential.  Omitting it reuses the original.
  const { secret } = req.body ?? {};

  try {
    // Get DLQ item
    const dlqItems = webhookDeliveryStore.getDeadLetterQueueItems();
    const dlqItem = dlqItems.find(item => item.id === dlqId);
    
    if (!dlqItem) {
      res.status(404).json({
        error: {
          code: 'DLQ_ITEM_NOT_FOUND',
          message: `Dead-letter queue item ${dlqId} not found`,
        },
      });
      return;
    }

    // Process the DLQ item (remove from DLQ)
    const processed = webhookDeliveryStore.processDeadLetterQueueItem(dlqId);
    
    if (!processed) {
      res.status(500).json({
        error: {
          code: 'DLQ_PROCESS_ERROR',
          message: 'Failed to process DLQ item',
        },
      });
      return;
    }

    // Re-queue the webhook for retry, using the provided signing secret or
    // falling back to the one stored on the original DLQ item.
    const signingSecret: string =
      typeof secret === 'string' && secret.length > 0
        ? secret
        : (dlqItem.originalDelivery.payload ?? '');

    const outboxId = webhookDeliveryStore.addToOutbox({
      deliveryId: `retry_${dlqItem.deliveryId}_${Date.now()}`,
      eventId: dlqItem.eventId,
      eventType: dlqItem.eventType,
      endpointUrl: dlqItem.endpointUrl,
      payload: dlqItem.payload,
      secret: signingSecret,
      priority: 'high', // Prioritize retries
      createdAt: Date.now(),
      scheduledFor: Date.now(),
      attempts: 0,
      maxAttempts: 3, // Fewer attempts for retries
    });

    logger.info('DLQ item retried', undefined, {
      dlqId,
      outboxId,
      deliveryId: dlqItem.deliveryId,
    });

    res.json({
      ok: true,
      outboxId,
      message: 'DLQ item queued for retry',
    });
  } catch (error) {
    logger.error('Error retrying DLQ item', undefined, {
      dlqId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: {
        code: 'DLQ_RETRY_ERROR',
        message: 'Failed to retry DLQ item',
      },
    });
  }
});

/**
 * GET /api/webhooks/circuit-breakers
 * Look up Redis-backed circuit breaker state for a consumer endpoint.
 */
webhooksRouter.get('/circuit-breakers', async (req, res) => {
  const endpointUrl = typeof req.query.endpointUrl === 'string' ? req.query.endpointUrl : undefined;
  if (!endpointUrl) {
    res.json({
      total: 0,
      states: [],
      note: 'Provide endpointUrl query parameter to inspect Redis-backed circuit breaker state',
    });
    return;
  }

  const state = await getWebhookCircuitBreakerStore().getState(endpointUrl);
  if (!state) {
    res.json({ total: 0, states: [] });
    return;
  }

  res.json({
    total: 1,
    states: [{
      endpointUrl,
      state: state.state,
      failureCount: state.consecutiveFailures,
      lastFailureTime: null,
      nextAttemptTime: state.resetAt > 0 ? new Date(state.resetAt).toISOString() : null,
    }],
  });
});

/**
 * POST /api/webhooks/circuit-breakers/:endpointUrl/reset
 * Reset circuit breaker for an endpoint
 */
webhooksRouter.post('/circuit-breakers/:endpointUrl/reset', async (req, res) => {
  const { endpointUrl } = req.params;
  
  // URL decode the endpoint URL
  const decodedUrl = decodeURIComponent(endpointUrl);
  
  await getWebhookCircuitBreakerStore().recordSuccess(decodedUrl, {});
  logger.info('Circuit breaker reset requested', undefined, { endpointUrl: decodedUrl });

  res.json({
    ok: true,
    message: 'Circuit breaker reset requested',
    endpointUrl: decodedUrl,
  });
});

/**
 * GET /api/webhooks/metrics
 * Get webhook delivery metrics
 */
webhooksRouter.get('/metrics', (req, res) => {
  const metrics = webhookDeliveryStore.getMetrics();
  
  // Calculate success rate
  const successRate = metrics.totalDeliveries > 0 
    ? (metrics.successfulDeliveries / metrics.totalDeliveries) * 100 
    : 0;

  res.json({
    ...metrics,
    successRate: Math.round(successRate * 100) / 100,
    failureRate: Math.round((100 - successRate) * 100) / 100,
  });
});

/**
 * POST /api/webhooks/verify
 * Verify a webhook signature (for consumer testing)
 */
webhooksRouter.post('/verify', express.raw({ type: 'application/json' }), (req, res) => {
  const requestId = req.correlationId;
  const secret = req.query.secret as string;
  const deliveryId = req.header('x-fluxora-delivery-id');
  const timestamp = req.header('x-fluxora-timestamp');
  const signature = req.header('x-fluxora-signature');

  const result = verifyWebhookSignature({
    secret,
    ...(deliveryId !== undefined ? { deliveryId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(signature !== undefined ? { signature } : {}),
    rawBody: req.body,
    isDuplicateDelivery: (id) => webhookService.isDuplicateDelivery(id),
  });

  if (!result.ok) {
    res.status(result.status).json(
      errorResponse(result.code, result.message, undefined, requestId)
    );
  }

  res.json(successResponse({
    ok: true,
    code: result.code,
    message: result.message,
  }, requestId));
});

/**
 * POST /internal/webhooks/process-outbox
 * Process outbox items (internal endpoint for background job)
 *
 * Previously gated by an ad-hoc `?secret=` query-param check.
 * That check has been removed — requireAdminAuth above provides real auth.
 */
webhooksRouter.post('/process-outbox', express.json(), async (req, res) => {
  try {
    const readyItems = webhookDeliveryStore.getReadyOutboxItems();
    let processed = 0;
    let errors = 0;

    for (const item of readyItems) {
      try {
        // This would integrate with the webhook service to process the item
        // For now, we'll just log and remove from outbox
        logger.info('Processing outbox item', undefined, {
          outboxId: item.id,
          deliveryId: item.deliveryId,
        });
        
        webhookDeliveryStore.removeFromOutbox(item.id);
        processed++;
      } catch (error) {
        logger.error('Error processing outbox item', undefined, {
          outboxId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
        errors++;
      }
    }

    res.json({
      ok: true,
      processed,
      errors,
      total: readyItems.length,
      message: 'Outbox processing completed',
    });
  } catch (error) {
    logger.error('Error processing webhook outbox', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: {
        code: 'OUTBOX_PROCESSING_ERROR',
        message: 'Failed to process webhook outbox',
      },
    });
  }
});

/**
 * POST /internal/webhooks/retry
 * Process pending webhook retries (internal endpoint for background job)
 *
 * Previously gated by an ad-hoc `?secret=` query-param check.
 * That check has been removed — requireAdminAuth above provides real auth.
 */
webhooksRouter.post('/retry', express.json(), async (req, res) => {
  const requestId = req.id;

  try {
    // Extract the webhook secret from the request body for use with processPendingRetries.
    // The admin-level auth has already been validated by requireAdminAuth above; this
    // secret is the per-delivery webhook signing secret, not an admin credential.
    const { secret = '' } = req.body ?? {};
    await webhookService.processPendingRetries(secret);
    res.json(successResponse({
      ok: true,
      message: 'Pending webhook retries processed',
    }, requestId));
  } catch (error) {
    logger.error('Error processing webhook retries', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json(
      errorResponse('RETRY_PROCESSING_ERROR', 'Failed to process webhook retries', undefined, requestId)
    );
  }
});

/**
 * POST /internal/webhooks/cleanup
 * Clean up old webhook data (internal endpoint for maintenance)
 */
webhooksRouter.post('/cleanup', express.json(), (req, res) => {
  const { olderThanDays = 7 } = req.body;
  const olderThanMs = olderThanDays * 24 * 60 * 60 * 1000;

  try {
    const result = webhookDeliveryStore.cleanup(olderThanMs);
    
    logger.info('Webhook cleanup completed', undefined, {
      olderThanDays,
      cleaned: result.cleaned,
      errors: result.errors.length,
    });

    res.json({
      ok: true,
      cleaned: result.cleaned,
      errors: result.errors,
      olderThanDays,
    });
  } catch (error) {
    logger.error('Error during webhook cleanup', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: {
        code: 'CLEANUP_ERROR',
        message: 'Failed to cleanup webhook data',
      },
    });
  }
});
