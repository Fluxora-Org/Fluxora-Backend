/**
 * Webhook delivery and management routes
 */

import express from 'express';
import type { Request, Response } from 'express';
import { webhookService } from '../webhooks/service.js';
import { webhookDeliveryStore } from '../webhooks/store.js';
import { verifyWebhookSignature } from '../webhooks/signature.js';
import { logger } from '../lib/logger.js';

export const webhooksRouter = express.Router();

/**
 * GET /deliveries/:deliveryId
 * Get the status of a webhook delivery
 */
webhooksRouter.get('/deliveries/:deliveryId', (req: Request, res: Response): void => {
  const { deliveryId } = req.params;
  const delivery = webhookService.getDeliveryStatus(deliveryId ?? '');

  if (!delivery) {
    res.status(404).json({
      error: { code: 'DELIVERY_NOT_FOUND', message: `Webhook delivery ${deliveryId} not found` },
    });
    return;
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
 * GET /deliveries
 * List all webhook deliveries (for monitoring/debugging)
 */
webhooksRouter.get('/deliveries', (_req: Request, res: Response): void => {
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
 * POST /verify
 * Verify a webhook signature (for consumer testing)
 */
webhooksRouter.post('/verify', express.raw({ type: 'application/json' }), (req: Request, res: Response): void => {
  const secret = req.query['secret'] as string | undefined;
  const deliveryId = req.header('x-fluxora-delivery-id') ?? undefined;
  const timestamp = req.header('x-fluxora-timestamp') ?? undefined;
  const signature = req.header('x-fluxora-signature') ?? undefined;

  const result = verifyWebhookSignature({
    ...(secret !== undefined && { secret }),
    ...(deliveryId !== undefined && { deliveryId }),
    ...(timestamp !== undefined && { timestamp }),
    ...(signature !== undefined && { signature }),
    rawBody: req.body as Buffer,
    isDuplicateDelivery: (id) => webhookService.isDuplicateDelivery(id),
  });

  if (!result.ok) {
    res.status(result.status).json({ ok: false, code: result.code, message: result.message });
    return;
  }

  res.json({ ok: true, code: result.code, message: result.message });
});

/**
 * POST /receive
 *
 * Internal endpoint for verifying the webhook signature contract end-to-end.
 * Reads the raw request body (required for HMAC verification), runs
 * verifyWebhookSignature, and on success echoes the parsed event back so
 * callers can confirm the payload round-trips correctly.
 *
 * Secret is read from FLUXORA_WEBHOOK_SECRET env var.
 * Deduplication is tracked in-process via webhookService.
 */
webhooksRouter.post('/receive', express.raw({ type: '*/*', limit: '256kb' }), (req: Request, res: Response): void => {
  const secret = process.env['FLUXORA_WEBHOOK_SECRET'];
  const deliveryId = req.header('x-fluxora-delivery-id') ?? undefined;
  const timestamp = req.header('x-fluxora-timestamp') ?? undefined;
  const signature = req.header('x-fluxora-signature') ?? undefined;
  const eventType = req.header('x-fluxora-event') ?? undefined;
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const result = verifyWebhookSignature({
    ...(secret !== undefined && { secret }),
    ...(deliveryId !== undefined && { deliveryId }),
    ...(timestamp !== undefined && { timestamp }),
    ...(signature !== undefined && { signature }),
    rawBody,
    isDuplicateDelivery: (id) => webhookService.isDuplicateDelivery(id),
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.code, message: result.message });
    return;
  }

  if (deliveryId) {
    webhookService.registerDeliveryId(deliveryId);
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    return;
  }

  logger.info('Webhook received and verified', undefined, { deliveryId, eventType });
  res.status(200).json({ ok: true, deliveryId, eventType, event });
});

/**
 * POST /retry
 * Process pending webhook retries (internal endpoint for background job)
 */
webhooksRouter.post('/retry', express.json(), async (req: Request, res: Response): Promise<void> => {
  const secret = req.query['secret'] as string | undefined;

  if (!secret) {
    logger.warn('Webhook retry endpoint called without secret', undefined);
    res.status(400).json({
      error: { code: 'MISSING_SECRET', message: 'Webhook secret is required as query parameter' },
    });
    return;
  }

  try {
    await webhookService.processPendingRetries(secret);
    res.json({ ok: true, message: 'Pending webhook retries processed' });
  } catch (error) {
    logger.error('Error processing webhook retries', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'RETRY_PROCESSING_ERROR', message: 'Failed to process webhook retries' },
    });
  }
});
