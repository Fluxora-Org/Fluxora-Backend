/**
 * Enhanced webhook delivery and management routes
 * Includes outbox, dead-letter queue, and circuit breaker endpoints
 */

import express from 'express';
import { webhookService } from '../webhooks/service.js';
import { webhookDeliveryStore, type DeadLetterQueueItem, type OutboxItem, type CircuitBreakerState } from '../webhooks/store.js';
import { verifyWebhookSignature } from '../webhooks/signature.js';
import { logger } from '../lib/logger.js';

export const webhooksRouter = express.Router();

/**
 * POST /api/webhooks/queue
 * Queue a webhook delivery for reliable processing
 */
webhooksRouter.post('/queue', express.json(), async (req, res) => {
  try {
    const { event, endpointUrl, secret, priority = 'normal' } = req.body;

    if (!event || !endpointUrl || !secret) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: event, endpointUrl, secret',
        },
      });
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

    logger.info('Webhook queued for delivery', {
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
webhooksRouter.get('/deliveries/:deliveryId', (req, res) => {
  const { deliveryId } = req.params;

  const delivery = webhookService.getDeliveryStatus(deliveryId);

  if (!delivery) {
    return res.status(404).json({
      error: {
        code: 'DELIVERY_NOT_FOUND',
        message: `Webhook delivery ${deliveryId} not found`,
      },
    });
  }

  res.json({
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
  });
});

/**
 * GET /api/webhooks/deliveries
 * List all webhook deliveries (for monitoring/debugging)
 */
webhooksRouter.get('/deliveries', (req, res) => {
  const { status, limit = 100, offset = 0 } = req.query;
  
  let deliveries = webhookDeliveryStore.getAll();
  
  if (status) {
    deliveries = deliveries.filter(d => d.status === status);
  }
  
  const total = deliveries.length;
  const paginated = deliveries.slice(Number(offset), Number(offset) + Number(limit));

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
  const { limit = 50 } = req.query;
  
  const items = webhookDeliveryStore.getDeadLetterQueueItems(Number(limit));

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
 * Retry a dead-letter queue item
 */
webhooksRouter.post('/dlq/:dlqId/retry', express.json(), async (req, res) => {
  const { dlqId } = req.params;
  const { secret } = req.body;

  if (!secret) {
    return res.status(400).json({
      error: {
        code: 'MISSING_SECRET',
        message: 'Webhook secret is required',
      },
    });
  }

  try {
    // Get DLQ item
    const dlqItems = webhookDeliveryStore.getDeadLetterQueueItems();
    const dlqItem = dlqItems.find(item => item.id === dlqId);
    
    if (!dlqItem) {
      return res.status(404).json({
        error: {
          code: 'DLQ_ITEM_NOT_FOUND',
          message: `Dead-letter queue item ${dlqId} not found`,
        },
      });
    }

    // Process the DLQ item (remove from DLQ)
    const processed = webhookDeliveryStore.processDeadLetterQueueItem(dlqId);
    
    if (!processed) {
      return res.status(500).json({
        error: {
          code: 'DLQ_PROCESS_ERROR',
          message: 'Failed to process DLQ item',
        },
      });
    }

    // Re-queue the webhook for retry
    const outboxId = webhookDeliveryStore.addToOutbox({
      deliveryId: `retry_${dlqItem.deliveryId}_${Date.now()}`,
      eventId: dlqItem.eventId,
      eventType: dlqItem.eventType,
      endpointUrl: dlqItem.endpointUrl,
      payload: dlqItem.payload,
      secret,
      priority: 'high', // Prioritize retries
      createdAt: Date.now(),
      scheduledFor: Date.now(),
      attempts: 0,
      maxAttempts: 3, // Fewer attempts for retries
    });

    logger.info('DLQ item retried', {
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
    logger.error('Error retrying DLQ item', { dlqId }, {
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
 * List circuit breaker states
 */
webhooksRouter.get('/circuit-breakers', (req, res) => {
  const states = webhookDeliveryStore.getAllCircuitBreakerStates();

  res.json({
    total: states.length,
    states: states.map(state => ({
      endpointUrl: state.endpointUrl,
      state: state.state,
      failureCount: state.failureCount,
      lastFailureTime: state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : null,
      nextAttemptTime: state.nextAttemptTime ? new Date(state.nextAttemptTime).toISOString() : null,
    })),
  });
});

/**
 * POST /api/webhooks/circuit-breakers/:endpointUrl/reset
 * Reset circuit breaker for an endpoint
 */
webhooksRouter.post('/circuit-breakers/:endpointUrl/reset', (req, res) => {
  const { endpointUrl } = req.params;
  
  // URL decode the endpoint URL
  const decodedUrl = decodeURIComponent(endpointUrl);
  
  // This would need to be implemented in the store
  logger.info('Circuit breaker reset requested', { endpointUrl: decodedUrl });

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
  const secret = req.query.secret as string;
  const deliveryId = req.header('x-fluxora-delivery-id');
  const timestamp = req.header('x-fluxora-timestamp');
  const signature = req.header('x-fluxora-signature');

  const result = verifyWebhookSignature({
    secret,
    deliveryId,
    timestamp,
    signature,
    rawBody: req.body,
    isDuplicateDelivery: (id) => webhookService.isDuplicateDelivery(id),
  });

  if (!result.ok) {
    return res.status(result.status).json({
      ok: false,
      code: result.code,
      message: result.message,
    });
  }

  res.json({
    ok: true,
    code: result.code,
    message: result.message,
  });
});

/**
 * POST /internal/webhooks/process-outbox
 * Process outbox items (internal endpoint for background job)
 */
webhooksRouter.post('/process-outbox', express.json(), async (req, res) => {
  const secret = req.query.secret as string;

  if (!secret) {
    logger.warn('Webhook outbox processing endpoint called without secret', undefined);
    return res.status(400).json({
      error: {
        code: 'MISSING_SECRET',
        message: 'Webhook secret is required as query parameter',
      },
    });
  }

  try {
    const readyItems = webhookDeliveryStore.getReadyOutboxItems();
    let processed = 0;
    let errors = 0;

    for (const item of readyItems) {
      try {
        // This would integrate with the webhook service to process the item
        // For now, we'll just log and remove from outbox
        logger.info('Processing outbox item', {
          outboxId: item.id,
          deliveryId: item.deliveryId,
        });
        
        webhookDeliveryStore.removeFromOutbox(item.id);
        processed++;
      } catch (error) {
        logger.error('Error processing outbox item', { outboxId: item.id }, {
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
 */
webhooksRouter.post('/retry', express.json(), async (req, res) => {
  const secret = req.query.secret as string;

  if (!secret) {
    logger.warn('Webhook retry endpoint called without secret', undefined);
    return res.status(400).json({
      error: {
        code: 'MISSING_SECRET',
        message: 'Webhook secret is required as query parameter',
      },
    });
  }

  try {
    await webhookService.processPendingRetries(secret);
    res.json({
      ok: true,
      message: 'Pending webhook retries processed',
    });
  } catch (error) {
    logger.error('Error processing webhook retries', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: {
        code: 'RETRY_PROCESSING_ERROR',
        message: 'Failed to process webhook retries',
      },
    });
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
    
    logger.info('Webhook cleanup completed', {
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
