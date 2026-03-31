/**
 * Webhook delivery and management routes
 */

import express from 'express';
import { webhookService } from '../webhooks/service.js';
import { webhookDeliveryStore } from '../webhooks/store.js';
import { verifyWebhookSignature } from '../webhooks/signature.js';
import { logger } from '../lib/logger.js';

export const webhooksRouter = express.Router();

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
  const deliveries = webhookDeliveryStore.getAll();

  res.json({
    total: deliveries.length,
    deliveries: deliveries.map(delivery => ({
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
